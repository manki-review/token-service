import type { Permissions } from './permissions';

function githubHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
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
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    { headers: githubHeaders(jwt) },
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as { id: number; permissions?: Permissions };
  return { id: data.id, permissions: data.permissions ?? {} };
}

export async function createInstallationToken(jwt: string, installationId: number, permissions: Permissions): Promise<Response> {
  return fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { ...githubHeaders(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions }),
    },
  );
}
