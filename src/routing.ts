import { parseRunTitle } from './dispatch';
import {
  BOT_LOGIN,
  type BoxChange,
  changedBoxes,
  hasBotMention,
  isBotMentionNonReview,
  isReviewRequest,
  MANKI_COMMENT_MARKER,
  MANKI_LOGINS,
  parseCommandType,
  type ReviewMode,
  SETTINGS_MARKER,
  tickedIssueBoxes,
} from './manki';

/** A comment event older than this when it arrives, such as a late redelivery, is dropped. */
export const STALE_COMMENT_MS = 6 * 60 * 60 * 1000;

/**
 * A workflow file's path as a run names it, maybe with the ref, as in `.github/workflows/manki.yml@refs/heads/main`.
 * Any file name counts, since the repository's opt-in decides which file the Worker dispatches.
 */
const WORKFLOW_PATH = /^\.github\/workflows\/[^/@]+\.ya?ml(@.+)?$/;

/**
 * The state lane carries everything that reads or changes threads, verdicts or approval. The chat lane carries
 * answers that change no PR state, so a question does not wait behind a review. The help lane carries help commands,
 * which the Worker answers itself, so they wait behind no run. The settings lane carries edits of Manki's settings
 * boxes, which the Worker applies itself, so a Cancel tick never waits behind the run it cancels.
 */
export type Lane = 'state' | 'chat' | 'help' | 'settings';

/**
 * The Manki handler a work item ends up in. Only `review` items coalesce.
 * - `review`: `handlePullRequest` or `handleCommentTrigger`
 * - `merged`: `handleMergedPullRequest`
 * - `review_state`: `handleReviewStateCheck`, also for a resolved or reopened thread
 * - `thread`: `handleReviewCommentInteraction`
 * - `comment`: `handleInteraction`
 * - `issue`: `handleIssueInteraction`
 * - `help`: answered by the Worker, with no run
 * - `settings`: applied by the Worker, with no run
 */
export type WorkKind = 'review' | 'merged' | 'review_state' | 'thread' | 'comment' | 'issue' | 'help' | 'settings';

/** The pull request or issue a delivery is about. Every field comes from the signed payload. */
export interface Target {
  installationId: number;
  repositoryId: number;
  owner: string;
  /** The id of the account that owns the repository, which is the account the App is installed on. */
  ownerId: number;
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
  /**
   * Whether a repository user caused the work. Only a comment or a review can come from someone else, and only a
   * trusted comment may merge with a push review.
   */
  trusted: boolean;
  /**
   * Whether the work comes from a Manki command its sender wrote. A writer's command gets the eyes reaction as soon as
   * it is queued.
   */
  acknowledge: boolean;
  /**
   * Whether someone with write access caused the work: a push to a branch of the repository, a thread resolved on a
   * same-repository PR, a dismissed review, or a comment or review by an `OWNER`. For a `MEMBER` or `COLLABORATOR` it
   * is what the payload claims until `checkWriter` is settled.
   */
  writer: boolean;
  /**
   * Whether the sender's write access must be looked up before `writer` holds. Set for a comment or review its sender
   * wrote, unless the author's `author_association` settles it.
   */
  checkWriter?: boolean;
  /** For a review, what the settings boxes asked of it. */
  modes?: ReviewMode[];
  /** For a settings edit, the boxes it ticked or unticked. */
  boxes?: BoxChange[];
  /** For a settings edit, when the comment was edited, so a late delivery cannot undo a newer edit. */
  editedAt?: number;
  /**
   * The node id of an edited review whose last editor is the sender. GitHub names the review's author as the sender of
   * the edit, so the editor is looked up before the work counts.
   */
  editorOf?: string;
}

export type Route =
  | { type: 'ignore'; reason: string }
  | { type: 'work'; target: Target; work: Work }
  /** `at` is when GitHub says the PR closed, or reopened, in milliseconds. 0 when the payload names no time. */
  | { type: 'close'; target: Target; merged: Work | null; at: number }
  | { type: 'seen'; target: Target; headSha: string }
  | { type: 'reopen'; target: Target; at: number }
  | { type: 'run_completed'; target: Target; runId: number; conclusion: string | null };

