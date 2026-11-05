import { decodeProtectedHeader, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_JWT_REUSE_MS, createAppJWT, toPkcs8Pem } from '../src/app-jwt';
import worker from '../src/index';
import {
  apiRequests,
  APP_ID,
  appKeys,
  appPrivateKeyPkcs1,
  appPrivateKeyPkcs8,
  freezeClock,
  INSTALLATION_ID,
  JWKS_URL,
  OIDC_AUDIENCE,
  oidcToken,
  OWNER,
  postToken,
  REPO,
  stubGitHub,
  TEST_ENV,
  type StubReply,
} from './helpers';

const otherKeys = await generateKeyPair('RS256', { extractable: true });

function paths(requests: Request[]): string[] {
  return apiRequests(requests).map((request) => `${request.method} ${new URL(request.url).pathname}`);
}

const LOOKUP = `GET /repos/${OWNER}/${REPO}/installation`;
const MINT = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;

const MEMORY_TOKEN = { token: 'ghs_memory', expires_at: '2026-11-05T13:30:00Z', permissions: { contents: 'write', metadata: 'read' } };

/** Stubs GitHub so the review mint returns `ghs_test` and the mint for named repositories answers with `memory`. */
function stubMemoryMint(memory: StubReply = {}): Request[] {
  return stubGitHub({
    api: {
      [MINT]: async (request) => {
        const body = await request.json() as { repositories?: string[] };
        if (!body.repositories) {
          return Response.json({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z', permissions: {} }, { status: 201 });
        }
        return Response.json(memory.body ?? MEMORY_TOKEN, { status: memory.status ?? 201 });
      },
    },
  });
}

describe('/token', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an installation token for a verified workflow', async () => {
    const requests = stubGitHub();
    const response = await postToken();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z' });
    expect(paths(requests)).toEqual([LOOKUP, MINT]);
    expect(apiRequests(requests).map((request) => request.redirect)).toEqual(['manual', 'manual']);
  });

  it('encodes the owner and repo into the installation lookup path', async () => {
    const repo = 'x/../../app';
    const lookup = `GET /repos/${OWNER}/${encodeURIComponent(repo)}/installation`;
    const requests = stubGitHub({ api: { [lookup]: { status: 404 } } });
    const response = await postToken({
      token: await oidcToken({ claims: { repository: `${OWNER}/${repo}` } }),
      body: { owner: OWNER, repo },
    });
    expect(response.status).toBe(404);
    expect(paths(requests)).toEqual([lookup]);
  });

  it.each([
    ['PKCS#1', appPrivateKeyPkcs1],
    ['PKCS#8', appPrivateKeyPkcs8],
    ['PKCS#8 under an RSA label', appPrivateKeyPkcs8.replace(/(BEGIN|END) PRIVATE KEY/g, '$1 RSA PRIVATE KEY')],
  ])('signs the App JWT with a %s key', async (_format, privateKey) => {
    // Past the reuse window of any JWT an earlier test signed, so this one is signed now.
    freezeClock(Date.now() + APP_JWT_REUSE_MS);
    const requests = stubGitHub();
    const before = Math.floor(Date.now() / 1000);
    const response = await postToken({ env: { ...TEST_ENV, APP_PRIVATE_KEY: privateKey } });
    expect(response.status).toBe(200);

    const github = apiRequests(requests);
    expect(github).toHaveLength(2);
    for (const request of github) {
      const jwt = request.headers.get('Authorization')!.replace('Bearer ', '');
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'RS256', typ: 'JWT' });
      const { payload } = await jwtVerify(jwt, appKeys.publicKey, { issuer: APP_ID });
      expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
      expect(payload.iat).toBeLessThanOrEqual(before - 59);
      expect(payload.exp! - payload.iat!).toBe(660);
    }
  });

  it('reuses the App JWT for 9 minutes for the same App and key', async () => {
    const advance = freezeClock(Date.now() + 2 * APP_JWT_REUSE_MS);
    const first = await createAppJWT(APP_ID, appPrivateKeyPkcs1);
    advance(APP_JWT_REUSE_MS - 1);
    expect(await createAppJWT(APP_ID, appPrivateKeyPkcs1)).toBe(first);
    expect(await createAppJWT('654321', appPrivateKeyPkcs1)).not.toBe(first);
    const other = await createAppJWT(APP_ID, appPrivateKeyPkcs8);
    expect(other).not.toBe(first);
    expect(await createAppJWT(APP_ID, appPrivateKeyPkcs8)).toBe(other);
    advance(APP_JWT_REUSE_MS);
    const renewed = await createAppJWT(APP_ID, appPrivateKeyPkcs8);
    expect(renewed).not.toBe(other);
    const { payload } = await jwtVerify(renewed, appKeys.publicKey, { issuer: APP_ID });
    expect(payload.iat).toBe(Math.floor(Date.now() / 1000) - 60);
  });

  it('wraps a PKCS#1 App key into the matching PKCS#8 key', () => {
    // workerd also accepts a raw PKCS#1 key as PKCS#8, so a signed JWT alone does not prove the conversion.
    const body = (pem: string) => pem.replace(/-----[A-Z ]+-----|\s/g, '');
    expect(body(toPkcs8Pem(appPrivateKeyPkcs1))).toBe(body(appPrivateKeyPkcs8));
    expect(body(toPkcs8Pem(appPrivateKeyPkcs8))).toBe(body(appPrivateKeyPkcs8));
  });

  it('reuses the cached OIDC key set on later requests', async () => {
    const requests = stubGitHub();
    expect((await postToken()).status).toBe(200);
    const seen = requests.length;
    expect((await postToken()).status).toBe(200);
    expect(requests.slice(seen).map((request) => request.url)).not.toContain(JWKS_URL);
  });

  it('rejects requests that are not a POST to /token', async () => {
    const requests = stubGitHub();
    const url = `https://${OIDC_AUDIENCE}`;
    expect((await worker.fetch(new Request(`${url}/token`, { method: 'OPTIONS' }), TEST_ENV)).status).toBe(204);
    expect((await worker.fetch(new Request(`${url}/token`), TEST_ENV)).status).toBe(405);
    expect((await worker.fetch(new Request(`${url}/other`, { method: 'POST' }), TEST_ENV)).status).toBe(404);
    expect(requests).toEqual([]);
  });

  it('requires a bearer token', async () => {
    const requests = stubGitHub();
    const response = await postToken({ token: null });
    expect(response.status).toBe(401);
    expect(requests).toEqual([]);
  });

  it.each([
    ['an invalid JSON body', 'not json'],
    ['a body without a repo', { owner: OWNER }],
    ['a body without an owner', { repo: REPO }],
    ['a null body', 'null'],
    ['a body that is a string', '"manki"'],
    ['a body with a numeric owner', { owner: 1, repo: REPO }],
    ['a body with an empty repo', { owner: OWNER, repo: '' }],
    ['a body with a string memory flag', { owner: OWNER, repo: REPO, memory: 'true' }],
  ])('rejects %s', async (_case, body) => {
    const requests = stubGitHub();
    const response = await postToken({ body });
    expect(response.status).toBe(400);
    expect(apiRequests(requests)).toEqual([]);
  });

  it.each([
    ['a token signed by another key', { key: otherKeys.privateKey }],
    ['a token from another issuer', { issuer: 'https://example.com' }],
    ['a token for another audience', { audience: 'example.com' }],
    ['an expired token', { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
    ['a token for another repository', { claims: { repository: `${OWNER}/other` } }],
    ['a token without an expiry', { omit: ['exp'] as Array<'exp' | 'iat'> }],
    ['a token without an issue time', { omit: ['iat'] as Array<'exp' | 'iat'> }],
    ['a token without a repository claim', { claims: { repository: undefined } }],
    ['a token without a repository_id claim', { claims: { repository_id: undefined } }],
    ['a token without a repository_owner_id claim', { claims: { repository_owner_id: undefined } }],
    ['a token with a numeric repository_id claim', { claims: { repository_id: 424242 } }],
    ['a token with a non-numeric repository_id claim', { claims: { repository_id: '42,43' } }],
    ['a token with a zero repository_id claim', { claims: { repository_id: '0' } }],
    ['a token with a non-numeric repository_owner_id claim', { claims: { repository_owner_id: 'manki-review' } }],
    ['a token issued more than 10 minutes ago', { issuedAt: Math.floor(Date.now() / 1000) - 11 * 60 }],
  ])('refuses %s', async (_case, options) => {
    const requests = stubGitHub();
    const response = await postToken({ token: await oidcToken(options) });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/^OIDC verification failed/);
    expect(apiRequests(requests)).toEqual([]);
  });

  it('refuses a token for the repository when the body names another', async () => {
    const requests = stubGitHub();
    const response = await postToken({ body: { owner: OWNER, repo: 'other' } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(`token is for ${OWNER}/${REPO}, requested ${OWNER}/other`);
    expect(apiRequests(requests)).toEqual([]);
  });

  it('returns 404 when the App is not installed on the repository', async () => {
    const requests = stubGitHub({ installation: { status: 404, body: { message: 'Not Found' } } });
    const response = await postToken();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'App not installed on this repository' });
    expect(paths(requests)).toEqual([LOOKUP]);
  });

  it.each([403, 422, 500, 502])('passes a %i from the token mint through', async (status) => {
    stubGitHub({ accessToken: { status, body: { message: 'GitHub said no' } } });
    const response = await postToken();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: `GitHub API error: ${status}`, details: '{"message":"GitHub said no"}' });
  });

  it('returns 500 when the App key cannot be read', async () => {
    const requests = stubGitHub();
    const response = await postToken({ env: { ...TEST_ENV, APP_PRIVATE_KEY: 'not a key' } });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toMatch(/^Token generation failed/);
    expect(apiRequests(requests)).toEqual([]);
  });
});

