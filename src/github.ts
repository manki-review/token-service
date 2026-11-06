import { createAppJWT } from './app-jwt';
import type { Env } from './env';
import { log } from './log';
import type { Permissions } from './permissions';

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'manki-token-service',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export interface Installation {
  id: number;
  permissions: Permissions;
}

export async function getInstallation(jwt: string, owner: string, repo: string): Promise<Installation | null> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    { headers: githubHeaders(jwt), redirect: 'manual' },
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as { id: number; permissions?: Permissions };
  return { id: data.id, permissions: data.permissions ?? {} };
}

/** The repositories a token is limited to, by id or by name under the installation's account. */
export type RepositoryScope = { repository_ids: number[] } | { repositories: string[] };

/** Mints an installation token with `permissions` for the repositories in `scope`. */
export async function createInstallationToken(
  jwt: string,
  installationId: number,
  permissions: Permissions,
  scope: RepositoryScope,
): Promise<Response> {
  return fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { ...githubHeaders(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions, ...scope }),
      redirect: 'manual',
    },
  );
}

/** Whether a 403 is one of GitHub's rate limits, which pass, rather than a refusal. A secondary one may say so only in `body`. */
export function isRateLimited(response: Response, body: string): boolean {
  return response.status === 403 && (
    response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body)
  );
}

/**
 * Whether GitHub refused the request for good: a 403 that is not a rate limit, a 404 or a 422. Any other failure,
 * such as a 5xx or a 429, may pass on a retry.
 */
export function isRefusal(response: Response, body: string): boolean {
  return (response.status === 403 && !isRateLimited(response, body)) || response.status === 404 || response.status === 422;
}

export type MintResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: number; message: string; refused: boolean };

/** The `token_minted` audit line of a minted token. `run_id` and `check_run_id` come from the requesting workflow's OIDC token. */
export interface TokenAudit {
  purpose: 'review' | 'memory' | 'coordinator' | 'reconciler';
  repository_id: number;
  repository: string;
  installation_id: number;
  permissions: Permissions;
  run_id?: string;
  check_run_id?: string;
}

/** Logs the audit line of a minted token. The token itself is never logged. */
export function logMintedToken(audit: TokenAudit): void {
  log('token_minted', { ...audit });
}

/** Mints a token for one repository of an installation, holding only `permissions`. */
export async function mintRepositoryToken(
  env: Env,
  installationId: number,
  repositoryId: number,
  permissions: Permissions,
  audit: Pick<TokenAudit, 'purpose' | 'repository'>,
): Promise<MintResult> {
  const jwt = await createAppJWT(env.APP_ID, env.APP_PRIVATE_KEY);
  const response = await createInstallationToken(jwt, installationId, permissions, { repository_ids: [repositoryId] });
  if (!response.ok) {
    const message = await response.text();
    return { ok: false, status: response.status, message, refused: isRefusal(response, message) };
  }
  const data = await response.json() as { token: string; expires_at: string; permissions: Permissions };
  logMintedToken({ ...audit, repository_id: repositoryId, installation_id: installationId, permissions: data.permissions });
  return { ok: true, token: data.token, expiresAt: Date.parse(data.expires_at) };
}

/** Calls the GitHub REST API at `path` with `token`. */
export async function githubApi(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers = githubHeaders(token);
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  });
}

/** Runs a GraphQL query and returns its `data`. Throws on an HTTP or GraphQL error. */
export async function githubGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await githubApi(token, '/graphql', { method: 'POST', body: { query, variables } });
  if (!response.ok) throw new Error(`GraphQL request failed with ${response.status}`);
  const result = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (result.errors?.length) throw new Error(`GraphQL error: ${result.errors.map((error) => error.message).join('; ')}`);
  return result.data as T;
}
