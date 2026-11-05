import { describe, expect, it } from 'vitest';
import { apiRequests, INSTALLATION_ID, postToken, stubGitHub } from './helpers';

async function mintRequestBody(requests: Request[]): Promise<unknown> {
  const mint = apiRequests(requests).find((request) => request.url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`));
  expect(mint?.method).toBe('POST');
  return mint!.json();
}

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
      permissions: { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' },
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
    });
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
