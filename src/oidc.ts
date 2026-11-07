import { jwtVerify, createRemoteJWKSet } from 'jose';
import { failure } from './log';

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
  check_run_id?: string;
  [key: string]: unknown;
}

const NUMERIC_ID = /^[1-9][0-9]*$/;

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

/** A workflow's request: its JSON body, which names the repository, and the verified claims of its OIDC token. */
export interface WorkflowRequest {
  claims: OIDCClaims;
  body: Record<string, unknown> & { owner: string; repo: string };
}

/**
 * Reads a request that carries a GitHub Actions OIDC token as its bearer token and a JSON body naming `owner` and
 * `repo`. Returns the error response when the token is missing or not from a workflow in that repository.
 */
export async function verifyWorkflowRequest(request: Request): Promise<WorkflowRequest | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return Response.json({ error: 'Authorization header with Bearer token required' }, { status: 401 });
  }

  let parsed: Record<string, unknown> | null;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof parsed?.owner !== 'string' || typeof parsed?.repo !== 'string' || !parsed.owner || !parsed.repo) {
    return Response.json({ error: 'owner and repo are required' }, { status: 400 });
  }
  const body = { ...parsed, owner: parsed.owner, repo: parsed.repo };

  try {
    return { claims: await verifyGitHubOIDC(authHeader.slice(7), `${body.owner}/${body.repo}`), body };
  } catch (error) {
    return failure(403, 'OIDC verification failed', { detail: String(error) });
  }
}
