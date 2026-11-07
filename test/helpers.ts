import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import type { PrCoordinator, WorkRow } from '../src/coordinator';
import type { Env } from '../src/env';
import { INSTALLATION_CACHE_MS } from '../src/github';
import worker from '../src/index';

export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const OIDC_AUDIENCE = 'manki-api.dustinface.me';
export const JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
export const APP_ID = '123456';
export const INSTALLATION_ID = 987;
export const OWNER = 'manki-review';
export const REPO = 'manki';
export const REPOSITORY_ID = 424242;
export const OWNER_ID = 7070;

const OIDC_KID = 'test-oidc-key';

/** The run id the OIDC tokens of `oidcToken` name unless a test gives another. */
export const DISPATCHED_RUN_ID = 9000;

/** Run `DISPATCHED_RUN_ID` as GitHub shows it: a dispatch by the App for PR 7. */
export const DISPATCHED_RUN = {
  id: DISPATCHED_RUN_ID,
  event: 'workflow_dispatch',
  display_title: 'Manki pull_request.synchronize on #7 (d-7)',
  actor: { login: 'manki-review[bot]' },
};

/** The mint `/token` makes to read the requesting run, before any token it returns. */
export const RUN_CHECK_MINT = { permissions: { actions: 'read' }, repository_ids: [REPOSITORY_ID] };

export const oidcKeys = await generateKeyPair('RS256', { extractable: true });
export const appKeys = await generateKeyPair('RS256', { extractable: true });
export const appPrivateKeyPkcs8 = await exportPKCS8(appKeys.privateKey);
export const appPrivateKeyPkcs1 = pkcs1Pem(appPrivateKeyPkcs8);

const oidcJwk = { ...(await exportJWK(oidcKeys.publicKey)), kid: OIDC_KID, alg: 'RS256', use: 'sig' };
/** The reply to `JWKS_URL`, which holds the key `oidcToken` signs with. */
export const OIDC_JWKS = { keys: [oidcJwk] };

export const WEBHOOK_SECRET = 'test-webhook-secret';

/** The runtime env from `vitest.config.ts`, which holds the bindings and the secrets the Durable Objects see. */
export const RUNTIME_ENV = env as unknown as Env;

export const TEST_ENV: Env = { ...RUNTIME_ENV, APP_ID, APP_PRIVATE_KEY: appPrivateKeyPkcs1, WEBHOOK_SECRET };

/**
 * Pins `Date` to a fixed time far ahead of the real clock. An alarm set for "now" then lies in the real future, so it
 * runs only when a test calls `runDurableObjectAlarm`. Returns a function that moves the clock forward.
 */
export function freezeClock(start = Date.UTC(2030, 0, 1)): (ms: number) => number {
  vi.useFakeTimers({ toFake: ['Date'] });
  let now = start;
  vi.setSystemTime(now);
  return (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
    return now;
  };
}

let uncachedClock = Date.now();

/**
 * Freezes the clock past every installation lookup an earlier test cached, so the next request looks up the installation
 * its test stubs.
 */
export function passInstallationCache(): void {
  uncachedClock += INSTALLATION_CACHE_MS;
  freezeClock(uncachedClock);
}

function derLengthSize(der: Uint8Array, offset: number): number {
  return der[offset] & 0x80 ? 1 + (der[offset] & 0x7f) : 1;
}

