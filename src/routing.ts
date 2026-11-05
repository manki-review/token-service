import { numberFromRunTitle } from './dispatch';
import {
  BOT_LOGIN,
  detectTickedMarker,
  hasBotMention,
  isBotMentionNonReview,
  isReviewRequest,
  MANKI_COMMENT_MARKER,
  MANKI_LOGINS,
  parseCommandType,
} from './manki';

/** The file name of the dispatch-only workflow a repository adds to opt in to webhook mode. */
export const DISPATCH_WORKFLOW = 'manki-dispatch.yml';

/**
 * The state lane carries everything that reads or changes threads, verdicts or approval. The chat lane carries
 * answers that change no PR state, so a question does not wait behind a review.
 */
export type Lane = 'state' | 'chat';

/**
 * The Manki handler a work item ends up in. Only `review` items coalesce.
 * - `review`: `handlePullRequest` or `handleCommentTrigger`
 * - `merged`: `handleMergedPullRequest`
 * - `review_state`: `handleReviewStateCheck`, also for a resolved or reopened thread
 * - `thread`: `handleReviewCommentInteraction`
 * - `comment`: `handleInteraction`
 * - `issue`: `handleIssueInteraction`
 */
export type WorkKind = 'review' | 'merged' | 'review_state' | 'thread' | 'comment' | 'issue';

/** The pull request or issue a delivery is about. Every field comes from the signed payload. */
export interface Target {
  installationId: number;
  repositoryId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  number: number;
}

export interface Work {
  lane: Lane;
  kind: WorkKind;
  /** `<event>.<action>`, the `event` input of the dispatch. */
  event: string;
  /** Null when the payload names no head, as for issue comments. */
  headSha: string | null;
  /** The comment or review id, when the event is about one. */
  objectId: number | null;
  sender: string;
}

export type Route =
  | { type: 'ignore'; reason: string }
  | { type: 'work'; target: Target; work: Work }
  | { type: 'close'; target: Target; merged: Work | null }
  | { type: 'run_completed'; target: Target; runId: number; conclusion: string | null };

interface User {
  login?: string;
  type?: string;
}

interface PullRequest {
  number?: number;
  draft?: boolean;
  merged?: boolean;
  state?: string;
  head?: { sha?: string; repo?: { full_name?: string } | null };
}

export interface WebhookPayload {
  action?: string;
  sender?: User;
  installation?: { id?: number };
  repository?: { id?: number; name?: string; full_name?: string; default_branch?: string; owner?: { login?: string } };
  pull_request?: PullRequest;
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; user?: User; in_reply_to_id?: number };
  review?: { id?: number; commit_id?: string; user?: User };
  workflow_run?: { id?: number; event?: string; path?: string; display_title?: string; conclusion?: string | null };
}

const ignore = (reason: string): Route => ({ type: 'ignore', reason });

function targetOf(payload: WebhookPayload, number: number | undefined): Target | null {
  const { installation, repository } = payload;
  if (
    installation?.id === undefined || repository?.id === undefined || !repository.name || !repository.owner?.login
    || !repository.default_branch || number === undefined
  ) {
    return null;
  }
  return {
    installationId: installation.id,
    repositoryId: repository.id,
    owner: repository.owner.login,
    repo: repository.name,
    defaultBranch: repository.default_branch,
    number,
  };
}

function isBot(user: User | undefined): boolean {
  return user?.type === 'Bot' || user?.login === BOT_LOGIN;
}

function isForkHead(payload: WebhookPayload): boolean {
  return payload.pull_request?.head?.repo?.full_name !== payload.repository?.full_name;
}

function work(lane: Lane, kind: WorkKind, payload: WebhookPayload, event: string, objectId: number | null = null): Work {
  return {
    lane,
    kind,
    event: `${event}.${payload.action}`,
    headSha: payload.pull_request?.head?.sha ?? null,
    objectId,
    sender: payload.sender?.login ?? '',
  };
}

/**
 * Decides what a verified delivery becomes. It drops only what Manki would drop anyway: the consumer workflow's job
 * `if` and the checks `run()` makes before it reaches a handler. It may forward more than Manki acts on, never less.
 */
export function routeDelivery(event: string, payload: WebhookPayload): Route {
  if (event === 'workflow_run') return routeWorkflowRun(payload);
  const handled = ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'issue_comment'];
  if (!handled.includes(event)) {
    return ignore(`unhandled event ${event}`);
  }

  const number = event === 'issue_comment' ? payload.issue?.number : payload.pull_request?.number;
  const target = targetOf(payload, number);
  if (!target) return ignore('payload lacks the installation, repository or number');

  // A close always clears the queue, even when the job `if` would skip the run that records the fix rate.
  if (event === 'pull_request' && payload.action === 'closed') {
    const recordsFixRate = payload.pull_request?.merged === true && !isBot(payload.sender) && !isForkHead(payload);
    return { type: 'close', target, merged: recordsFixRate ? work('state', 'merged', payload, event) : null };
  }

  if (isBot(payload.sender)) return ignore('sender is a bot');
  if (payload.pull_request && isForkHead(payload)) return ignore('head is on a fork');

  switch (event) {
    case 'pull_request':
      return routePullRequest(target, payload);
    case 'pull_request_review':
      return routeReview(target, payload);
    case 'pull_request_review_comment':
      return routeReviewComment(target, payload);
    case 'pull_request_review_thread':
      return routeReviewThread(target, payload);
    default:
      return routeIssueComment(target, payload);
  }
}

