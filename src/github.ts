import { createAppJWT } from './app-jwt';
import type { Env } from './env';
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

export type MintResult =
  | { ok: true; token: string }
  | { ok: false; status: number; message: string };

/** Mints a token for one repository of an installation, holding only `permissions`. */
export async function mintRepositoryToken(
  env: Env,
  installationId: number,
  repositoryId: number,
  permissions: Permissions,
): Promise<MintResult> {
  const jwt = await createAppJWT(env.APP_ID, env.APP_PRIVATE_KEY);
  const response = await createInstallationToken(jwt, installationId, permissions, { repository_ids: [repositoryId] });
  if (!response.ok) {
    return { ok: false, status: response.status, message: await response.text() };
  }
  const { token } = await response.json() as { token: string };
  return { ok: true, token };
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