/** Returns the PKCS#1 PEM, the format GitHub issues App keys in, taken from the `OCTET STRING` of a PKCS#8 PEM. */
function pkcs1Pem(pkcs8: string): string {
  const der = Uint8Array.from(atob(pkcs8.replace(/-----[A-Z ]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const versionAndAlgorithmSize = 3 + 15;
  let offset = 1 + derLengthSize(der, 1) + versionAndAlgorithmSize;
  if (der[offset] !== 0x04) throw new Error('Unexpected PKCS#8 layout');
  offset += 1 + derLengthSize(der, offset + 1);
  return `-----BEGIN RSA PRIVATE KEY-----\n${btoa(String.fromCharCode(...der.slice(offset)))}\n-----END RSA PRIVATE KEY-----\n`;
}

export interface OidcTokenOptions {
  claims?: JWTPayload;
  issuer?: string;
  audience?: string;
  key?: CryptoKey;
  expiresIn?: string | number;
  /** The `iat` claim. A missing value means now. */
  issuedAt?: number;
  /** Registered claims to leave out of the token. */
  omit?: Array<'exp' | 'iat'>;
}

/** Returns a GitHub Actions OIDC token for `OWNER/REPO`, signed with the key `stubGitHub` serves as the JWKS. */
export async function oidcToken(options: OidcTokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    repository: `${OWNER}/${REPO}`,
    repository_owner: OWNER,
    repository_id: String(REPOSITORY_ID),
    repository_owner_id: String(OWNER_ID),
    run_id: String(DISPATCHED_RUN_ID),
    event_name: 'workflow_dispatch',
    workflow_ref: `${OWNER}/${REPO}/.github/workflows/manki.yml@refs/heads/main`,
    ref: 'refs/heads/main',
    ...options.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: OIDC_KID })
    .setIssuer(options.issuer ?? OIDC_ISSUER)
    .setAudience(options.audience ?? OIDC_AUDIENCE);
  if (!options.omit?.includes('iat')) jwt.setIssuedAt(options.issuedAt);
  if (!options.omit?.includes('exp')) jwt.setExpirationTime(options.expiresIn ?? '5m');
  return jwt.sign(options.key ?? oidcKeys.privateKey);
}

export const DEFAULT_INSTALLATION_PERMISSIONS = {
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
};

export interface StubReply {
  status?: number;
  body?: unknown;
}

export interface GitHubStub {
  installation?: StubReply;
  accessToken?: StubReply;
  /** The reply to `GET /repositories/<id>`. */
  repository?: StubReply;
  /** The reply to reading run `DISPATCHED_RUN_ID`. */
  run?: StubReply;
  /** Each login's permission on the repository. Anyone else reads as `read`. */
  permissions?: Record<string, string>;
  /**
   * Replies keyed by `<METHOD> <path>`, such as `POST /graphql`. They take precedence over the defaults. A function
   * runs in the caller's context, so it can read a request body sent from inside a Durable Object.
   */
  api?: Record<string, StubReply | ((request: Request) => Response | Promise<Response>)>;
}

function reply(stub: StubReply | undefined, fallback: unknown): Response {
  return Response.json(stub?.body ?? fallback, { status: stub?.status ?? 200 });
}

/** Replaces `fetch` with a fake GitHub that serves the OIDC JWKS, the installation lookup and the token mint. */
export function stubGitHub(stub: GitHubStub = {}): Request[] {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    const handler = stub.api?.[`${request.method} ${url.pathname}`];
    if (typeof handler === 'function') return handler(request);
    if (handler) return reply(handler, {});
    if (request.url === JWKS_URL) {
      return Response.json(OIDC_JWKS);
    }
    if (/^\/repositories\/[0-9]+$/.test(url.pathname)) {
      return reply(stub.repository, { name: REPO, owner: { login: OWNER, id: OWNER_ID }, default_branch: 'main' });
    }
    if (url.pathname === `/repos/${OWNER}/${REPO}/actions/runs/${DISPATCHED_RUN_ID}`) return reply(stub.run, DISPATCHED_RUN);
    const permission = new RegExp(`^/repos/${OWNER}/${REPO}/collaborators/([^/]+)/permission$`).exec(url.pathname);
    if (permission) return Response.json({ permission: stub.permissions?.[decodeURIComponent(permission[1])] ?? 'read' });
    if (url.pathname === `/repos/${OWNER}/${REPO}/installation`) {
      return reply(stub.installation, { id: INSTALLATION_ID, permissions: DEFAULT_INSTALLATION_PERMISSIONS });
    }
    if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return reply(stub.accessToken, {
        token: 'ghs_test',
        expires_at: '2026-11-05T13:00:00Z',
        permissions: DEFAULT_INSTALLATION_PERMISSIONS,
      });
    }
    throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
  });
  return requests;
}

/** Returns the JSON lines logged to `spy`, only those whose `msg` is `msg` when one is given. */
export function logged(spy: { mock: { calls: unknown[][] } }, msg?: string): Record<string, unknown>[] {
  const lines = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
  return msg === undefined ? lines : lines.filter((line) => line.msg === msg);
}