function routePullRequest(target: Target, payload: WebhookPayload): Route {
  const { action } = payload;
  if (action !== 'opened' && action !== 'synchronize' && action !== 'ready_for_review') {
    return ignore(`pull_request action ${action}`);
  }
  if (payload.pull_request?.draft) return ignore('pull request is a draft');
  return { type: 'work', target, work: work('state', 'review', payload, 'pull_request') };
}

function routeReview(target: Target, payload: WebhookPayload): Route {
  const { action, review } = payload;
  if (action !== 'submitted' && action !== 'dismissed') return ignore(`pull_request_review action ${action}`);
  if (review?.user?.type === 'Bot') return ignore('review author is a bot');
  const headSha = payload.pull_request?.head?.sha;
  if (review?.commit_id && headSha && review.commit_id !== headSha) return ignore('review is for a stale commit');
  return { type: 'work', target, work: work('state', 'review_state', payload, 'pull_request_review', review?.id ?? null) };
}

/**
 * A resolved or reopened thread can change whether the PR may be approved, so it runs the review state check.
 * GitHub Actions has no trigger for this event, so only webhook mode reacts to it.
 */
function routeReviewThread(target: Target, payload: WebhookPayload): Route {
  const { action } = payload;
  if (action !== 'resolved' && action !== 'unresolved') return ignore(`pull_request_review_thread action ${action}`);
  if (payload.pull_request?.state !== 'open') return ignore('pull request is closed');
  return { type: 'work', target, work: work('state', 'review_state', payload, 'pull_request_review_thread') };
}

function routeReviewComment(target: Target, payload: WebhookPayload): Route {
  const { action, comment } = payload;
  if (action !== 'created') return ignore(`pull_request_review_comment action ${action}`);
  const body = comment?.body ?? '';
  if (comment?.user?.type === 'Bot' || body.includes(MANKI_COMMENT_MARKER)) return ignore('comment is from a bot');
  if (!comment?.in_reply_to_id && !hasBotMention(body)) return ignore('comment is neither a reply nor a mention');
  // Every thread command ends with Manki's auto-approve check, so none may run beside a review.
  return { type: 'work', target, work: work('state', 'thread', payload, 'pull_request_review_comment', comment?.id ?? null) };
}

function routeIssueComment(target: Target, payload: WebhookPayload): Route {
  const { action, comment } = payload;
  if (action !== 'created' && action !== 'edited') return ignore(`issue_comment action ${action}`);
  const body = comment?.body ?? '';
  const objectId = comment?.id ?? null;
  const onPullRequest = Boolean(payload.issue?.pull_request);

  // Manki decides whether the comment's author is one of its identities. Only a tick on a comment by its default
  // logins becomes a review trigger. Any other tick queues on its own, so it cannot replace a queued push review.
  if (onPullRequest && action === 'edited' && detectTickedMarker(body) !== null) {
    const kind = MANKI_LOGINS.includes(comment?.user?.login ?? '') ? 'review' : 'comment';
    return { type: 'work', target, work: work('state', kind, payload, 'issue_comment', objectId) };
  }

  // An edit that keeps an earlier mention is forwarded too. Manki's eyes reaction check skips one it answered.
  if (!hasBotMention(body)) return ignore('comment does not mention Manki');

  if (!onPullRequest) {
    if (comment?.user?.type === 'Bot' || body.includes(MANKI_COMMENT_MARKER)) return ignore('comment is from a bot');
    return isBotMentionNonReview(body)
      ? { type: 'work', target, work: work('chat', 'issue', payload, 'issue_comment', objectId) }
      : ignore('review request on an issue');
  }

  if (isReviewRequest(body)) {
    return { type: 'work', target, work: work('state', 'review', payload, 'issue_comment', objectId) };
  }
  const command = parseCommandType(body);
  const lane: Lane = command === 'check' || command === 'dismiss' ? 'state' : 'chat';
  return { type: 'work', target, work: work(lane, 'comment', payload, 'issue_comment', objectId) };
}

/**
 * Routes the end of a dispatched run to its PR. The dispatch workflow's `run-name` puts the PR number in the run's
 * `display_title`. The coordinator matches the run id, so a title naming the wrong PR is ignored there.
 */
function routeWorkflowRun(payload: WebhookPayload): Route {
  const run = payload.workflow_run;
  if (payload.action !== 'completed') return ignore(`workflow_run action ${payload.action}`);
  const path = `.github/workflows/${DISPATCH_WORKFLOW}`;
  // The path can carry the ref, as in `.github/workflows/manki-dispatch.yml@refs/heads/main`.
  if (run?.id === undefined || run.event !== 'workflow_dispatch' || (run.path !== path && !run.path?.startsWith(`${path}@`))) {
    return ignore('not a Manki dispatch run');
  }
  const target = targetOf(payload, numberFromRunTitle(run.display_title));
  if (!target) return ignore('run name or payload lacks the PR');
  return { type: 'run_completed', target, runId: run.id, conclusion: run.conclusion ?? null };
}
