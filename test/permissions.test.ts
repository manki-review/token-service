import { describe, expect, it } from 'vitest';
import { apiRequests, INSTALLATION_ID, oidcToken, OWNER, postToken, REPO, REPOSITORY_ID, stubGitHub } from './helpers';

async function mintRequestBodies(requests: Request[]): Promise<unknown[]> {
  const mints = apiRequests(requests).filter((request) => request.url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`));
  for (const mint of mints) expect(mint.method).toBe('POST');
  return Promise.all(mints.map((mint) => mint.json()));
}

async function mintRequestBody(requests: Request[]): Promise<unknown> {
  const [body] = await mintRequestBodies(requests);
  return body;
}

const SCOPE = { repository_ids: [REPOSITORY_ID] };
const MEMORY_MINT = { permissions: { contents: 'write' }, repositories: ['review-memory'] };

describe('/token permissions', () => {
  it('requests only the permissions Manki uses', async () => {
    const requests = stubGitHub({
      installation: {
        body: {
          id: INSTALLATION_ID,
          permissions: {
            administration: 'write',
            contents: 'write',
            issues: 'write',
            members: 'read',
            metadata: 'read',
            pull_requests: 'write',
            workflows: 'write',
          },
        },
      },
    });

    expect((await postToken()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { contents: 'read', issues: 'write', metadata: 'read', pull_requests: 'write' },
      ...SCOPE,
    });
  });

  it('caps `actions` and the other read-only permissions at read', async () => {
    const requests = stubGitHub({
      installation: {
        body: {
          id: INSTALLATION_ID,
          permissions: { actions: 'write', checks: 'write', metadata: 'read', security_events: 'write' },
        },
      },
    });

    expect((await postToken()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { actions: 'read', checks: 'read', metadata: 'read', security_events: 'read' },
      ...SCOPE,
    });
  });

  it('keeps a level the installation grants below the cap', async () => {
    const requests = stubGitHub({
      installation: {
        body: { id: INSTALLATION_ID, permissions: { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' } },
      },
    });

    expect((await postToken()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' },
      ...SCOPE,
    });
  });

  it('caps an `admin` level at the cap', async () => {
    const requests = stubGitHub({
      installation: { body: { id: INSTALLATION_ID, permissions: { contents: 'admin', metadata: 'read', pull_requests: 'admin' } } },
    });

    expect((await postToken()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { contents: 'read', metadata: 'read', pull_requests: 'write' },
      ...SCOPE,
    });
  });

  it.each([
    ['wider repositories', { repository_ids: [1, 2], repositories: ['other'], repository: 'other' }],
    ['wider permissions', { permissions: { administration: 'write', contents: 'write' }, contents: 'write' }],
    ['another memory repo', { memory: true, memory_repo: 'manki', memory_repository: `${OWNER}/manki`, repositories: ['manki'] }],
  ])('ignores a body that asks for %s', async (_case, extra) => {
    const requests = stubGitHub();
    expect((await postToken({ body: { owner: OWNER, repo: REPO, ...extra } })).status).toBe(200);
    const [review, ...memory] = await mintRequestBodies(requests);
    expect(review).toEqual({
      permissions: { contents: 'read', issues: 'write', metadata: 'read', pull_requests: 'write' },
      ...SCOPE,
    });
    expect(memory).toEqual('memory' in extra ? [MEMORY_MINT] : []);
  });

  it('scopes the review token to the repository_id claim, not the request', async () => {
    const requests = stubGitHub();
    const token = await oidcToken({ claims: { repository_id: '7', other_repository_id: '8' } });
    expect((await postToken({ token, body: { owner: OWNER, repo: REPO, repository_id: 8 } })).status).toBe(200);
    expect(await mintRequestBody(requests)).toMatchObject({ repository_ids: [7] });
  });

  it('requests only `contents: write` on `review-memory` for the memory token', async () => {
    const requests = stubGitHub({
      installation: {
        body: { id: INSTALLATION_ID, permissions: { administration: 'write', contents: 'admin', issues: 'write', metadata: 'read', workflows: 'write' } },
      },
    });

    expect((await postToken({ body: { owner: OWNER, repo: REPO, memory: true } })).status).toBe(200);
    expect((await mintRequestBodies(requests))[1]).toEqual(MEMORY_MINT);
  });

  it('keeps the memory token at read when the installation only reads contents', async () => {
    const requests = stubGitHub({
      installation: { body: { id: INSTALLATION_ID, permissions: { contents: 'read', metadata: 'read', pull_requests: 'write' } } },
    });

    expect((await postToken({ body: { owner: OWNER, repo: REPO, memory: true } })).status).toBe(200);
    expect((await mintRequestBodies(requests))[1]).toEqual({ permissions: { contents: 'read' }, repositories: ['review-memory'] });
  });

  it('refuses to mint when the installation response has no permissions', async () => {
    const requests = stubGitHub({ installation: { body: { id: INSTALLATION_ID } } });

    const response = await postToken();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'App installation grants none of the permissions Manki needs' });
    expect(apiRequests(requests).map((request) => new URL(request.url).pathname)).toEqual([
      '/repos/manki-review/manki/installation',
    ]);
  });

  it('refuses to mint when the installation grants nothing Manki uses', async () => {
    const requests = stubGitHub({
      installation: { body: { id: INSTALLATION_ID, permissions: { administration: 'write' } } },
    });

    const response = await postToken();
    expect(response.status).toBe(403);
    expect(apiRequests(requests).map((request) => new URL(request.url).pathname)).toEqual([
      '/repos/manki-review/manki/installation',
    ]);
  });

  it('returns the permissions GitHub reports for the token unchanged', async () => {
    const reported = { issues: 'write', metadata: 'read', pull_requests: 'read' };
    stubGitHub({
      accessToken: { status: 201, body: { token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z', permissions: reported } },
    });

    const response = await postToken();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z', permissions: reported });
  });
});