interface User {
  login?: string;
  type?: string;
}

interface PullRequest {
  number?: number;
  user?: User;
  draft?: boolean;
  merged?: boolean;
  state?: string;
  closed_at?: string | null;
  updated_at?: string;
  head?: { sha?: string; repo?: { full_name?: string } | null };
}

export interface WebhookPayload {
  action?: string;
  sender?: User;
  installation?: { id?: number };
  repository?: { id?: number; name?: string; full_name?: string; default_branch?: string; owner?: { login?: string; id?: number } };
  pull_request?: PullRequest;
  issue?: { number?: number; pull_request?: unknown; user?: User };
  comment?: {
    id?: number;
    body?: string;
    user?: User;
    author_association?: string;
    in_reply_to_id?: number;
    created_at?: string;
    updated_at?: string;
  };
  review?: { id?: number; node_id?: string; body?: string; commit_id?: string; user?: User; author_association?: string };
  /** What an `edited` action changed, with the earlier body. */
  changes?: { body?: { from?: string } };
  workflow_run?: { id?: number; event?: string; path?: string; display_title?: string; conclusion?: string | null };
}

const ignore = (reason: string): Route => ({ type: 'ignore', reason });

function targetOf(payload: WebhookPayload, number: number | undefined): Target | null {
  const { installation, repository } = payload;
  if (
    installation?.id === undefined || repository?.id === undefined || !repository.name || !repository.owner?.login
    || repository.owner.id === undefined || !repository.default_branch || number === undefined
  ) {
    return null;
  }
  return {
    installationId: installation.id,
    repositoryId: repository.id,
    owner: repository.owner.login,
    ownerId: repository.owner.id,
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

/** The `author_association` values Manki's `isRepoUser` accepts. */
const REPO_USER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'];

/**
 * Whether a repository user caused the event, as Manki's `isLLMAccessAllowed` decides it: the comment's or review's
 * author is one, or the sender wrote the pull request or issue. Any other event came from a repository user: a push
 * takes write access, and only the PR author or a writer can resolve a thread.
 */
function isTrusted(payload: WebhookPayload): boolean {
  const authored = payload.comment ?? payload.review;
  if (!authored) return true;
  if (REPO_USER_ASSOCIATIONS.includes(authored.author_association ?? '')) return true;
  const author = (payload.issue?.user ?? payload.pull_request?.user)?.login?.toLowerCase();
  return author !== undefined && payload.sender?.login?.toLowerCase() === author;
}

/**
 * The `author_association` values that claim write access. A member or outside collaborator with read access shows
 * them too, so a lookup settles them.
 */
const CLAIMED_WRITER_ASSOCIATIONS = ['MEMBER', 'COLLABORATOR'];

/**
 * What the `author_association` of the comment or review the sender wrote says about their write access. An `OWNER`
 * has it. Anyone else is looked up, since a member with private membership can show as `NONE`, `CONTRIBUTOR` or
 * `FIRST_TIME_CONTRIBUTOR`. On an edit of someone else's comment, the association is the author's, so it says nothing.
 */
function authorWriter(payload: WebhookPayload): Pick<Work, 'writer' | 'checkWriter'> {
  const { action, comment, sender } = payload;
  const authored = comment ?? payload.review;
  if (!authored || (action === 'edited' && comment && comment.user?.login !== sender?.login)) return { writer: false, checkWriter: false };
  const association = authored.author_association ?? '';
  if (association === 'OWNER') return { writer: true, checkWriter: false };
  return { writer: CLAIMED_WRITER_ASSOCIATIONS.includes(association), checkWriter: true };
}

/**
 * Whether the comment is a Manki command its sender wrote. Only a writer's gets the eyes reaction when it is queued, so
 * a stranger cannot make the App react.
 */
function isOwnCommand(payload: WebhookPayload): boolean {
  const { comment, sender } = payload;
  return hasBotMention(comment?.body ?? '') && comment?.user?.login !== undefined && comment.user.login === sender?.login;
}

function work(lane: Lane, kind: WorkKind, payload: WebhookPayload, event: string, objectId: number | null = null): Work {
  // Fork heads are dropped before this, so a push and a thread resolution, which only a writer or the PR's author
  // can make, both take write access. So does dismissing a review.
  const byEvent = event === 'pull_request' || event === 'pull_request_review_thread'
    || (event === 'pull_request_review' && payload.action === 'dismissed');
  return {
    lane,
    kind,
    event: `${event}.${payload.action}`,
    headSha: payload.pull_request?.head?.sha ?? null,
    objectId,
    sender: payload.sender?.login ?? '',
    trusted: isTrusted(payload),
    acknowledge: isOwnCommand(payload),
    ...(byEvent ? { writer: true, checkWriter: false } : authorWriter(payload)),
  };
}

/**
 * Decides what a verified delivery becomes. It drops only what Manki would drop anyway: the consumer workflow's job
 * `if` and the checks `run()` makes before it reaches a handler. It may forward more than Manki acts on, never less.
 */
export function routeDelivery(event: string, payload: WebhookPayload, now = Date.now()): Route {
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
    const at = Date.parse(payload.pull_request?.closed_at ?? '') || 0;
    return { type: 'close', target, merged: recordsFixRate ? work('state', 'merged', payload, event) : null, at };
  }

  // A tick in Manki's own review arrives with Manki as the sender, so it is routed before bot events are dropped.
  if (event === 'pull_request_review' && payload.action === 'edited' && MANKI_LOGINS.includes(payload.review?.user?.login ?? '')) {
    return routeReviewBoxTick(target, payload);
  }

  // Manki skips a bot's push. The coordinator still records the head, so the cron does not review it later.
  if (isBot(payload.sender)) {
    const headSha = payload.pull_request?.head?.sha;
    const pushed = event === 'pull_request' && ['opened', 'synchronize', 'ready_for_review'].includes(payload.action ?? '');
    return pushed && headSha && !isForkHead(payload) ? { type: 'seen', target, headSha } : ignore('sender is a bot');
  }
  // An answer that late helps nobody. The time is the comment's last edit, which is what a settings box tick changes.
  const commentAt = Date.parse(payload.comment?.updated_at ?? payload.comment?.created_at ?? '');
  if ((event === 'issue_comment' || event === 'pull_request_review_comment') && now - commentAt > STALE_COMMENT_MS) {
    return ignore('comment is over 6 hours old');
  }
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
  // A reopen queues no review, but the coordinator keeps the PR's state as for an open PR again.
  if (action === 'reopened') return { type: 'reopen', target, at: Date.parse(payload.pull_request?.updated_at ?? '') || 0 };
  if (action !== 'opened' && action !== 'synchronize' && action !== 'ready_for_review') {
    return ignore(`pull_request action ${action}`);
  }
  // A draft's push still queues, since `drafts: review` on the base branch reviews it. The coordinator decides.
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
 * Routes an edit of Manki's review that ticks a finding's issue box. The sender is left to the editor lookup, and the
 * editor must have write access. Manki's own rewrite of its review ticks no box, so it is dropped here.
 */
function routeReviewBoxTick(target: Target, payload: WebhookPayload): Route {
  const before = payload.changes?.body?.from;
  if (before === undefined || tickedIssueBoxes(before, payload.review?.body ?? '').length === 0) return ignore('no issue box ticked');
  if (isForkHead(payload)) return ignore('head is on a fork');
  const nodeId = payload.review?.node_id;
  if (!nodeId) return ignore('review lacks its node id');
  return { type: 'work', target, work: {
    ...work('state', 'thread', payload, 'pull_request_review', payload.review?.id ?? null),
    sender: '', acknowledge: false, writer: false, checkWriter: true, editorOf: nodeId,
  } };
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
  const body = comment?.body ?? '';
  // A tick of a finding's issue box in Manki's comment. The editor is looked up, so a writer's tick is trusted work.
  if (action === 'edited' && MANKI_LOGINS.includes(comment?.user?.login ?? '')) {
    const before = payload.changes?.body?.from;
    if (before === undefined || tickedIssueBoxes(before, body).length === 0) return ignore('no issue box ticked');
    return { type: 'work', target, work: {
      ...work('state', 'thread', payload, 'pull_request_review_comment', comment?.id ?? null), acknowledge: false, writer: false, checkWriter: true,
    } };
  }
  if (action !== 'created') return ignore(`pull_request_review_comment action ${action}`);
  if (comment?.user?.type === 'Bot' || body.includes(MANKI_COMMENT_MARKER)) return ignore('comment is from a bot');
  if (!comment?.in_reply_to_id && !hasBotMention(body)) return ignore('comment is neither a reply nor a mention');
  if (parseCommandType(body) === 'help') return helpRoute(target, payload, 'pull_request_review_comment');
  // Every thread command ends with Manki's auto-approve check, so none may run beside a review.
  return { type: 'work', target, work: work('state', 'thread', payload, 'pull_request_review_comment', comment?.id ?? null) };
}

function routeIssueComment(target: Target, payload: WebhookPayload): Route {
  const { action, comment } = payload;
  if (action !== 'created' && action !== 'edited') return ignore(`issue_comment action ${action}`);
  const body = comment?.body ?? '';
  const objectId = comment?.id ?? null;
  const onPullRequest = Boolean(payload.issue?.pull_request);

  // Only the box ticks matter. Editing Manki's comment takes write access, which the coordinator checks for the editor.
  if (onPullRequest && action === 'edited' && MANKI_LOGINS.includes(comment?.user?.login ?? '') && body.includes(SETTINGS_MARKER)) {
    const before = payload.changes?.body?.from;
    const boxes = before === undefined ? [] : changedBoxes(before, body);
    if (boxes.length === 0) return ignore('no settings box changed');
    return { type: 'work', target, work: {
      ...work('settings', 'settings', payload, 'issue_comment', objectId),
      acknowledge: false, writer: false, checkWriter: false, boxes, editedAt: Date.parse(comment?.updated_at ?? '') || 0,
    } };
  }

  // An edit that keeps an earlier mention is forwarded too. Manki skips one it already answered.
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
  if (command === 'help') {
    // The coordinator answers help itself and keeps no record of it, so only an edit that adds the command asks again.
    if (action === 'edited' && parseCommandType(payload.changes?.body?.from ?? '') === 'help') return ignore('help was already asked');
    return helpRoute(target, payload, 'issue_comment');
  }
  const lane: Lane = command === 'check' || command === 'dismiss' ? 'state' : 'chat';
  return { type: 'work', target, work: work(lane, 'comment', payload, 'issue_comment', objectId) };
}

/** A help command on a pull request. It gets a thumbs-up reaction with the answer, never the eyes reaction. */
function helpRoute(target: Target, payload: WebhookPayload, event: string): Route {
  return { type: 'work', target, work: { ...work('help', 'help', payload, event, payload.comment?.id ?? null), acknowledge: false } };
}

/**
 * Routes the end of a dispatched run to its PR. The dispatch workflow's `run-name` puts the PR number in the run's
 * `display_title`. The coordinator matches the run id, so a title naming the wrong PR is ignored there.
 */
function routeWorkflowRun(payload: WebhookPayload): Route {
  const run = payload.workflow_run;
  // Every run in every installed repository sends one, so anything the App did not start is dropped first.
  if (payload.sender?.login !== BOT_LOGIN) return ignore('run was not started by Manki');
  if (payload.action !== 'completed') return ignore(`workflow_run action ${payload.action}`);
  if (run?.id === undefined || run.event !== 'workflow_dispatch' || !WORKFLOW_PATH.test(run.path ?? '')) {
    return ignore('not a Manki dispatch run');
  }
  const target = targetOf(payload, parseRunTitle(run.display_title)?.number);
  if (!target) return ignore('run name or payload lacks the PR');
  return { type: 'run_completed', target, runId: run.id, conclusion: run.conclusion ?? null };
}
