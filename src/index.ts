import { createAppJWT } from './app-jwt';
import type { Env } from './env';
import { createInstallationToken, getInstallation, type Installation, logMintedToken, type TokenAudit } from './github';
import { log } from './log';
import { type OIDCClaims, verifyGitHubOIDC } from './oidc';
import { cappedPermissions, MANKI_PERMISSION_CAPS, MEMORY_PERMISSION_CAPS, type Permissions } from './permissions';
import { RECONCILER_NAME } from './reconciler';
import { handleWebhook } from './webhook';

export { PrCoordinator } from './coordinator';
export { Reconciler } from './reconciler';

// Only this name is minted, so a token for one installation account can never write another account's memory.
const MEMORY_REPO = 'review-memory';

interface MintedToken {
  token: string;
  expires_at: string;
}

/** The audit fields of the workflow a `/token` response goes to. */
type WorkflowAudit = Omit<TokenAudit, 'purpose' | 'installation_id' | 'permissions'>;

/**
 * Mints a token that writes only the installation account's `review-memory`. Returns `null` when the installation
 * grants no `contents` or GitHub refuses the mint, such as when `review-memory` is not part of the installation.
 */
async function mintMemoryToken(jwt: string, installation: Installation, workflow: WorkflowAudit): Promise<MintedToken | null> {
  const permissions = cappedPermissions(installation.permissions, MEMORY_PERMISSION_CAPS);
  if (Object.keys(permissions).length === 0) return null;
  try {
    const response = await createInstallationToken(jwt, installation.id, permissions, { repositories: [MEMORY_REPO] });
    if (!response.ok) {
      log('memory token mint refused', { installation_id: installation.id, status: response.status });
      return null;
    }
    const data = await response.json() as MintedToken & { permissions: Permissions };
    logMintedToken({ purpose: 'memory', ...workflow, installation_id: installation.id, permissions: data.permissions });
    return { token: data.token, expires_at: data.expires_at };
  } catch (error) {
    log('memory token mint failed', { installation_id: installation.id, error: String(error) });
    return null;
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(env.RECONCILER.getByName(RECONCILER_NAME).reconcile());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'POST required' }, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === '/webhook') {
      return handleWebhook(request, env);
    }
    if (url.pathname !== '/token') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Verify GitHub Actions OIDC token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json({ error: 'Authorization header with Bearer token required' }, { status: 401 });
    }
    const oidcToken = authHeader.slice(7);

    let parsed: { owner?: unknown; repo?: unknown; memory?: unknown } | null;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (typeof parsed?.owner !== 'string' || typeof parsed?.repo !== 'string' || !parsed.owner || !parsed.repo) {
      return Response.json({ error: 'owner and repo are required' }, { status: 400 });
    }
    if (parsed.memory !== undefined && typeof parsed.memory !== 'boolean') {
      return Response.json({ error: 'memory must be a boolean' }, { status: 400 });
    }
    const body = { owner: parsed.owner, repo: parsed.repo, memory: parsed.memory === true };

    const expectedRepo = `${body.owner}/${body.repo}`;

    // Verify the OIDC token is from a GitHub Actions workflow in the requested repo
    let claims: OIDCClaims;
    try {
      claims = await verifyGitHubOIDC(oidcToken, expectedRepo);
    } catch (error) {
      return Response.json(
        { error: `OIDC verification failed: ${error}` },
        { status: 403 },
      );
    }
    const repositoryId = Number(claims.repository_id);
    const workflow: WorkflowAudit = {
      repository_id: repositoryId,
      repository: claims.repository,
      run_id: claims.run_id,
      check_run_id: claims.check_run_id,
    };

    try {
      const appJwt = await createAppJWT(env.APP_ID, env.APP_PRIVATE_KEY);

      const installation = await getInstallation(appJwt, body.owner, body.repo);
      if (!installation) {
        return Response.json(
          { error: 'App not installed on this repository' },
          { status: 404 },
        );
      }

      // An empty `permissions` object would not narrow the token, so refuse instead of minting a full one.
      const permissions = cappedPermissions(installation.permissions, MANKI_PERMISSION_CAPS);
      if (Object.keys(permissions).length === 0) {
        return Response.json(
          { error: 'App installation grants none of the permissions Manki needs' },
          { status: 403 },
        );
      }

      const tokenResponse = await createInstallationToken(appJwt, installation.id, permissions, { repository_ids: [repositoryId] });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        return Response.json(
          { error: `GitHub API error: ${tokenResponse.status}`, details: error },
          { status: tokenResponse.status },
        );
      }

      const tokenData = await tokenResponse.json() as MintedToken & { permissions: Permissions };
      logMintedToken({ purpose: 'review', ...workflow, installation_id: installation.id, permissions: tokenData.permissions });
      const memory = body.memory ? await mintMemoryToken(appJwt, installation, workflow) : null;

      return Response.json({
        token: tokenData.token,
        expires_at: tokenData.expires_at,
        permissions: tokenData.permissions,
        ...(memory && { memory_token: memory.token, memory_expires_at: memory.expires_at }),
      });
    } catch (error) {
      return Response.json(
        { error: `Token generation failed: ${error}` },
        { status: 500 },
      );
    }
  },
};
