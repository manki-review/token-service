import { decodeProtectedHeader, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_JWT_REUSE_MS, createAppJWT, toPkcs8Pem } from '../src/app-jwt';
import worker from '../src/index';
import {
  apiRequests,
  APP_ID,
  appKeys,
  appPrivateKeyPkcs1,
  appPrivateKeyPkcs8,
  DEFAULT_INSTALLATION_PERMISSIONS,
  DISPATCHED_RUN,
  DISPATCHED_RUN_ID,
  freezeClock,
  INSTALLATION_ID,
  JWKS_URL,
  logged,
  OIDC_AUDIENCE,
  OIDC_JWKS,
  oidcToken,
  OWNER,
  OWNER_ID,
  dispatchedEnv,
  passInstallationCache,
  postToken,
  REPO,
  REPOSITORY_ID,
  RUNTIME_ENV,
  stubGitHub,
  TEST_ENV,
} from './helpers';

/** The env whose coordinators hold the run each request's OIDC token names. */
const { env } = dispatchedEnv();
const post = (options: Parameters<typeof postToken>[0] = {}) => postToken({ env, ...options });

const otherKeys = await generateKeyPair('RS256', { extractable: true });

function paths(requests: Request[]): string[] {
  return apiRequests(requests).map((request) => `${request.method} ${new URL(request.url).pathname}`);
}

const APP_CLIENT_ID = 'Iv23liTestClientId';

const LOOKUP = `GET /repos/${OWNER}/${REPO}/installation`;
const MINT = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;
const RUN = `GET /repos/${OWNER}/${REPO}/actions/runs/${DISPATCHED_RUN_ID}`;
/** The requests of a `/token` that checks its run and mints the review token. */
const CHECKED = [LOOKUP, MINT, RUN, MINT];

/** The `token_minted` lines of the tokens `/token` hands out, leaving out the one it reads the run with. */
const handedOut = () => logged(log, 'token_minted').filter((line) => line.purpose !== 'run_check');

/** Stubs GitHub so the mint of each token `/token` hands out answers with `status`, while the run check's mint works. */
function failMints(status: number): Request[] {
  return stubGitHub({
    api: {
      [MINT]: async (request) => {
        const body = await request.json() as { permissions: Record<string, string> };
        if (body.permissions.actions === 'read' && Object.keys(body.permissions).length === 1) {
          return Response.json({ token: 'ghs_check', expires_at: '2026-11-05T13:00:00Z', permissions: body.permissions }, { status: 201 });
        }
        return Response.json({ message: 'GitHub said no' }, { status });
      },
    },
  });
}

const REVIEW_AUDIT = {
  msg: 'token_minted',
  purpose: 'review',
  repository_id: REPOSITORY_ID,
  repository: `${OWNER}/${REPO}`,
  installation_id: INSTALLATION_ID,
};

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  passInstallationCache();
});

afterEach(() => {
  vi.useRealTimers();
  expect(log.mock.calls.flat().join('\n')).not.toContain('ghs_');
});

/**
 * Checks that `response` names only `error` and a request id, and that the `request_failed` line under that id holds
 * the details, with `detail` among them.
 */
