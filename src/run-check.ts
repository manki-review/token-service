import { parseRunTitle } from './dispatch';
import type { Env } from './env';
import { githubApi, isRefusal, mintRepositoryToken } from './github';
import { BOT_LOGIN } from './manki';
import type { OIDCClaims } from './oidc';

/** `<owner>/<repo>/.github/workflows/<file>@<ref>`, the form of the `workflow_ref` claim. */
const WORKFLOW_REF = /^([^/]+\/[^/]+)\/\.github\/workflows\/([^/@]+)@(refs\/heads\/.+)$/;

/**
 * Returns the workflow file and branch ref a `workflow_dispatch` run of the token's own repository started from, or why
 * the claims show no such run. Only a dispatched Manki run may act for a repository.
 */
export function dispatchedWorkflow(claims: OIDCClaims): { file: string; ref: string } | string {
  if (claims.event_name !== 'workflow_dispatch') return `event ${claims.event_name} is not workflow_dispatch`;
  const workflow = WORKFLOW_REF.exec(claims.workflow_ref);
  if (!workflow || workflow[1] !== claims.repository || workflow[3] !== claims.ref) {
    return `workflow ${claims.workflow_ref} is not a branch workflow of ${claims.repository}`;
  }
  return { file: workflow[2], ref: workflow[3] };
}

/** The PR of the run a coordinator dispatched, or why the workflow is not that run. */
type DispatchedRun = { pr: number } | { refused: string };

/**
 * Checks that the workflow is the run a PR coordinator dispatched, and returns its PR. Only that run may act as Manki,
 * so no other workflow of the repository can. The run must come from `workflow_dispatch` by the App, from the
 * workflow file and default branch the coordinator dispatched, and be a run it holds as dispatching or running.
 */
export async function checkDispatchedRun(env: Env, claims: OIDCClaims, installationId: number, repositoryId: number): Promise<DispatchedRun> {
  const refuse = (refused: string): DispatchedRun => ({ refused });
  const workflow = dispatchedWorkflow(claims);
  if (typeof workflow === 'string') return refuse(workflow);
  // Only a refusal refuses the run. Any other GitHub failure throws, so the caller answers 500 and the run can retry.
  const mint = await mintRepositoryToken(env, installationId, repositoryId, { actions: 'read' }, { purpose: 'run_check', repository: claims.repository });
  if (!mint.ok && !mint.refused) throw new Error(`the run check's token mint failed with ${mint.status}`);
  if (!mint.ok) return refuse(`the run could not be read: token mint refused with ${mint.status}`);
  const response = await githubApi(mint.token, `/repos/${claims.repository}/actions/runs/${claims.run_id}`);
  if (!response.ok) {
    const text = await response.text();
    if (!isRefusal(response, text)) throw new Error(`reading run ${claims.run_id} failed with ${response.status}`);
    return refuse(`run ${claims.run_id} could not be read: ${response.status}`);
  }
  const run = await response.json() as { event?: string; display_title?: string; actor?: { login?: string } };
  const title = parseRunTitle(run.display_title);
  if (run.event !== 'workflow_dispatch' || run.actor?.login !== BOT_LOGIN || !title) return refuse(`run ${claims.run_id} is not a run Manki dispatched`);
  const refused = await env.PR_COORDINATOR.getByName(`${repositoryId}:${title.number}`)
    .refuseRun(Number(claims.run_id), title.delivery, workflow.file, workflow.ref);
  return refused === null ? { pr: title.number } : refuse(refused);
}
