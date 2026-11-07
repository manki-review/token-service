import { createAppJWT } from './app-jwt';
import type { Env } from './env';
import { parseRunTitle } from './dispatch';
import { createInstallationToken, githubApi, type Installation, isRefusal, logMintedToken, mintRepositoryToken, type TokenAudit } from './github';
import { failure, log } from './log';
import { BOT_LOGIN } from './manki';
import { type OIDCClaims, verifyWorkflowRequest } from './oidc';
import { cappedPermissions, MANKI_PERMISSION_CAPS, MEMORY_PERMISSION_CAPS, type Permissions } from './permissions';
import { RECONCILER_NAME } from './reconciler';
import { handleState } from './state';
import { handleWebhook } from './webhook';

export { PrCoordinator } from './coordinator';
export { InstallationLimiter } from './limiter';
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

/** `<owner>/<repo>/.github/workflows/<file>@<ref>`, the form of the `workflow_ref` claim. */
const WORKFLOW_REF = /^([^/]+\/[^/]+)\/\.github\/workflows\/([^/@]+)@(refs\/heads\/.+)$/;

/**
 * Returns why the workflow is not the run a PR coordinator dispatched, or null when it is. Only that run gets tokens, so
 * no other workflow of the repository can act as Manki. The run must come from `workflow_dispatch` by the App, from the
 * workflow file and default branch the coordinator dispatched, and be a run it holds as dispatching or running.
 */
async function refuseWorkflow(env: Env, claims: OIDCClaims, installationId: number, repositoryId: number): Promise<string | null> {
  if (claims.event_name !== 'workflow_dispatch') return `event ${claims.event_name} is not workflow_dispatch`;
  const workflow = WORKFLOW_REF.exec(claims.workflow_ref);
  if (!workflow || workflow[1] !== claims.repository || workflow[3] !== claims.ref) {
    return `workflow ${claims.workflow_ref} is not a branch workflow of ${claims.repository}`;
  }
  // Only a refusal refuses the run. Any other GitHub failure throws, so the caller answers 500 and the run can retry.
  const mint = await mintRepositoryToken(env, installationId, repositoryId, { actions: 'read' }, { purpose: 'run_check', repository: claims.repository });
  if (!mint.ok && !mint.refused) throw new Error(`the run check's token mint failed with ${mint.status}`);
  if (!mint.ok) return `the run could not be read: token mint refused with ${mint.status}`;
  const response = await githubApi(mint.token, `/repos/${claims.repository}/actions/runs/${claims.run_id}`);
  if (!response.ok) {
    const text = await response.text();
    if (!isRefusal(response, text)) throw new Error(`reading run ${claims.run_id} failed with ${response.status}`);
    return `run ${claims.run_id} could not be read: ${response.status}`;
  }
  const run = await response.json() as { event?: string; display_title?: string; actor?: { login?: string } };
  const title = parseRunTitle(run.display_title);
  if (run.event !== 'workflow_dispatch' || run.actor?.login !== BOT_LOGIN || !title) return `run ${claims.run_id} is not a run Manki dispatched`;
  return env.PR_COORDINATOR.getByName(`${repositoryId}:${title.number}`).refuseRun(Number(claims.run_id), title.delivery, workflow[2], workflow[3]);
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
    if (url.pathname === '/state' || url.pathname === '/state/report') {
      return handleState(request, env, url.pathname === '/state/report');
    }
    if (url.pathname !== '/token') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const verified = await verifyWorkflowRequest(request, env);
    if (verified instanceof Response) return verified;
    const { claims, body: parsed, installation } = verified;
    if (parsed.memory !== undefined && typeof parsed.memory !== 'boolean') {
      return Response.json({ error: 'memory must be a boolean' }, { status: 400 });
    }
    const body = { owner: parsed.owner, repo: parsed.repo, memory: parsed.memory === true };

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

      const refused = await refuseWorkflow(env, claims, installation.id, repositoryId);
      if (refused !== null) {
        log('token_refused', { ...workflow, event_name: claims.event_name, workflow_ref: claims.workflow_ref, reason: refused });
        return Response.json({ error: `Only the run Manki dispatched gets a token: ${refused}` }, { status: 403 });
      }

      const tokenResponse = await createInstallationToken(appJwt, installation.id, permissions, { repository_ids: [repositoryId] });

      if (!tokenResponse.ok) {
        return failure(tokenResponse.status, 'Token mint failed', { detail: await tokenResponse.text() });
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
      return failure(500, 'Token generation failed', { detail: String(error) });
    }
  },
};
