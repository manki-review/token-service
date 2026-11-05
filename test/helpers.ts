import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { vi } from 'vitest';
import worker from '../src/index';

export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const OIDC_AUDIENCE = 'manki-api.dustinface.me';
export const JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
export const APP_ID = '123456';
export const INSTALLATION_ID = 987;
export const OWNER = 'manki-review';
export const REPO = 'manki';

const OIDC_KID = 'test-oidc-key';

export const oidcKeys = await generateKeyPair('RS256', { extractable: true });
export const appKeys = await generateKeyPair('RS256', { extractable: true });
export const appPrivateKeyPkcs8 = await exportPKCS8(appKeys.privateKey);
export const appPrivateKeyPkcs1 = pkcs1Pem(appPrivateKeyPkcs8);

const oidcJwk = { ...(await exportJWK(oidcKeys.publicKey)), kid: OIDC_KID, alg: 'RS256', use: 'sig' };

export const TEST_ENV = { APP_ID, APP_PRIVATE_KEY: appPrivateKeyPkcs1 };

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
  /** Registered claims to leave out of the token. */
  omit?: Array<'exp' | 'iat'>;
}

/** Returns a GitHub Actions OIDC token for `OWNER/REPO`, signed with the key `stubGitHub` serves as the JWKS. */
export async function oidcToken(options: OidcTokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ repository: `${OWNER}/${REPO}`, repository_owner: OWNER, ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: OIDC_KID })
    .setIssuer(options.issuer ?? OIDC_ISSUER)
    .setAudience(options.audience ?? OIDC_AUDIENCE);
  if (!options.omit?.includes('iat')) jwt.setIssuedAt();
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
    if (request.url === JWKS_URL) {
      return Response.json({ keys: [oidcJwk] });
    }
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

/** Returns the requests `stubGitHub` saw for the GitHub REST API, leaving out the JWKS fetch. */
export function apiRequests(requests: Request[]): Request[] {
  return requests.filter((request) => request.url.startsWith('https://api.github.com/'));
}

export interface PostTokenOptions {
  token?: string | null;
  body?: unknown;
  env?: typeof TEST_ENV;
}

/** Sends a `/token` request to the Worker. A missing `token` means a fresh valid OIDC token. */
export async function postToken(options: PostTokenOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = options.token === undefined ? await oidcToken() : options.token;
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? { owner: OWNER, repo: REPO });
  const request = new Request(`https://${OIDC_AUDIENCE}/token`, { method: 'POST', headers, body });
  return worker.fetch(request, options.env ?? TEST_ENV);
}
