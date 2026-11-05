export type Permissions = Record<string, string>;

type CappedLevel = 'read' | 'write';

// The most a token for a Manki run may hold, taken from the GitHub API calls the action makes.
// `contents: write` is for review memory, which the action writes with this token when no `memory_repo_token` is set.
const MANKI_PERMISSION_CAPS: Record<string, CappedLevel> = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
  security_events: 'read',
};

const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * Returns the permissions to request for a Manki token. It keeps each permission in `MANKI_PERMISSION_CAPS` that the
 * installation grants, at the lower of the two levels. Asking for more than the installation grants fails the mint.
 */
export function cappedPermissions(granted: Permissions): Permissions {
  const requested: Permissions = {};
  for (const [name, cap] of Object.entries(MANKI_PERMISSION_CAPS)) {
    const level = Object.hasOwn(granted, name) ? granted[name] : undefined;
    if (level === undefined || !Object.hasOwn(LEVEL_RANK, level)) continue;
    requested[name] = LEVEL_RANK[level] < LEVEL_RANK[cap] ? level : cap;
  }
  return requested;
}
