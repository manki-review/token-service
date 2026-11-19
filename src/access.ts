import type { Env } from './env';
import { log } from './log';
import { verifyWorkflowRequest } from './oidc';
import { RECONCILER_NAME } from './reconciler';
import { checkDispatchedRun } from './run-check';

const USER_ID = /^[1-9][0-9]{0,15}$/;

/**
 * Serves `/access`, which tells the run a PR coordinator dispatched whether the account with `user_id` is on the allow
 * list of the run's repository. It takes the workflow's OIDC token like `/token`, and the repository is the one in the
 * token's `repository_id` claim, never one the body names. Once the token is verified, any failure answers
 * `allowed: false`.
 */
export async function handleAccess(request: Request, env: Env): Promise<Response> {
  const verified = await verifyWorkflowRequest(request, env);
  if (verified instanceof Response) return verified;
  const { claims, body, installation } = verified;
  const userId = body.user_id;
  if (typeof userId !== 'number' || !USER_ID.test(String(userId))) {
    return Response.json({ error: 'user_id must be a positive integer' }, { status: 400 });
  }
  const repositoryId = Number(claims.repository_id);
  const audit = { repository: claims.repository, run_id: claims.run_id, user_id: userId };
  try {
    const run = await checkDispatchedRun(env, claims, installation.id, repositoryId);
    if ('refused' in run) {
      log('access_refused', { ...audit, reason: run.refused });
      return Response.json({ error: `Only the run Manki dispatched may ask about access: ${run.refused}` }, { status: 403 });
    }
    const allowed = await env.RECONCILER.getByName(RECONCILER_NAME).isAllowedAccount(repositoryId, userId);
    log('access_answered', { ...audit, pr: run.pr, allowed });
    return Response.json({ allowed });
  } catch (error) {
    log('access_failed', { ...audit, error: String(error) });
    return Response.json({ allowed: false });
  }
}