/** Returns the requests `stubGitHub` saw for the GitHub REST API, leaving out the JWKS fetch. */
export function apiRequests(requests: Request[]): Request[] {
  return requests.filter((request) => request.url.startsWith('https://api.github.com/'));
}

export interface PostTokenOptions {
  /** The endpoint, `/token` when left out. */
  path?: string;
  token?: string | null;
  body?: unknown;
  env?: Env;
}

/** Sends a request to an OIDC endpoint of the Worker, `/token` by default. A missing `token` means a fresh valid OIDC token. */
export async function postToken(options: PostTokenOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = options.token === undefined ? await oidcToken() : options.token;
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? { owner: OWNER, repo: REPO });
  const request = new Request(`https://${OIDC_AUDIENCE}${options.path ?? '/token'}`, { method: 'POST', headers, body });
  return worker.fetch(request, options.env ?? TEST_ENV);
}

/** Returns the `X-Hub-Signature-256` header GitHub sends for `body` under `secret`. */
export async function signWebhook(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

export interface PostWebhookOptions {
  event?: string | null;
  payload?: unknown;
  /** The raw body, when it must differ from the JSON of `payload`. */
  body?: string;
  /** A missing value means a fresh delivery id, `null` no header. */
  delivery?: string | null;
  /** The `X-Hub-Signature-256` header. A missing value means the correct signature, `null` no header. */
  signature?: string | null;
  targetId?: string | null;
  env?: Env;
}

/** Sends a signed `/webhook` delivery to the Worker. Headers left out of `options` get valid values. */
export async function postWebhook(options: PostWebhookOptions = {}): Promise<Response> {
  const body = options.body ?? JSON.stringify(options.payload ?? {});
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const values: Record<string, string | null> = {
    'X-GitHub-Event': options.event === undefined ? 'ping' : options.event,
    'X-GitHub-Delivery': options.delivery === undefined ? crypto.randomUUID() : options.delivery,
    'X-GitHub-Hook-Installation-Target-ID': options.targetId === undefined ? APP_ID : options.targetId,
    'X-Hub-Signature-256': options.signature === undefined ? await signWebhook(body) : options.signature,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value !== null) headers[name] = value;
  }
  const request = new Request(`https://${OIDC_AUDIENCE}/webhook`, { method: 'POST', headers, body });
  return worker.fetch(request, options.env ?? TEST_ENV);
}

/** Returns the coordinator stub for a PR of the test repository, named as the Worker names it. */
export function coordinator(repositoryId: number, number: number): DurableObjectStub<PrCoordinator> {
  return RUNTIME_ENV.PR_COORDINATOR.getByName(`${repositoryId}:${number}`);
}

/** Returns the coordinator's work items in queue order, or none when it holds no state. */
export async function workRows(stub: DurableObjectStub<PrCoordinator>): Promise<WorkRow[]> {
  return runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    if (sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work'`).toArray().length === 0) return [];
    return sql.exec<WorkRow>('SELECT * FROM work ORDER BY id').toArray();
  });
}

/** Returns the names of the tables the object's storage holds. */
export async function tableNames(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'`).toArray().map((row) => row.name));
}

/**
 * Returns an env whose PR coordinators answer `refuseRun` with `refusal`, null when they hold the run, and records each
 * check as the coordinator name and arguments. Every other coordinator call goes nowhere, so only `/token` may use it.
 */
export function dispatchedEnv(refusal: string | null = null, base: Env = TEST_ENV): { env: Env; checks: unknown[][] } {
  const checks: unknown[][] = [];
  const coordinators = {
    getByName: (name: string) => ({
      refuseRun: async (...args: unknown[]) => {
        checks.push([name, ...args]);
        return refusal;
      },
    }),
  };
  return { env: { ...base, PR_COORDINATOR: coordinators as unknown as Env['PR_COORDINATOR'] }, checks };
}

/** Switches dispatch on or off for the Durable Objects, which read `DISPATCH_ENABLED` from the runtime env. */
export function setDispatchEnabled(enabled: boolean): void {
  RUNTIME_ENV.DISPATCH_ENABLED = enabled ? 'true' : 'false';
}
