import { decodeProtectedHeader, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { toPkcs8Pem } from '../src/app-jwt';
import worker from '../src/index';
import {
  apiRequests,
  APP_ID,
  appKeys,
  appPrivateKeyPkcs1,
  appPrivateKeyPkcs8,
  INSTALLATION_ID,
  JWKS_URL,
  OIDC_AUDIENCE,
  oidcToken,
  OWNER,
  postToken,
  REPO,
  stubGitHub,
  TEST_ENV,
} from './helpers';

const otherKeys = await generateKeyPair('RS256', { extractable: true });

function paths(requests: Request[]): string[] {
  return apiRequests(requests).map((request) => `${request.method} ${new URL(request.url).pathname}`);
}

const LOOKUP = `GET /repos/${OWNER}/${REPO}/installation`;
const MINT = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;

describe('/token', () => {
  it('returns an installation token for a verified workflow', async () => {
    const requests = stubGitHub();
    const response = await postToken();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z' });
    expect(paths(requests)).toEqual([LOOKUP, MINT]);
  });

  it.each([
    ['PKCS#1', appPrivateKeyPkcs1],
    ['PKCS#8', appPrivateKeyPkcs8],
    ['PKCS#8 under an RSA label', appPrivateKeyPkcs8.replace(/(BEGIN|END) PRIVATE KEY/g, '$1 RSA PRIVATE KEY')],
  ])('signs the App JWT with a %s key', async (_format, privateKey) => {
    const requests = stubGitHub();
    const before = Math.floor(Date.now() / 1000);
    const response = await postToken({ env: { APP_ID, APP_PRIVATE_KEY: privateKey } });
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
    const response = await postToken({ env: { APP_ID, APP_PRIVATE_KEY: 'not a key' } });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toMatch(/^Token generation failed/);
    expect(apiRequests(requests)).toEqual([]);
  });
});