async function expectFailure(response: Response, status: number, error: string, detail: string | RegExp): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json() as { request_id: string };
  expect(body).toEqual({ error, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  const [line] = logged(log, 'request_failed').filter((entry) => entry.request_id === body.request_id);
  expect(line).toMatchObject({ status, error });
  expect(line.detail).toMatch(detail);
}

describe('/token', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an installation token for a verified workflow', async () => {
    const requests = stubGitHub();
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z' });
    expect(paths(requests)).toEqual(CHECKED);
    expect(apiRequests(requests).map((request) => request.redirect)).toEqual(['manual', 'manual', 'manual', 'manual']);
    expect(logged(log, 'token_minted')).toEqual([
      { ...REVIEW_AUDIT, purpose: 'run_check', run_id: undefined, permissions: DEFAULT_INSTALLATION_PERMISSIONS },
      { ...REVIEW_AUDIT, run_id: String(DISPATCHED_RUN_ID), permissions: DEFAULT_INSTALLATION_PERMISSIONS },
    ].map((line) => JSON.parse(JSON.stringify(line))));

    // The installation lookup is reused for a minute, so the next call makes no lookup.
    expect((await post()).status).toBe(200);
    passInstallationCache();
    expect((await post()).status).toBe(200);
    expect(paths(requests)).toEqual([...CHECKED, ...CHECKED.slice(1), ...CHECKED]);
  });

  it('throttles a burst from one account without refusing another account', async () => {
    const requests = stubGitHub();
    const tight = (RUNTIME_ENV as unknown as { TIGHT_RATE_LIMIT: RateLimit }).TIGHT_RATE_LIMIT;
    const { env: throttled } = dispatchedEnv(null, { ...TEST_ENV, ACCOUNT_RATE_LIMIT: tight });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await postToken({ env: throttled })).status);
    // The limit counts per minute, so a burst that crosses into the next minute may pass twice the limit of 3.
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(6);
    expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const state = await postToken({ env: throttled, path: '/state', body: { owner: OWNER, repo: REPO, pr: 7 } });
    expect(state.status).toBe(429);
    // A refused call costs no GitHub request.
    expect(paths(requests).filter((path) => path === RUN)).toHaveLength(statuses.filter((status) => status === 200).length);
    expect(logged(log, 'workflow_request_throttled').at(-1)).toEqual({
      msg: 'workflow_request_throttled', repository: `${OWNER}/${REPO}`, repository_owner_id: String(OWNER_ID),
    });

    const other = await oidcToken({ claims: { repository_owner_id: String(OWNER_ID + 1) } });
    expect((await postToken({ env: throttled, token: other })).status).toBe(200);
  });

  it('encodes the owner and repo into the installation lookup path', async () => {
    const repo = 'x/../../app';
    const lookup = `GET /repos/${OWNER}/${encodeURIComponent(repo)}/installation`;
    const requests = stubGitHub({ api: { [lookup]: { status: 404 } } });
    const response = await post({
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
    const response = await post({ env: { ...env, APP_PRIVATE_KEY: privateKey } });
    expect(response.status).toBe(200);

    // The run is read with an installation token, every other call goes with the App JWT.
    const github = apiRequests(requests).filter((request) => !request.url.includes('/actions/runs/'));
    expect(github).toHaveLength(3);
    for (const request of github) {
      const jwt = request.headers.get('Authorization')!.replace('Bearer ', '');
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'RS256', typ: 'JWT' });
      const { payload } = await jwtVerify(jwt, appKeys.publicKey, { issuer: APP_ID });
      expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
      expect(payload.iat).toBeLessThanOrEqual(before - 59);
      expect(payload.exp! - payload.iat!).toBe(660);
    }
  });

  it.each([
    ['the client ID when one is set', APP_CLIENT_ID, APP_CLIENT_ID],
    ['the App ID when the client ID is empty', '', APP_ID],
    ['the App ID when no client ID is set', undefined, APP_ID],
  ])('signs the App JWT with %s as the issuer', async (_case, clientId, issuer) => {
    const requests = stubGitHub();
    const response = await post({ env: { ...env, APP_CLIENT_ID: clientId } });
    expect(response.status).toBe(200);
    for (const request of apiRequests(requests).filter((request) => !request.url.includes('/actions/runs/'))) {
      const jwt = request.headers.get('Authorization')!.replace('Bearer ', '');
      expect((await jwtVerify(jwt, appKeys.publicKey)).payload.iss).toBe(issuer);
    }
  });

  it('reuses the App JWT for 9 minutes for the same issuer and key', async () => {
    const advance = freezeClock(Date.now() + 2 * APP_JWT_REUSE_MS);
    const pkcs1 = { APP_ID, APP_PRIVATE_KEY: appPrivateKeyPkcs1 };
    const pkcs8 = { APP_ID, APP_PRIVATE_KEY: appPrivateKeyPkcs8 };
    const first = await createAppJWT(pkcs1);
    advance(APP_JWT_REUSE_MS - 1);
    expect(await createAppJWT(pkcs1)).toBe(first);
    expect(await createAppJWT({ ...pkcs1, APP_ID: '654321' })).not.toBe(first);
    expect(await createAppJWT({ ...pkcs1, APP_CLIENT_ID })).not.toBe(first);
    const other = await createAppJWT(pkcs8);
    expect(other).not.toBe(first);
    expect(await createAppJWT(pkcs8)).toBe(other);
    advance(APP_JWT_REUSE_MS);
    const renewed = await createAppJWT(pkcs8);
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
    expect((await post()).status).toBe(200);
    const seen = requests.length;
    expect((await post()).status).toBe(200);
    expect(requests.slice(seen).map((request) => request.url)).not.toContain(JWKS_URL);
  });

  it('answers 503 when GitHub\'s signing keys cannot be fetched, and still refuses a token that is invalid', async () => {
    const MINUTE = 60_000;
    // The key set is kept for 10 minutes, so the clock starts where any set an earlier test fetched is stale.
    const advance = freezeClock(Date.now() + 11 * MINUTE);
    let keys: () => Response | Promise<Response> = () => Response.json(OIDC_JWKS);
    const requests = stubGitHub({ api: { [`GET ${new URL(JWKS_URL).pathname}`]: () => keys() } });
    const keyRequests = () => requests.filter((request) => request.url === JWKS_URL).length;

    for (const [reply, detail] of [
      [() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'KeyFetchError: TimeoutError: The operation was aborted due to timeout'],
      [() => Promise.reject(new TypeError('Network connection lost')), 'KeyFetchError: TypeError: Network connection lost'],
      [() => new Response('busy', { status: 503 }), 'KeyFetchError: Error: the key endpoint answered 503'],
      [() => new Response(null, { status: 302, headers: { Location: 'https://example.com/keys' } }), 'KeyFetchError: Error: the key endpoint answered 302'],
      [() => new Response('<html>Bad gateway</html>'), /^KeyFetchError: SyntaxError: /],
      [() => Response.json({ message: 'no keys here' }), 'JWKSInvalid: JSON Web Key Set malformed'],
    ] as Array<[typeof keys, string | RegExp]>) {
      keys = reply;
      const asked = keyRequests();
      await expectFailure(await post(), 503, 'Signing keys could not be fetched', detail);
      // A failed fetch is not remembered, so each request asks for the keys again.
      expect(keyRequests()).toBe(asked + 1);
    }
    // The other endpoints verify the same way.
    expect((await post({ path: '/state', body: { owner: OWNER, repo: REPO, pr: 7 } })).status).toBe(503);
    // A token that is no JWT is refused without the keys.
    const asked = keyRequests();
    await expectFailure(await post({ token: 'not.a.jwt' }), 403, 'OIDC verification failed', /^JWSInvalid: /);
    expect(keyRequests()).toBe(asked);
    expect(apiRequests(requests)).toEqual([]);

    // Once the keys answer again the same token is accepted.
    keys = () => Response.json(OIDC_JWKS);
    expect((await post()).status).toBe(200);
    expect(keyRequests()).toBe(asked + 1);

    // No matching key right after a fetch is an invalid token: 403, without another fetch.
    const unknownKey = () => oidcToken({ kid: 'rotated-out' });
    await expectFailure(await post({ token: await unknownKey() }), 403, 'OIDC verification failed', /^JWKSNoMatchingKey: /);
    expect(keyRequests()).toBe(asked + 1);
    // Later the set is fetched again for an unknown key. A fetch that fails leaves the token undecided: 503.
    advance(MINUTE);
    keys = () => new Response('busy', { status: 500 });
    await expectFailure(await post({ token: await unknownKey() }), 503, 'Signing keys could not be fetched', 'KeyFetchError: Error: the key endpoint answered 500');
    // A fetch that works and still holds no such key refuses it.
    keys = () => Response.json(OIDC_JWKS);
    await expectFailure(await post({ token: await unknownKey() }), 403, 'OIDC verification failed', /^JWKSNoMatchingKey: /);
    expect(keyRequests()).toBe(asked + 3);

    // A set that is cached and stale is not used when its refresh fails, also for a valid token.
    advance(11 * MINUTE);
    keys = () => new Response('busy', { status: 500 });
    await expectFailure(await post(), 503, 'Signing keys could not be fetched', 'KeyFetchError: Error: the key endpoint answered 500');
    await expectFailure(await post({ token: await oidcToken({ key: otherKeys.privateKey }) }), 503, 'Signing keys could not be fetched', /^KeyFetchError: /);
    keys = () => Response.json(OIDC_JWKS);
    await expectFailure(await post({ token: await oidcToken({ key: otherKeys.privateKey }) }), 403, 'OIDC verification failed', /^JWSSignatureVerificationFailed: /);
  });

  it('answers 503 when the request for the signing keys runs into its timeout', { timeout: 10_000 }, async () => {
    freezeClock(Date.now() + 60 * 60_000);
    // The key endpoint never answers, so the request ends when the timeout of 5 seconds aborts it.
    const hangs = (request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason));
    });
    stubGitHub({ api: { [`GET ${new URL(JWKS_URL).pathname}`]: hangs } });
    const started = performance.now();
    await expectFailure(await post(), 503, 'Signing keys could not be fetched', /^KeyFetchError: TimeoutError: /);
    expect(performance.now() - started).toBeGreaterThan(4000);
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
    const response = await post({ token: null });
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
    const response = await post({ body });
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
    const response = await post({ token: await oidcToken(options) });
    await expectFailure(response, 403, 'OIDC verification failed', /\S/);
    expect(apiRequests(requests)).toEqual([]);
  });

  it('refuses a token for the repository when the body names another', async () => {
    const requests = stubGitHub();
    const response = await post({ body: { owner: OWNER, repo: 'other' } });
    await expectFailure(response, 403, 'OIDC verification failed', `token is for ${OWNER}/${REPO}, requested ${OWNER}/other`);
    expect(apiRequests(requests)).toEqual([]);
  });

  it.each([
    ['a pull_request workflow', { event_name: 'pull_request', ref: 'refs/pull/7/merge', workflow_ref: `${OWNER}/${REPO}/.github/workflows/manki.yml@refs/pull/7/merge` }, 'event pull_request is not workflow_dispatch'],
    ['a workflow of another repository', { workflow_ref: `${OWNER}/other/.github/workflows/manki.yml@refs/heads/main` }, `workflow ${OWNER}/other/.github/workflows/manki.yml@refs/heads/main is not a branch workflow of ${OWNER}/${REPO}`],
    ['a workflow_ref on another ref than the run', { workflow_ref: `${OWNER}/${REPO}/.github/workflows/manki.yml@refs/heads/feature` }, `workflow ${OWNER}/${REPO}/.github/workflows/manki.yml@refs/heads/feature is not a branch workflow of ${OWNER}/${REPO}`],
    ['a tag workflow', { ref: 'refs/tags/v1', workflow_ref: `${OWNER}/${REPO}/.github/workflows/manki.yml@refs/tags/v1` }, `workflow ${OWNER}/${REPO}/.github/workflows/manki.yml@refs/tags/v1 is not a branch workflow of ${OWNER}/${REPO}`],
  ])('refuses %s before reading the run', async (_case, claims, reason) => {
    const requests = stubGitHub();
    const response = await post({ token: await oidcToken({ claims }) });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: { error: `Only the run Manki dispatched gets a token: ${reason}` } });
    expect(paths(requests)).toEqual([LOOKUP]);
    expect(logged(log, 'token_refused')).toMatchObject([{ repository: `${OWNER}/${REPO}`, run_id: String(DISPATCHED_RUN_ID), reason }]);
    expect(handedOut()).toEqual([]);
  });

  it.each([
    ['an unknown run id', { status: 404, body: { message: 'Not Found' } }, `run ${DISPATCHED_RUN_ID} could not be read: 404`],
    ['a run a person dispatched', { body: { ...DISPATCHED_RUN, actor: { login: 'alice' } } }, `run ${DISPATCHED_RUN_ID} is not a run Manki dispatched`],
    ['a run of another event', { body: { ...DISPATCHED_RUN, event: 'push' } }, `run ${DISPATCHED_RUN_ID} is not a run Manki dispatched`],
    ['a run without a Manki run title', { body: { ...DISPATCHED_RUN, display_title: 'Deploy' } }, `run ${DISPATCHED_RUN_ID} is not a run Manki dispatched`],
  ])('refuses %s', async (_case, run, reason) => {
    stubGitHub({ run });
    const response = await post();
    expect(response.status).toBe(403);
    expect(logged(log, 'token_refused')).toMatchObject([{ reason }]);
    expect(handedOut()).toEqual([]);
  });

  it.each([
    ['a 502', { status: 502, body: { message: 'Bad gateway' } }],
    ['a rate limit', { status: 403, body: { message: 'API rate limit exceeded for installation' } }],
  ])('answers 500, not a refusal, when reading the run fails with %s', async (_case, run) => {
    stubGitHub({ run });
    const response = await post();
    expect(response.status).toBe(500);
    expect(logged(log, 'token_refused')).toEqual([]);
    expect(handedOut()).toEqual([]);
  });

  it('asks the coordinator its run title names, and refuses when it does not hold the run', async () => {
    stubGitHub();
    const { env: refusing, checks } = dispatchedEnv('run 9000 is not of manki.yml');
    const token = await oidcToken({ claims: { workflow_ref: `${OWNER}/${REPO}/.github/workflows/deploy.yml@refs/heads/main` } });
    const response = await postToken({ env: refusing, token, body: { owner: OWNER, repo: REPO } });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403, body: { error: 'Only the run Manki dispatched gets a token: run 9000 is not of manki.yml' },
    });
    expect(checks).toEqual([[`${REPOSITORY_ID}:7`, DISPATCHED_RUN_ID, 'd-7', 'deploy.yml', 'refs/heads/main']]);
    expect(handedOut()).toEqual([]);
  });

  it('returns 404 when the App is not installed on the repository', async () => {
    const requests = stubGitHub({ installation: { status: 404, body: { message: 'Not Found' } } });
    const response = await post();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'App not installed on this repository' });
    // The missing installation is reused too, and `/state` refuses the repository before it reaches a coordinator.
    expect((await post()).status).toBe(404);
    const state = await post({ path: '/state', body: { owner: OWNER, repo: REPO, pr: 7 } });
    expect(state.status).toBe(404);
    expect(paths(requests)).toEqual([LOOKUP]);
  });

  it('looks the installation up again after GitHub failed to answer', async () => {
    const requests = stubGitHub({ installation: { status: 502, body: { message: 'Bad gateway' } } });
    const response = await post();
    await expectFailure(response, 500, 'Installation lookup failed', 'installation lookup failed with 502');
    expect((await post()).status).toBe(500);
    expect(paths(requests)).toEqual([LOOKUP, LOOKUP]);
  });

  it.each([403, 422, 500, 502])('passes the status of a %i from the token mint through without its body', async (status) => {
    failMints(status);
    const response = await post();
    await expectFailure(response, status, 'Token mint failed', '{"message":"GitHub said no"}');
    expect(handedOut()).toEqual([]);
  });

  it('returns 500 when the App key cannot be read', async () => {
    const requests = stubGitHub();
    const response = await post({ env: { ...env, APP_PRIVATE_KEY: 'not a key' } });
    await expectFailure(response, 500, 'Installation lookup failed', /\S/);
    expect(apiRequests(requests)).toEqual([]);
  });
});

describe('/token memory', () => {
  it('mints no memory token, even when the body asks for one', async () => {
    const requests = stubGitHub();
    const response = await post({ body: { owner: OWNER, repo: REPO, memory: true } });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json() as object).sort()).toEqual(['expires_at', 'permissions', 'token']);
    expect(paths(requests)).toEqual(CHECKED);
    expect(handedOut().map((line) => line.purpose)).toEqual(['review']);
  });
});
