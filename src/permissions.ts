export type Permissions = Record<string, string>;

type CappedLevel = 'read' | 'write';

export type PermissionCaps = Record<string, CappedLevel>;

// The most a token for a Manki run may hold, taken from the GitHub API calls the action makes.
// `contents: write` is needed to resolve review threads. The token only covers the requesting repository.
export const MANKI_PERMISSION_CAPS: PermissionCaps = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
  security_events: 'read',
};

// The memory token writes `review-memory` and nothing else.
export const MEMORY_PERMISSION_CAPS: PermissionCaps = { contents: 'write' };

const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * Returns the permissions to request for a token. It keeps each permission in `caps` that the installation grants, at
 * the lower of the two levels. Asking for more than the installation grants fails the mint.
 */
export function cappedPermissions(granted: Permissions, caps: PermissionCaps): Permissions {
  const requested: Permissions = {};
  for (const [name, cap] of Object.entries(caps)) {
    const level = Object.hasOwn(granted, name) ? granted[name] : undefined;
    if (level === undefined || !Object.hasOwn(LEVEL_RANK, level)) continue;
    requested[name] = LEVEL_RANK[level] < LEVEL_RANK[cap] ? level : cap;
  }
  return requested;
}