describe('/token memory token', () => {
  it('mints no memory token unless the request asks for one', async () => {
    const requests = stubMemoryMint();
    const response = await postToken();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('memory_token');
    expect(body).not.toHaveProperty('memory_expires_at');
    expect(paths(requests)).toEqual([LOOKUP, MINT]);
  });

  it('returns a memory token next to the review token', async () => {
    const requests = stubMemoryMint();
    const response = await postToken({ body: { owner: OWNER, repo: REPO, memory: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'ghs_test',
      expires_at: '2026-11-05T13:00:00Z',
      permissions: {},
      memory_token: 'ghs_memory',
      memory_expires_at: '2026-11-05T13:30:00Z',
    });
    expect(paths(requests)).toEqual([LOOKUP, MINT, MINT]);
  });

  it.each([403, 404, 422, 500])('returns the review token without a memory token when GitHub answers the memory mint with %i', async (status) => {
    stubMemoryMint({ status, body: { message: 'There is at least one repository that does not exist or is not accessible' } });
    const response = await postToken({ body: { owner: OWNER, repo: REPO, memory: true } });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.token).toBe('ghs_test');
    expect(body).not.toHaveProperty('memory_token');
    expect(body).not.toHaveProperty('memory_expires_at');
  });

  it('skips the memory mint when the installation grants no contents', async () => {
    const requests = stubGitHub({
      installation: { body: { id: INSTALLATION_ID, permissions: { issues: 'write', metadata: 'read', pull_requests: 'write' } } },
    });
    const response = await postToken({ body: { owner: OWNER, repo: REPO, memory: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('memory_token');
    expect(paths(requests)).toEqual([LOOKUP, MINT]);
  });

  it('mints no memory token when the review mint fails', async () => {
    const requests = stubGitHub({ accessToken: { status: 422, body: { message: 'GitHub said no' } } });
    const response = await postToken({ body: { owner: OWNER, repo: REPO, memory: true } });
    expect(response.status).toBe(422);
    expect(paths(requests)).toEqual([LOOKUP, MINT]);
  });
});
