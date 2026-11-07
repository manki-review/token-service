import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequests, dispatchedEnv, INSTALLATION_ID, oidcToken, OWNER, passInstallationCache, postToken, REPO, REPOSITORY_ID, RUN_CHECK_MINT, stubGitHub } from './helpers';

beforeEach(passInstallationCache);
afterEach(() => {
  vi.useRealTimers();
});

/** The env whose coordinators hold the run each request's OIDC token names. */
const { env } = dispatchedEnv();
const post = (options: Parameters<typeof postToken>[0] = {}) => postToken({ env, ...options });

/** Returns the bodies of the mints for tokens `/token` hands out, after the one it reads the run with. */
async function mintRequestBodies(requests: Request[]): Promise<unknown[]> {
  const mints = apiRequests(requests).filter((request) => request.url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`));
  for (const mint of mints) expect(mint.method).toBe('POST');
  const [check, ...handedOut] = await Promise.all(mints.map((mint) => mint.json()));
  expect(check).toMatchObject({ permissions: RUN_CHECK_MINT.permissions });
  return handedOut;
}

async function mintRequestBody(requests: Request[]): Promise<unknown> {
  const [body] = await mintRequestBodies(requests);
  return body;
}

const SCOPE = { repository_ids: [REPOSITORY_ID] };

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

    expect((await post()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' },
      ...SCOPE,
    });
  });

  it('caps `actions` and the other read-only permissions at read, `checks` at write', async () => {
    const requests = stubGitHub({
      installation: {
        body: {
          id: INSTALLATION_ID,
          permissions: { actions: 'write', checks: 'admin', metadata: 'read', security_events: 'write' },
        },
      },
    });

    expect((await post()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { actions: 'read', checks: 'write', metadata: 'read', security_events: 'read' },
      ...SCOPE,
    });
  });

  it('keeps a level the installation grants below the cap', async () => {
    const requests = stubGitHub({
      installation: {
        body: {
          id: INSTALLATION_ID,
          permissions: { checks: 'read', contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' },
        },
      },
    });

    expect((await post()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { checks: 'read', contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' },
      ...SCOPE,
    });
  });

  it('caps an `admin` level at the cap', async () => {
    const requests = stubGitHub({
      installation: { body: { id: INSTALLATION_ID, permissions: { contents: 'admin', metadata: 'read', pull_requests: 'admin' } } },
    });

    expect((await post()).status).toBe(200);
    expect(await mintRequestBody(requests)).toEqual({
      permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
      ...SCOPE,
    });
  });

  it.each([
    ['wider repositories', { repository_ids: [1, 2], repositories: ['other'], repository: 'other' }],
    ['wider permissions', { permissions: { administration: 'write', contents: 'write' }, contents: 'write' }],
    ['a memory token', { memory: true, memory_repo: 'manki', repositories: ['review-memory'] }],
  ])('ignores a body that asks for %s', async (_case, extra) => {
    const requests = stubGitHub();
    expect((await post({ body: { owner: OWNER, repo: REPO, ...extra } })).status).toBe(200);
    expect(await mintRequestBodies(requests)).toEqual([{
      permissions: { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' },
      ...SCOPE,
    }]);
  });

  it('scopes the review token to the repository_id claim, not the request', async () => {
    const requests = stubGitHub();
    const token = await oidcToken({ claims: { repository_id: '7', other_repository_id: '8' } });
    expect((await post({ token, body: { owner: OWNER, repo: REPO, repository_id: 8 } })).status).toBe(200);
    expect(await mintRequestBody(requests)).toMatchObject({ repository_ids: [7] });
  });

  it('refuses to mint when the installation response has no permissions', async () => {
    const requests = stubGitHub({ installation: { body: { id: INSTALLATION_ID } } });

    const response = await post();
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

    const response = await post();
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

    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z', permissions: reported });
  });
});
