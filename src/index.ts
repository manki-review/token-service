import { createAppJWT } from './app-jwt';
import type { Env } from './env';
import { createInstallationToken, logMintedToken, type TokenAudit } from './github';
import { failure, log } from './log';
import { handleMemory, type MemoryOperation } from './memory';
import { verifyWorkflowRequest } from './oidc';
import { cappedPermissions, MANKI_PERMISSION_CAPS, type Permissions } from './permissions';
import { RECONCILER_NAME } from './reconciler';
import { handleResolve } from './resolve';
import { checkDispatchedRun } from './run-check';
import { handleState } from './state';
import { handleWebhook } from './webhook';

export { PrCoordinator } from './coordinator';
export { InstallationLimiter } from './limiter';
export { Reconciler } from './reconciler';

interface MintedToken {
  token: string;
  expires_at: string;
}

/** The audit fields of the workflow a `/token` response goes to. */
type WorkflowAudit = Omit<TokenAudit, 'purpose' | 'installation_id' | 'permissions'>;

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
    if (url.pathname === '/state' || url.pathname === '/state/report') {
      return handleState(request, env, url.pathname === '/state/report');
    }
    if (url.pathname === '/resolve') return handleResolve(request, env);
    const memory = url.pathname.match(/^\/memory\/(read|write|append)$/);
    if (memory) return handleMemory(request, env, memory[1] as MemoryOperation);
    if (url.pathname !== '/token') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const verified = await verifyWorkflowRequest(request, env);
    if (verified instanceof Response) return verified;
    const { claims, installation } = verified;

    const repositoryId = Number(claims.repository_id);
    const workflow: WorkflowAudit = {
      repository_id: repositoryId,
      repository: claims.repository,
      run_id: claims.run_id,
      check_run_id: claims.check_run_id,
    };

    try {
      const appJwt = await createAppJWT(env);

      // An empty `permissions` object would not narrow the token, so refuse instead of minting a full one.
      const permissions = cappedPermissions(installation.permissions, MANKI_PERMISSION_CAPS);
      if (Object.keys(permissions).length === 0) {
        return Response.json(
          { error: 'App installation grants none of the permissions Manki needs' },
          { status: 403 },
        );
      }

      const run = await checkDispatchedRun(env, claims, installation.id, repositoryId);
      if ('refused' in run) {
        log('token_refused', { ...workflow, event_name: claims.event_name, workflow_ref: claims.workflow_ref, reason: run.refused });
        return Response.json({ error: `Only the run Manki dispatched gets a token: ${run.refused}` }, { status: 403 });
      }

      const tokenResponse = await createInstallationToken(appJwt, installation.id, permissions, { repository_ids: [repositoryId] });

      if (!tokenResponse.ok) {
        return failure(tokenResponse.status, 'Token mint failed', { detail: await tokenResponse.text() });
      }

      const tokenData = await tokenResponse.json() as MintedToken & { permissions: Permissions };
      logMintedToken({ purpose: 'review', ...workflow, installation_id: installation.id, permissions: tokenData.permissions });
      return Response.json({ token: tokenData.token, expires_at: tokenData.expires_at, permissions: tokenData.permissions });
    } catch (error) {
      return failure(500, 'Token generation failed', { detail: String(error) });
    }
  },
};
