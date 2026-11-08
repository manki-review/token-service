import { jwtVerify, createRemoteJWKSet } from 'jose';
import { readBody } from './body';
import type { Env } from './env';
import { getInstallation, type Installation } from './github';
import { failure, log } from './log';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

// Created once per isolate so GitHub's keys are cached across requests instead of fetched on every one.
const GITHUB_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

export interface OIDCClaims {
  repository: string;
  repository_owner: string;
  repository_id: string;
  repository_owner_id: string;
  run_id: string;
  event_name: string;
  /** `<owner>/<repo>/<path>@<ref>` of the workflow file the run started from. */
  workflow_ref: string;
  ref: string;
  /** `public`, `private` or `internal`. */
  repository_visibility?: string;
  check_run_id?: string;
  [key: string]: unknown;
}

const NUMERIC_ID = /^[1-9][0-9]*$/;
/** The largest body an OIDC endpoint reads, before it checks the token. */
const MAX_REQUEST_BYTES = 1024 * 1024;

export async function verifyGitHubOIDC(token: string, expectedRepo: string): Promise<OIDCClaims> {
  const { payload } = await jwtVerify(token, GITHUB_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: 'manki-api.dustinface.me',
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'repository', 'repository_id', 'repository_owner_id', 'run_id', 'event_name', 'workflow_ref', 'ref'],
    maxTokenAge: '10m',
  });

  const claims = payload as unknown as OIDCClaims;

  if (claims.repository !== expectedRepo) {
    throw new Error(`Repository mismatch: token is for ${claims.repository}, requested ${expectedRepo}`);
  }
  for (const name of ['repository_id', 'repository_owner_id', 'run_id'] as const) {
    if (typeof claims[name] !== 'string' || !NUMERIC_ID.test(claims[name])) {
      throw new Error(`Invalid ${name} claim`);
    }
  }

  return claims;
}

/**
 * A workflow's request: its JSON body, which names the repository, the verified claims of its OIDC token and the App's
 * installation on that repository.
 */
export interface WorkflowRequest {
  claims: OIDCClaims;
  body: Record<string, unknown> & { owner: string; repo: string };
  installation: Installation;
}

/**
 * Reads a request that carries a GitHub Actions OIDC token as its bearer token and a JSON body naming `owner` and
 * `repo`. Returns the error response when the token is missing or not from a workflow in that repository, when the
 * token's account is over its rate limit, or when the App is not installed on the repository.
 */
export async function verifyWorkflowRequest(request: Request, env: Env): Promise<WorkflowRequest | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return Response.json({ error: 'Authorization header with Bearer token required' }, { status: 401 });
  }

  const raw = await readBody(request, MAX_REQUEST_BYTES);
  if (raw === null) return Response.json({ error: `The body is over ${MAX_REQUEST_BYTES} bytes` }, { status: 413 });
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof parsed?.owner !== 'string' || typeof parsed?.repo !== 'string' || !parsed.owner || !parsed.repo) {
    return Response.json({ error: 'owner and repo are required' }, { status: 400 });
  }
  const body = { ...parsed, owner: parsed.owner, repo: parsed.repo };

  let claims: OIDCClaims;
  try {
    claims = await verifyGitHubOIDC(authHeader.slice(7), `${body.owner}/${body.repo}`);
  } catch (error) {
    return failure(403, 'OIDC verification failed', { detail: String(error) });
  }

  // Anyone can get a valid token for a repository of their own, so each account gets a share of the GitHub requests
  // and Durable Object calls the service makes. The key is a verified claim, so no caller spends another's share.
  if (!(await env.ACCOUNT_RATE_LIMIT.limit({ key: claims.repository_owner_id })).success) {
    log('workflow_request_throttled', { repository: claims.repository, repository_owner_id: claims.repository_owner_id });
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }

  let installation: Installation | null;
  try {
    installation = await getInstallation(env, body.owner, body.repo);
  } catch (error) {
    return failure(500, 'Installation lookup failed', { repository: claims.repository, detail: String(error) });
  }
  if (!installation) return Response.json({ error: 'App not installed on this repository' }, { status: 404 });
  return { claims, body, installation };
}
