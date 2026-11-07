import type { StateReport } from './coordinator';
import type { Env } from './env';
import { log } from './log';
import { verifyWorkflowRequest } from './oidc';

const COMMIT = /^[0-9a-f]{40}$/;
const MAX_REASON_LENGTH = 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the report fields of a `/state/report` body. Returns an error message when one is malformed. */
function parseReport(body: Record<string, unknown>): StateReport | string {
  const report: StateReport = {};
  const { reviewed, approval, pause } = body;
  if (reviewed !== undefined) {
    if (!isObject(reviewed) || typeof reviewed.commit !== 'string' || !COMMIT.test(reviewed.commit)) {
      return 'reviewed must be { commit } with a full commit SHA';
    }
    report.reviewed = { commit: reviewed.commit };
  }
  if (approval !== undefined) {
    if (!isObject(approval) || typeof approval.commit !== 'string' || !COMMIT.test(approval.commit) || typeof approval.held !== 'boolean') {
      return 'approval must be { commit, held } with a full commit SHA';
    }
    report.approval = { commit: approval.commit, held: approval.held };
  }
  if (pause !== undefined) {
    if (pause !== null && (!isObject(pause) || typeof pause.reason !== 'string' || !pause.reason || pause.reason.length > MAX_REASON_LENGTH)) {
      return `pause must be null or { reason } with a reason of 1 to ${MAX_REASON_LENGTH} characters`;
    }
    report.pause = pause && { reason: pause.reason as string };
  }
  return report;
}

/**
 * Serves `/state`, which returns a PR's running state, and `/state/report`, through which the PR's active run stores
 * what it found. Both take the workflow's OIDC token like `/token`. The PR's coordinator is named by the token's
 * `repository_id` claim, so a workflow only reaches the PRs of its own repository.
 */
export async function handleState(request: Request, env: Env, isReport: boolean): Promise<Response> {
  const verified = await verifyWorkflowRequest(request, env);
  if (verified instanceof Response) return verified;
  const { claims, body } = verified;
  if (typeof body.pr !== 'number' || !Number.isSafeInteger(body.pr) || body.pr <= 0) {
    return Response.json({ error: 'pr must be a positive integer' }, { status: 400 });
  }
  const coordinator = env.PR_COORDINATOR.getByName(`${claims.repository_id}:${body.pr}`);
  if (!isReport) return Response.json(await coordinator.state());

  const runId = Number(claims.run_id);
  if (!Number.isSafeInteger(runId) || runId <= 0) return Response.json({ error: 'OIDC token has no run_id claim' }, { status: 403 });
  const report = parseReport(body);
  if (typeof report === 'string') return Response.json({ error: report }, { status: 400 });
  const result = await coordinator.report(runId, report);
  log('state_report', { repository: claims.repository, pr: body.pr, run_id: runId, ...report, ...result });
  if (!result.accepted) return Response.json({ error: result.reason }, { status: 403 });
  return Response.json({ changed: result.changed });
}
