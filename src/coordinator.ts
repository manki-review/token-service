import { DurableObject } from 'cloudflare:workers';
import { dispatchInputs, runTitle } from './dispatch';
import type { Env } from './env';
import { githubApi, githubGraphql, hasWriteAccess, isRateLimited, isRefusal, type MintResult, mintRepositoryToken } from './github';
import { log } from './log';
import {
  autoReviewIsOn, type BaseConfig, BOT_LOGIN, boxLabels, type BoxChange, cancelledProgress, HELP_REPLY, isMankiGraphqlLogin, isRunningProgress, MANKI_COMMENT_MARKER,
  MANKI_LOGINS, matchSkipRule, parseConfig, REVIEW_MODES, type ReviewMode, reviewsDrafts, setBoxes, type SettingsBox, settingsHead, skipRulesOf, withSettingsStatus,
} from './manki';
import { type OptIn, readOptIn, type Repository } from './opt-in';
import type { Permissions } from './permissions';
import { RECONCILER_NAME } from './reconciler';
import { type Lane, type Route, type Target, type Work } from './routing';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long a delivery's id and body hash are remembered, and how long a closed PR's state is kept after its close.
 * Longer than the 3 days in which GitHub can redeliver a delivery.
 */
export const DELIVERY_RETENTION_MS = 7 * DAY;
/** An open PR's state is kept this long after its last delivery, in case its close was never seen. */
export const IDLE_RETENTION_MS = 90 * DAY;
/** A queued item older than this is dropped. A review is derived from the current head anyway. */
export const QUEUED_MAX_AGE_MS = DAY;
export const OPT_IN_TTL_MS = 5 * MINUTE;
/** How long a finished, skipped or dropped item stays, for the logs and the tests to read. */
export const FINISHED_RETENTION_MS = 7 * DAY;
/** How long an alarm may hold an item in `dispatching` before another pass takes it back. */
const LEASE_MS = 5 * MINUTE;
/** How long a queued review or review state check lets thread replies go first. */
export const REPLY_FIRST_MS = 5 * MINUTE;
const LANES: readonly Lane[] = ['state', 'chat', 'help', 'settings'];

/** The wait before each retry of a dispatch that failed with a 5xx or a network error. */
export const DISPATCH_BACKOFF_MS = [15_000, MINUTE, 5 * MINUTE];
/** The safety net behind the `workflow_run` webhook, which normally reports a run's end within seconds. */
export const POLL_MS = 2 * MINUTE;
/** A run still waiting for a runner after this is cancelled. */
export const QUEUED_RUN_TIMEOUT_MS = 30 * MINUTE;
/** A run going this long outlived the dispatch workflow's `timeout-minutes: 30`, so it is cancelled. */
export const RUNNING_RUN_TIMEOUT_MS = 40 * MINUTE;
/**
 * A run not seen ending this long after its dispatch is cancelled. Its lane stays busy until the cancel succeeds or
 * the run is seen completed, so two runs never overlap.
 */
export const RUN_DEADLINE_MS = 75 * MINUTE;
/** A dispatch answered without a run id fails once no matching run turned up in this time. */
export const RUN_LOOKUP_TIMEOUT_MS = 10 * MINUTE;
/** Per lane, stops a comment loop from starting runs without end. */
export const DISPATCHES_PER_HOUR = 30;
/** Per lane, for work from people outside the repository. It is counted apart, so they cannot use up the cap above. */
export const UNTRUSTED_DISPATCHES_PER_HOUR = 5;
/** A token is minted again once it expires within this time. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * MINUTE;
/** How long a looked-up write access is reused for the same login. */
const WRITER_CACHE_MS = 5 * MINUTE;
/** The Free plan's subrequests per invocation, which one alarm must stay within. */
const SUBREQUEST_LIMIT = 50;
/** GitHub calls one alarm spends on eyes reactions at most. The lanes keep the rest of the limit. */
const REACTION_BUDGET = 18;
/** Token mints the reactions of one alarm can take, one for each kind of comment. */
const REACTION_MINTS = 2;
/**
 * The most calls one step of a lane makes, by a count of the code with one check to end: a poll, the end of the waiting
 * checks, or the start of an item. The costliest is a settings edit that ticks Review again on the head under review
 * and Deeper review, with a fresh opt-in read.
 */
const STEP_COST = 32;
/** The most calls the start of an item of `LIGHT_KINDS` makes, with a fresh opt-in read. The costliest is a bot's push that gets its skipped check. */
const LIGHT_COST = 11;
/** The kinds whose start only dispatches a run, answers help or ends a bot's push. Any other kind is checked against `STEP_COST`. */
const LIGHT_KINDS: ReadonlySet<Work['kind']> = new Set(['merged', 'review_state', 'thread', 'comment', 'issue', 'help', 'bot_push']);
/** How long a review waits before each new read of a PR whose mergeability GitHub has not computed yet. */
const MERGEABILITY_RETRY_MS = [5_000, 15_000];
/** GitHub's largest page of the pull requests of a commit. A full page may be cut off. */
const HEAD_PULLS_PAGE = 100;
/** Marks the Worker's note that a review waits for a rebase. Manki removes it once a review posts. */
export const CONFLICT_NOTE_MARKER = '<!-- manki-conflict-note -->';
const NOT_STARTED = new Set(['queued', 'requested', 'waiting', 'pending']);
/** A larger `.manki.yml` is not parsed for skip rules, as it costs too much CPU in an alarm. */
const MAX_CONFIG_BYTES = 64 * 1024;
const PAUSED_NOTE = 'pull request is paused';

export type WorkStatus = 'queued' | 'dispatching' | 'running' | 'done' | 'failed' | 'timed_out' | 'dropped' | 'skipped';

export interface WorkRow extends Record<string, string | number | null> {
  id: number;
  lane: Lane;
  kind: Work['kind'];
  event: string;
  head_sha: string | null;
  /** The PR head when the review's run was last dispatched, whatever started it. */
  run_head: string | null;
  object_id: number | null;
  sender: string;
  delivery: string;
  enqueued_at: number;
  status: WorkStatus;
  lease_until: number | null;
  note: string | null;
  attempts: number;
  first_attempt_at: number | null;
  run_id: number | null;
  dispatched_at: number | null;
  check_at: number | null;
  ended_at: number | null;
  conclusion: string | null;
  /** Consecutive failed starts or polls, which set how long the next try waits. */
  errors: number;
  /** 1 when a repository user caused the work, 0 for a comment by anyone else. */
  trusted: number;
  /** 1 when the payload shows the sender has write access. A comment item with 0 has its sender looked up before it starts. */
  writer: number;
  /** For a review, the JSON list of the modes the settings boxes asked for. Null for none. */
  modes: string | null;
  /** For a settings edit, the JSON of its `SettingsEdit`. */
  boxes: string | null;
  /** How often the item was queued again after its run never started or its workflow file was gone. */
  requeues: number;
  /** The workflow file the last dispatch attempt named. Null before the first attempt. */
  workflow: string | null;
  /** For a queued review or review state check, when a thread reply first went ahead of it. */
  passed_at: number | null;
  /** How often a review read the PR again because GitHub had not computed its mergeability. */
  merge_checks: number;
  /** The queued `Manki` check the Worker created for the review, and the commit it sits on. Null without one, and once it ended. */
  check_id: number | null;
  check_head: string | null;
  /**
   * The `external_id` the check was created with, stored before the create. With `check_id` null, GitHub may hold a
   * check whose create reply never arrived.
   */
  check_ref: string | null;
  /** 1 once a run that reports in a check of its own started, so the waiting check ends at once. */
  check_own: number;
}

/** The waiting `Manki` check of a review, as `/token` names it to the review's run. */
export interface WaitingCheck {
  id: number;
  head_sha: string;
}

interface CheckReport {
  conclusion: string;
  title: string;
  summary: string;
}

/** The fields of `GET /repos/{owner}/{repo}/pulls/{number}` a review start reads. */
interface IssueCommentRead {
  body?: string;
  created_at?: string;
  user?: { login?: string } | null;
}

interface PullRequestRead {
  state: string;
  draft?: boolean;
  html_url?: string;
  /** Null while GitHub has not computed it yet. */
  mergeable?: boolean | null;
  mergeable_state?: string;
  labels?: Array<{ name: string }>;
  user?: { login?: string } | null;
  head: { sha: string; ref: string; repo?: { id?: number } | null };
  base: { ref: string };
}

/** An entry of GitHub's list of the pull requests of a commit. */
interface HeadPull {
  number: number;
  state: string;
  head: { sha: string; repo?: { id?: number } | null };
}

function isHeadPull(pull: unknown): pull is HeadPull {
  const { number, state, head } = (pull ?? {}) as Partial<HeadPull>;
  return Number.isInteger(number) && typeof state === 'string' && typeof head?.sha === 'string';
}

/** The opt-in result as cached, with the repository as GitHub names it when it was read. */
type CachedOptIn = OptIn & {
  expires: number;
  repository: Repository | null;
  /** Whether the registry holds that the repository's runs take over a waiting check. Unknown counts as false. */
  takesOverCheck?: boolean;
};

/** A delivery's id and the SHA-256 of its raw body. A delivery is a replay when either was seen before. */
export interface Delivery {
  id: string;
  /** Null for a body that can repeat in a genuine delivery, which only its id identifies. */
  bodyHash: string | null;
}

/** A comment `receive` queued a command or a thread reply from, waiting for its eyes reaction. `pulls` names a review comment. */
interface PendingReaction {
  comments: 'issues' | 'pulls';
  commentId: number;
  /** Mirrors `Work.repliesTo`. The reaction is added only when that comment starts one of Manki's threads. */
  repliesTo?: number;
}

/** Returns the GitHub calls a reaction takes. A reply costs the read of the comment it answers and the reaction, a command the reaction alone. */
function reactionCost(reaction: PendingReaction): number {
  return reaction.repliesTo === undefined ? 1 : 2;
}

export type ReceiveResult = { accepted: false; reason: string } | { accepted: true; effect: string };

/** What the PR's runs reported, as stored. Times are in milliseconds. */
interface ReportedState {
  last_reviewed: { commit: string; run_id: number; at: number } | null;
  last_approval: { commit: string; held: boolean; run_id: number; at: number } | null;
  /** The automatic pause the Action decided from the round history, such as the round cap. */
  pause: { reason: string; at: number } | null;
  /** What a writer set with the settings boxes. Only Pause stays set, the other boxes ask for one review each. */
  settings: { paused: boolean };
}

const EMPTY_STATE: ReportedState = {
  last_reviewed: null,
  last_approval: null,
  pause: null,
  settings: { paused: false },
};

/** What a run of the PR reports. A field left out keeps its value, and `pause: null` lifts the pause. */
export interface StateReport {
  reviewed?: { commit: string };
  approval?: { commit: string; held: boolean };
  pause?: { reason: string } | null;
}

/** The PR's running state as `/state` returns it. Times are ISO strings. */
export interface PrState {
  active: Array<{
    lane: Lane; run_id: number | null; kind: Work['kind']; event: string; head_sha: string | null; dispatched_at: string | null; modes: ReviewMode[];
  }>;
  queue: Array<{ lane: Lane; kind: Work['kind']; event: string; head_sha: string | null; enqueued_at: string; modes: ReviewMode[] }>;
  last_reviewed: { commit: string; run_id: number; at: string } | null;
  last_approval: { commit: string; held: boolean; run_id: number; at: string } | null;
  pause: { reason: string; at: string } | null;
  settings: { paused: boolean };
}

export type ReportResult = { accepted: false; reason: string } | { accepted: true; changed: string[] };

const iso = (at: number) => new Date(at).toISOString();

/** A settings edit as stored: the boxes it changed and the comment's edit time in milliseconds. */
interface SettingsEdit {
  at: number;
  changes: BoxChange[];
}

const editOf = (row: WorkRow): SettingsEdit => JSON.parse(row.boxes ?? '{"at":0,"changes":[]}') as SettingsEdit;

const modesOf = (row: WorkRow): ReviewMode[] => (row.modes === null ? [] : JSON.parse(row.modes) as ReviewMode[]);

// GitHub lists a PR's comments oldest first, so only `last` reaches the newest on a busy PR. Anyone can comment, so
// the query leaves out the bodies, which can each hold 64 KB.
const RECENT_COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { comments(last: 100) { nodes { fullDatabaseId createdAt author { login } } } }
  }
}`;

interface RecentCommentsResponse {
  repository: {
    pullRequest: { comments: { nodes: Array<{ fullDatabaseId: string | null; createdAt: string; author: { login: string } | null }> } } | null;
  } | null;
}

/** How many of Manki's newest comments are read to find the one sought, since answers and notes can follow it. */
const MANKI_COMMENT_READS = 5;

/**
 * Whether the review comment `id` starts one of Manki's threads, as the reply run decides it, and stricter: Manki
 * wrote it, it carries Manki's marker, and it answers no other comment. Throws when the comment cannot be read.
 */
async function startsMankiThread(token: string, target: Target, id: number): Promise<boolean> {
  const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/pulls/comments/${id}`);
  if (!response.ok) throw new Error(`reading review comment ${id} failed with ${response.status}`);
  const { body, user, in_reply_to_id } = await response.json() as { body?: string; user?: { login?: string } | null; in_reply_to_id?: number };
  return MANKI_LOGINS.includes(user?.login ?? '') && (body ?? '').includes(MANKI_COMMENT_MARKER) && !in_reply_to_id;
}

/** Returns why a push waits out the pause, from the reported `reason` and the Pause box, and what reviews it. */
function pausedSummary(reason: string | null, paused: boolean): string {
  const box = paused ? ' by the **Pause automatic reviews** box' : '';
  // While the Action's pause holds, unticking Pause alone reviews nothing.
  const how = paused && reason === null ? 'Tick **Review again** or untick **Pause automatic reviews**' : 'Tick **Review again**';
  return `${reason ? `${reason} ` : ''}Automatic review is paused${box}, so this commit waits. ${how} on Manki's settings comment to review it.`;
}

// Each entry runs once, in order. Append new entries; never edit a shipped one.
export const MIGRATIONS = [
  `CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
   CREATE TABLE work (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     lane TEXT NOT NULL,
     kind TEXT NOT NULL,
     event TEXT NOT NULL,
     head_sha TEXT,
     object_id INTEGER,
     sender TEXT NOT NULL,
     delivery TEXT NOT NULL,
     enqueued_at INTEGER NOT NULL,
     status TEXT NOT NULL,
     lease_until INTEGER,
     note TEXT
   );
   CREATE INDEX work_by_lane ON work (lane, status, id);`,
  `ALTER TABLE work ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE work ADD COLUMN first_attempt_at INTEGER;
   ALTER TABLE work ADD COLUMN run_id INTEGER;
   ALTER TABLE work ADD COLUMN dispatched_at INTEGER;
   ALTER TABLE work ADD COLUMN check_at INTEGER;
   ALTER TABLE work ADD COLUMN ended_at INTEGER;
   ALTER TABLE work ADD COLUMN conclusion TEXT;
   ALTER TABLE work ADD COLUMN errors INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX work_by_run ON work (run_id);`,
  `ALTER TABLE work ADD COLUMN trusted INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE work ADD COLUMN requeues INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE work ADD COLUMN workflow TEXT;`,
  `ALTER TABLE work ADD COLUMN writer INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE work ADD COLUMN modes TEXT;
   ALTER TABLE work ADD COLUMN boxes TEXT;`,
  `ALTER TABLE work ADD COLUMN passed_at INTEGER;`,
  `ALTER TABLE work ADD COLUMN merge_checks INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE work ADD COLUMN run_head TEXT;`,
  `ALTER TABLE work ADD COLUMN check_id INTEGER;
   ALTER TABLE work ADD COLUMN check_head TEXT;
   ALTER TABLE work ADD COLUMN check_ref TEXT;
   ALTER TABLE work ADD COLUMN check_own INTEGER NOT NULL DEFAULT 0;`,
];

const ACTIVE = `status IN ('dispatching', 'running')`;
/** A waiting check to end: its review ended, or its run reports in a check of its own. */
const CHECK_TO_END = `check_ref IS NOT NULL AND (check_own = 1 OR NOT (status = 'queued' OR ${ACTIVE}))`;
/** The event of a review command in a new comment. A settings box review is always an edit, so it never has this event. */
const REVIEW_COMMAND_EVENT = 'issue_comment.created';
/** The event of a PR marked ready for review. */
const READY_EVENT = 'pull_request.ready_for_review';
/** The event the approval check of a PR marked ready is dispatched as. Manki answers it with its approval check and starts no review for it. */
const APPROVAL_CHECK_EVENT = 'pull_request.approval_check';

/**
 * Returns how a waiting check ends once the review of `item` will not complete it. `status` is the check's own, and
 * `superseded` whether the PR's head left the check's commit. No report passes a required check.
 */
function waitingCheckEnd(item: WorkRow, status: string, superseded: boolean): CheckReport {
  const sha = `\`${item.check_head?.slice(0, 7)}\``;
  const failed = item.conclusion === 'failure' ? 'failure' : 'cancelled';
  if (item.check_own && item.status === 'running') {
    return { conclusion: 'cancelled', title: 'Review run started', summary: 'The review reports in a `Manki` check of its own.' };
  }
  if (superseded) {
    return { conclusion: 'cancelled', title: 'Superseded by a newer commit', summary: `${sha} is no longer the head of this pull request, so it was not reviewed. Manki reviews the new head.` };
  }
  if (status !== 'queued') return { conclusion: failed, title: 'Review stopped', summary: 'The run ended before the review finished.' };
  if (item.status === 'failed') {
    return { conclusion: 'failure', title: 'Review could not start', summary: `Manki could not start the review run of ${sha}: ${item.note}.` };
  }
  if (item.status === 'timed_out') {
    return { conclusion: 'timed_out', title: 'Review timed out', summary: `Manki stopped the review run of ${sha}: ${item.note}.` };
  }
  if (item.status === 'done') {
    return {
      conclusion: failed,
      title: 'Review did not run',
      summary: `The review run ended without reviewing ${sha}. Tick **Review again** on Manki's settings comment to review it.`,
    };
  }
  return { conclusion: 'cancelled', title: 'Review not started', summary: `Manki did not start the review of ${sha}: ${item.note ?? 'it was dropped'}.` };
}

/** The wait before the next try after `errors` failures in a row: 2, 4, 8, then at most 16 minutes. */
export function backoff(errors: number): number {
  return POLL_MS * 2 ** Math.min(errors, 3);
}

/**
 * Orders the Manki work of one pull request or issue, named `<repository id>:<number>`. Request handlers only touch
 * SQLite, so an acknowledged delivery is durable before GitHub sees the 202. All GitHub I/O happens in `alarm()`.
 */
export class PrCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** The opt-in read in flight, shared by both lanes of one alarm pass. */
  private optInRead: Promise<OptIn> | null = null;
  /** Tokens minted by this instance, by repository and permissions. Kept in memory only, so no token is stored. */
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  /** Whether a login has write access, as last looked up, until the time it is looked up again. */
  private readonly writers = new Map<string, { writer: boolean; until: number }>();

  /** Whether this instance created or upgraded its tables. They are created on first use, not in the constructor. */
  private schemaReady = false;
  /** The calls this instance made since its last alarm started, except the reactions, which have a budget of their own. */
  private calls = 0;
  /** The calls the lanes of the alarm may make, with every token mint and the opt-in read. */
  private laneBudget = SUBREQUEST_LIMIT;
  /** The first lane whose step did not fit the budget of the last alarm, as its place in `LANES`. It goes first in the next. */
  private waitingLane: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  /** Whether the object holds any state. Reading this writes nothing, so an unknown PR gets no storage. */
  private hasState(): boolean {
    return this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray().length > 0;
  }

  /** Whether work is queued or being dispatched. Asking a PR without state creates none. */
  private hasPendingWork(): boolean {
    if (!this.hasState()) return false;
    this.ensureSchema();
    return this.sql.exec(`SELECT 1 FROM work WHERE status IN ('queued', 'dispatching') LIMIT 1`).toArray().length > 0;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.migrate();
    this.schemaReady = true;
  }

  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const applied = Number(this.getMeta<number>('schema_version') ?? 0);
    for (let version = applied; version < MIGRATIONS.length; version++) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(MIGRATIONS[version]);
        this.setMeta('schema_version', version + 1);
      });
    }
  }

  private getMeta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }

  private setMeta(key: string, value: unknown): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  private logFields(): Record<string, unknown> {
    const target = this.getMeta<Target>('target');
    return target ? { repo: `${target.owner}/${target.repo}`, pr: target.number } : {};
  }

  /** Whether the delivery's id or body was seen before. The id header is not signed, so a captured body can come back under a new id. */
  private isReplay(delivery: Delivery): boolean {
    const keys = delivery.bodyHash === null ? [delivery.id] : [delivery.id, `sha256:${delivery.bodyHash}`];
    return this.sql.exec(`SELECT 1 FROM deliveries WHERE id IN (${keys.map(() => '?').join(', ')})`, ...keys).toArray().length > 0;
  }

  private remember(delivery: Delivery, now: number): void {
    this.sql.exec('INSERT INTO deliveries (id, received_at) VALUES (?, ?)', delivery.id, now);
    if (delivery.bodyHash !== null) this.sql.exec('INSERT INTO deliveries (id, received_at) VALUES (?, ?)', `sha256:${delivery.bodyHash}`, now);
  }

  /**
   * Returns why run `runId` may not act for this PR, or null when it may: it must be the run of an item this coordinator
   * dispatched and holds as dispatching or running, from that item's `workflow` on the default branch (`ref`). A run
   * whose dispatch was answered without its id is matched by its `delivery` id and takes the run id.
   */
  async refuseRun(runId: number, delivery: string | null, workflow: string, ref: string): Promise<string | null> {
    if (!this.hasState()) return 'no coordinator state';
    this.ensureSchema();
    const row = this.sql.exec<WorkRow>(
      `SELECT * FROM work WHERE ${ACTIVE} AND (run_id = ? OR (run_id IS NULL AND delivery = ?)) ORDER BY id LIMIT 1`, runId, delivery ?? '',
    ).toArray()[0];
    if (!row) return `run ${runId} is not active on this PR`;
    if (row.workflow !== workflow) return `run ${runId} is not of ${row.workflow}`;
    const branch = this.getMeta<CachedOptIn>('opt_in')?.repository?.defaultBranch ?? this.target().defaultBranch;
    if (ref !== `refs/heads/${branch}`) return `run ${runId} is not on ${branch}`;
    if (row.run_id === null) this.sql.exec('UPDATE work SET run_id = ? WHERE id = ?', runId, row.id);
    return null;
  }

  /**
   * Returns the waiting `Manki` check of the review that run `runId` is, for a run that takes it over. A required check
   * reads the `Manki` check created last on a commit, so the run gets the waiting check only while its verdict there
   * would be the one read (`holdsVerdict`). In every other case the run reports in a check of its own, which is created
   * later, and the waiting check ends before this returns: for a run that does not take it over (`takesOver` false),
   * for a check whose create reply was lost, and once another `Manki` check is on the commit. Throws when GitHub fails
   * to end it, so the run gets no token.
   */
  async handOverCheck(runId: number, takesOver: boolean): Promise<WaitingCheck | null> {
    if (!this.hasState()) return null;
    this.ensureSchema();
    await this.rememberCheckAbility(takesOver);
    const held = () => this.sql.exec<WorkRow>(`SELECT * FROM work WHERE ${ACTIVE} AND run_id = ? AND check_ref IS NOT NULL`, runId).toArray()[0];
    const asked = held();
    if (!asked?.check_head) return null;
    const target = await this.verifiedTarget();
    const token = target && await this.token({ checks: 'write' });
    const handOver = takesOver && target !== null && token !== null && await this.holdsVerdict(asked, target, token, true);
    // The check may have ended or changed during the calls above.
    const row = held();
    if (!row?.check_head) return null;
    const own = !handOver || row.check_id !== asked.check_id;
    this.sql.exec('UPDATE work SET check_own = ? WHERE id = ?', Number(own), row.id);
    if (!own) return { id: row.check_id!, head_sha: row.check_head };
    // The alarm tries again when the call below fails.
    await this.scheduleNext();
    if (target && token) await this.endWaitingCheck({ ...row, check_own: 1 }, target, token);
    else this.forgetCheck(row.id);
    return null;
  }

  /**
   * Whether a verdict written into the waiting check of `item` is the one a required check reads. GitHub reads the
   * `Manki` check created last on a commit, so the waiting check must be the only one of the App there. With `taken`,
   * a check its run already set in progress counts as well, since the run holds it. A failed list counts as no.
   */
  private async holdsVerdict(item: WorkRow, target: Target, token: string, taken = false): Promise<boolean> {
    if (item.check_id === null) return false;
    const path = `/repos/${target.owner}/${target.repo}/commits/${item.check_head}/check-runs?check_name=Manki&app_id=${this.env.APP_ID}&filter=all&per_page=100`;
    const response = await this.api(token, path);
    if (!response.ok) {
      log('coordinator_waiting_check_failed', { ...this.logFields(), work_id: item.id, error: `listing the Manki checks failed with ${response.status}` });
      return false;
    }
    const { total_count, check_runs } = await response.json() as { total_count: number; check_runs: Array<{ id: number; status: string }> };
    const waiting = check_runs.find((run) => run.id === item.check_id);
    return waiting !== undefined && (total_count === 1 || (taken && waiting.status !== 'queued'));
  }

  /**
   * Stores in the registry whether the repository's runs take over a waiting check, when that differs from what this
   * coordinator last read there. A run that does not is believed at once. One that does counts only once the registry
   * holds it, so a failed call leaves the repository without waiting checks.
   */
  private async rememberCheckAbility(takesOver: boolean): Promise<void> {
    const cached = this.getMeta<CachedOptIn>('opt_in');
    if (cached && (cached.takesOverCheck ?? false) === takesOver) return;
    let stored = false;
    try {
      await this.env.RECONCILER.getByName(RECONCILER_NAME).recordCheckAbility(this.target().repositoryId, takesOver);
      stored = true;
    } catch (error) {
      log('coordinator_record_check_ability_error', { ...this.logFields(), error: String(error) });
    }
    if (cached && (stored || !takesOver)) this.setMeta('opt_in', { ...cached, takesOverCheck: takesOver } satisfies CachedOptIn);
  }

  /** Records a routed delivery and queues its work. A delivery whose id or body was seen before is refused. */
  async receive(delivery: Delivery, route: Extract<Route, { type: 'work' | 'close' }>): Promise<ReceiveResult> {
    // A close from before the PR's last reopen is a late redelivery, so it changes nothing. Both times are GitHub's. A
    // merge is never stale, since a merged PR cannot reopen.
    if (route.type === 'close' && !route.merged && route.at > 0 && this.hasState() && route.at < (this.getMeta<number>('reopened_at') ?? 0)) {
      log('coordinator_receive', { ...this.logFields(), delivery: delivery.id, accepted: false, reason: 'close older than the open PR' });
      return { accepted: false, reason: 'close older than the open PR' };
    }
    // A close that neither drops work nor records a merge writes nothing, so closing and reopening in a loop costs no rows.
    if (route.type === 'close' && !route.merged && !this.hasPendingWork()) {
      const recorded = this.hasState() ? this.recordClose(delivery, Date.now()) : 'unchanged';
      const result: ReceiveResult = recorded === 'duplicate'
        ? { accepted: false, reason: 'duplicate delivery' }
        : { accepted: true, effect: 'closed, nothing queued' };
      const { owner, repo, number } = route.target;
      log('coordinator_receive', { repo: `${owner}/${repo}`, pr: number, delivery: delivery.id, ...result });
      if (recorded === 'recorded') await this.scheduleNext();
      return result;
    }
    this.ensureSchema();
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): ReceiveResult => {
      this.sql.exec('DELETE FROM deliveries WHERE received_at < ?', now - DELIVERY_RETENTION_MS);
      if (this.isReplay(delivery)) return { accepted: false, reason: 'duplicate delivery' };
      this.remember(delivery, now);
      this.setMeta('target', route.target);

      if (route.type === 'close') {
        this.setMeta('closed_at', now);
        const dropped = this.sql.exec(
          `UPDATE work SET status = 'dropped', note = 'pull request closed' WHERE status IN ('queued', 'dispatching') RETURNING id`,
        ).toArray().length;
        const merged = route.merged ? `, queued ${this.insert(route.merged, delivery.id, now)}` : '';
        return { accepted: true, effect: `closed, dropped ${dropped}${merged}` };
      }
      this.sql.exec(`DELETE FROM meta WHERE key = 'closed_at'`);
      if (route.work.kind === 'review' && route.work.event.startsWith('pull_request.')) {
        // A review of a draft holds its approval. Once the PR is marked ready, the approval check decides on that review.
        const after = route.work.event === READY_EVENT ? this.approvalCheckAfter(route.work.headSha) : null;
        if (after !== null) {
          const check: Work = { ...route.work, kind: 'review_state', event: APPROVAL_CHECK_EVENT };
          return { accepted: true, effect: this.enqueue(check, delivery.id, now, after) };
        }
        // A late redelivery of the push, after a catch-up already reviews this head, must not review it twice.
        const state = this.reviewState(route.work.headSha);
        if (state !== null) return { accepted: true, effect: 'head already reviewed or under review' };
      }
      // The cron leaves the head of a bot's push alone, whatever becomes of the item.
      if (route.work.kind === 'bot_push') this.setMeta('bot_head', route.work.headSha);
      if ((route.work.acknowledge || route.work.repliesTo !== undefined) && route.work.writer && route.work.objectId !== null) {
        const reaction: PendingReaction = {
          comments: route.work.event.startsWith('pull_request_review_comment.') ? 'pulls' : 'issues',
          commentId: route.work.objectId,
          ...(route.work.repliesTo !== undefined && { repliesTo: route.work.repliesTo }),
        };
        const pending = this.getMeta<PendingReaction[]>('reactions') ?? [];
        if (!pending.some((entry) => entry.comments === reaction.comments && entry.commentId === reaction.commentId)) {
          this.setMeta('reactions', [...pending, reaction]);
        }
      }
      return { accepted: true, effect: this.enqueue(route.work, delivery.id, now) };
    });
    log('coordinator_receive', { ...this.logFields(), delivery: delivery.id, ...result });
    if (result.accepted) await this.ctx.storage.setAlarm(now);
    return result;
  }

  /**
   * Whether a review of `head` ran to success or matched a skip rule (`handled`), or is queued or running (`pending`).
   * Null when neither, also when its run failed, was cancelled or was deleted, so such a head is reviewed again.
   */
  private reviewState(head: string | null): 'handled' | 'pending' | null {
    const rows = this.sql.exec<{ status: WorkStatus; conclusion: string | null }>(
      `SELECT status, conclusion FROM work WHERE kind = 'review' AND head_sha = ?`, head,
    ).toArray();
    const skipped = ['skipped', 'cancelled', 'conflict'];
    if (rows.some((row) => (row.status === 'done' && row.conclusion === 'success') || (row.status === 'skipped' && skipped.includes(row.conclusion ?? '')))) return 'handled';
    if (rows.some((row) => row.status === 'queued' || row.status === 'dispatching' || row.status === 'running')) return 'pending';
    return null;
  }

  /**
   * Says whether a PR marked ready on `head` gets an approval check, and which review the check must wait for. Returns
   * the id of the newest review of `head` that is queued or under way, or 0 when a review run of `head` succeeded and
   * none is under way. Returns null when `head` has neither, so the event is no approval check. A review asked for by
   * a box or a command has no `head_sha`, so `run_head`, the commit its run was started for, counts too.
   */
  private approvalCheckAfter(head: string | null): number | null {
    if (head === null) return null;
    const rows = this.sql.exec<{ id: number; status: WorkStatus; conclusion: string | null }>(
      `SELECT id, status, conclusion FROM work WHERE kind = 'review' AND (head_sha = ? OR run_head = ?) ORDER BY id`, head, head,
    ).toArray();
    const pending = rows.filter((row) => row.status === 'queued' || row.status === 'dispatching' || row.status === 'running').at(-1);
    if (pending) return pending.id;
    return rows.some((row) => row.status === 'done' && row.conclusion === 'success') ? 0 : null;
  }

  /** Returns the PR's running state. Writes nothing, so asking about a PR without state creates none. */
  async state(): Promise<PrState> {
    const { last_reviewed: reviewed, last_approval: approval, pause, settings } = this.reported();
    const work = this.hasState() ? this.sql.exec<WorkRow>(`SELECT * FROM work WHERE status = 'queued' OR ${ACTIVE} ORDER BY id`).toArray() : [];
    return {
      active: work.filter((row) => row.status !== 'queued').map((row) => ({
        lane: row.lane, run_id: row.run_id, kind: row.kind, event: row.event, head_sha: row.head_sha,
        dispatched_at: row.dispatched_at === null ? null : iso(row.dispatched_at), modes: modesOf(row),
      })),
      queue: work.filter((row) => row.status === 'queued').map((row) => ({
        lane: row.lane, kind: row.kind, event: row.event, head_sha: row.head_sha, enqueued_at: iso(row.enqueued_at), modes: modesOf(row),
      })),
      last_reviewed: reviewed && { ...reviewed, at: iso(reviewed.at) },
      last_approval: approval && { ...approval, at: iso(approval.at) },
      pause: pause && { ...pause, at: iso(pause.at) },
      settings,
    };
  }

  /**
   * Stores what run `runId` reports about the PR. Only a run this coordinator dispatched and still tracks as dispatching
   * or running may report. A report that changes nothing writes nothing.
   */
  async report(runId: number, report: StateReport): Promise<ReportResult> {
    const active = this.hasState()
      && this.sql.exec(`SELECT 1 FROM work WHERE run_id = ? AND ${ACTIVE}`, runId).toArray().length > 0;
    if (!active) return { accepted: false, reason: `run ${runId} is not active on this PR` };
    const now = Date.now();
    const state = this.reported();
    const changed: string[] = [];
    const { reviewed, approval, pause } = report;
    if (reviewed && (state.last_reviewed?.commit !== reviewed.commit || state.last_reviewed.run_id !== runId)) {
      state.last_reviewed = { commit: reviewed.commit, run_id: runId, at: now };
      changed.push('reviewed');
    }
    const lastApproval = state.last_approval;
    if (approval && (lastApproval?.commit !== approval.commit || lastApproval.held !== approval.held || lastApproval.run_id !== runId)) {
      state.last_approval = { commit: approval.commit, held: approval.held, run_id: runId, at: now };
      changed.push('approval');
    }
    if (pause !== undefined && (state.pause?.reason ?? null) !== (pause?.reason ?? null)) {
      state.pause = pause && { reason: pause.reason, at: now };
      changed.push('pause');
    }
    if (changed.length > 0) this.setMeta('pr_state', state);
    return { accepted: true, changed };
  }

  private reported(): ReportedState {
    let stored: Partial<ReportedState> | null = null;
    if (this.hasState()) {
      this.ensureSchema();
      stored = this.getMeta<Partial<ReportedState>>('pr_state');
    }
    return { ...EMPTY_STATE, ...stored, settings: { ...EMPTY_STATE.settings, ...stored?.settings } };
  }

  /**
   * Where `head` stands for the cron. It is `handled` once a review run of it succeeded, it matched a skip rule or a bot
   * pushed it, `pending` while a review is queued or running, and `needed` otherwise, also when that review was dropped,
   * failed or skipped for another reason, such as dispatch being off.
   * Writes nothing, so asking about a PR without state creates none.
   */
  async catchUpState(head: string): Promise<'needed' | 'pending' | 'handled'> {
    if (!this.hasState()) return 'needed';
    this.ensureSchema();
    if (this.getMeta<string>('bot_head') === head) return 'handled';
    return this.reviewState(head) ?? 'needed';
  }

  /**
   * Queues a review of `head`, which the cron found without a Manki review, as if its push had arrived. It is stored
   * like a delivery, so the coordinator keeps its state for the usual retention.
   */
  async catchUp(target: Target, head: string): Promise<ReceiveResult> {
    if ((await this.catchUpState(head)) !== 'needed') return { accepted: false, reason: 'head already handled' };
    this.ensureSchema();
    const now = Date.now();
    const delivery = `catch-up-${head.slice(0, 12)}`;
    // The head is a same-repository push, which the webhook path trusts too.
    const work: Work = { lane: 'state', kind: 'review', event: 'pull_request.synchronize', headSha: head, objectId: null, sender: '', trusted: true, acknowledge: false, writer: true };
    const effect = this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT OR REPLACE INTO deliveries (id, received_at) VALUES (?, ?)', delivery, now);
      this.sql.exec(`DELETE FROM meta WHERE key = 'closed_at'`);
      this.setMeta('target', target);
      return this.enqueue(work, delivery, now);
    });
    await this.ctx.storage.setAlarm(now);
    return { accepted: true, effect };
  }

  private insert(work: Work, delivery: string, now: number): string {
    const id = this.sql.exec<{ id: number }>(
      `INSERT INTO work (lane, kind, event, head_sha, object_id, sender, delivery, enqueued_at, status, trusted, writer, modes, boxes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) RETURNING id`,
      work.lane, work.kind, work.event, work.headSha, work.objectId, work.sender, delivery, now, Number(work.trusted), Number(work.writer),
      work.modes?.length ? JSON.stringify(work.modes) : null,
      work.boxes ? JSON.stringify({ at: work.editedAt ?? 0, changes: work.boxes } satisfies SettingsEdit) : null,
    ).one().id;
    return `work ${id}`;
  }

  private queued(lane: Lane, kinds: Work['kind'][]): WorkRow[] {
    return this.sql.exec<WorkRow>(
      `SELECT * FROM work WHERE lane = ? AND status = 'queued' AND kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY id`,
      lane, ...kinds,
    ).toArray();
  }

  /**
   * Queues `work`, merging it with what is already queued where one run covers both. A review state check joins only a
   * check queued after work `after`. Such a check runs after that work has ended: the lane starts its oldest queued
   * item, only a thread reply goes ahead of an older item, and nothing starts while an item is under way.
   */
  private enqueue(work: Work, delivery: string, now: number, after = 0): string {
    if (work.event === 'issue_comment.edited' && work.objectId !== null && work.kind !== 'settings') {
      // The run reads the comment as it is then, so one queued item covers every edit of the comment. A settings edit
      // carries its own box changes, so each one is applied.
      const [same] = this.sql.exec<{ id: number }>(
        `SELECT id FROM work WHERE status = 'queued' AND lane = ? AND kind = ? AND object_id = ? AND trusted = ? AND event LIKE 'issue_comment.%'`,
        work.lane, work.kind, work.objectId, Number(work.trusted),
      ).toArray();
      if (same) {
        this.sql.exec(
          'UPDATE work SET event = ?, sender = ?, delivery = ?, writer = ? WHERE id = ?',
          work.event, work.sender, delivery, Number(work.writer), same.id,
        );
        return `merged into work ${same.id}`;
      }
    }

    if (work.kind === 'review') {
      // A request whose sender may lack write access can neither take over a push review nor take on its head, since
      // the sender's lookup can still drop it.
      if (!work.writer) return `queued ${this.insert(work, delivery, now)}`;
      const reviews = this.queued('state', ['review']).filter((row) => row.writer);
      const review = reviews.at(-1);
      if (!review) return `queued ${this.insert(work, delivery, now)}`;
      const isPush = work.event.startsWith('pull_request.');
      const queuedPush = review.event.startsWith('pull_request.');
      if (isPush && queuedPush) {
        this.sql.exec(
          'UPDATE work SET event = ?, head_sha = ?, sender = ?, delivery = ?, enqueued_at = ? WHERE id = ?',
          work.event, work.headSha, work.sender, delivery, now, review.id,
        );
      } else if (isPush) {
        // A comment-triggered review keeps its trigger and reviews the newest head.
        this.sql.exec('UPDATE work SET head_sha = ?, enqueued_at = ? WHERE id = ?', work.headSha, now, review.id);
      } else if (queuedPush) {
        // A review request takes over the queued push review and keeps its place.
        this.sql.exec(
          'UPDATE work SET event = ?, head_sha = COALESCE(?, head_sha), object_id = ?, sender = ?, delivery = ? WHERE id = ?',
          work.event, work.headSha, work.objectId, work.sender, delivery, review.id,
        );
      } else if (work.event === REVIEW_COMMAND_EVENT) {
        // Manki reads the head when the run starts, so a queued review command answers every later one. The item names the
        // newest command, so an edit or a delete of an earlier one cannot leave the later request without a run. An item
        // with a dispatch attempt keeps its delivery id, which `findRun` looks for in the run title.
        const command = reviews.filter((row) => row.event === REVIEW_COMMAND_EVENT && row.attempts === 0).at(-1);
        if (!command) return `queued ${this.insert(work, delivery, now)}`;
        this.sql.exec('UPDATE work SET object_id = ?, sender = ?, delivery = ? WHERE id = ?', work.objectId, work.sender, delivery, command.id);
        return `merged into work ${command.id}`;
      } else {
        // Each tick, and each review request made by an edit, is answered on its own, so one never hides another.
        return `queued ${this.insert(work, delivery, now)}`;
      }
      return `merged into work ${review.id}`;
    }

    if (work.kind === 'review_state') {
      // The check reads the PR when it runs, so one queued check covers every review and thread change before it.
      // Manki runs the approval check of a PR marked ready only on the head it names, so it covers no other head's change.
      const [check] = this.queued('state', ['review_state'])
        .filter((row) => row.id > after && (row.event !== APPROVAL_CHECK_EVENT || row.head_sha === work.headSha));
      if (check) {
        // A review carries the id the dispatch names, so it replaces the queued trigger. An outsider's review never
        // replaces a trusted trigger. The sender of a trigger not known as a writer's is looked up before the check
        // starts, so a writer's work always takes it over, and a review that may lack write access never replaces a
        // writer's. Trusted work makes the check trusted.
        const review = work.event.startsWith('pull_request_review.');
        if ((review && (work.trusted || !check.trusted) && (work.writer || !check.writer)) || (work.writer && !check.writer)) {
          this.sql.exec(
            `UPDATE work SET event = ?, head_sha = ?, object_id = ?, sender = ?, delivery = ?, trusted = MAX(trusted, ?), writer = MAX(writer, ?)
             WHERE id = ?`,
            work.event, work.headSha, work.objectId, work.sender, delivery, Number(work.trusted), Number(work.writer), check.id,
          );
        } else if (work.trusted && !check.trusted) {
          this.sql.exec('UPDATE work SET trusted = 1 WHERE id = ?', check.id);
        }
        return `merged into work ${check.id}`;
      }
    }
    return `queued ${this.insert(work, delivery, now)}`;
  }

  override async alarm(): Promise<void> {
    this.ensureSchema();
    try {
      if (await this.cleanUpWhenIdle()) return;
      this.calls = 0;
      // The reactions run next to the lanes, so the calls they can make are kept out of the lanes' share.
      const reactions = this.getMeta<PendingReaction[]>('reactions') ?? [];
      const reactionCalls = reactions.reduce((sum, reaction) => sum + reactionCost(reaction), 0);
      this.laneBudget = SUBREQUEST_LIMIT - (reactions.length > 0 ? Math.min(reactionCalls, REACTION_BUDGET) + REACTION_MINTS : 0);
      // Both read the opt-in through `optIn`, which shares one read between them.
      await Promise.all([this.react(), this.advance()]);
    } catch (error) {
      log('coordinator_alarm_error', { ...this.logFields(), error: String(error) });
    }
    await this.scheduleNext();
  }

  /**
   * Adds the eyes reaction to each comment `receive` queued a command or a reply in one of Manki's threads from, so
   * the commenter sees it was received before the run starts. Only a repository that takes dispatches gets one. A
   * failure is logged and never retried. The comments past `REACTION_BUDGET` wait for the next alarm.
   */
  private async react(): Promise<void> {
    const pending = this.getMeta<PendingReaction[]>('reactions');
    if (!pending) return;
    this.sql.exec(`DELETE FROM meta WHERE key = 'reactions'`);
    let target: Target | null;
    try {
      if (this.env.DISPATCH_ENABLED !== 'true' || !(await this.optIn()).optedIn) return;
      target = await this.verifiedTarget();
    } catch (error) {
      log('coordinator_reaction_error', { ...this.logFields(), error: String(error) });
      return;
    }
    if (!target) return;
    let calls = 0;
    const cut = pending.findIndex((reaction) => (calls += reactionCost(reaction)) > REACTION_BUDGET);
    const waiting = cut < 0 ? [] : pending.splice(cut);
    // `receive` may have queued comments during the reads above. They go after the ones that waited longer.
    if (waiting.length > 0) this.setMeta('reactions', [...waiting, ...(this.getMeta<PendingReaction[]>('reactions') ?? [])]);
    for (const { comments, commentId, repliesTo } of pending) {
      try {
        // A comment on a pull request needs `pull_requests: write` to take a reaction, one on a plain issue `issues: write`.
        const token = await this.token(comments === 'pulls' ? { pull_requests: 'write' } : { issues: 'write', pull_requests: 'write' });
        if (token === null) continue;
        if (repliesTo !== undefined && !(await startsMankiThread(token, target, repliesTo))) continue;
        const path = `/repos/${target.owner}/${target.repo}/${comments}/comments/${commentId}/reactions`;
        const response = await githubApi(token, path, { method: 'POST', body: { content: 'eyes' } });
        if (!response.ok) log('coordinator_reaction_failed', { ...this.logFields(), comment_id: commentId, status: response.status });
      } catch (error) {
        log('coordinator_reaction_error', { ...this.logFields(), comment_id: commentId, error: String(error) });
      }
    }
  }

  /**
   * Records a reopen at `at`, GitHub's time, and clears the PR's recorded close, so its state is kept as for an open PR
   * and a close redelivered later changes nothing. A PR without state gets some too, since its close stored nothing.
   */
  async reopen(delivery: Delivery, target: Target, at: number): Promise<void> {
    this.ensureSchema();
    const cleared = this.ctx.storage.transactionSync(() => {
      if (this.isReplay(delivery)) return null;
      this.remember(delivery, Date.now());
      this.setMeta('target', target);
      if (at > (this.getMeta<number>('reopened_at') ?? 0)) this.setMeta('reopened_at', at);
      return this.sql.exec(`DELETE FROM meta WHERE key = 'closed_at' RETURNING key`).toArray().length > 0;
    });
    if (cleared === null) return;
    if (cleared) log('coordinator_reopened', this.logFields());
    await this.scheduleNext();
  }

  /** Whether an item is queued, dispatching or running. */
  private hasUnfinishedWork(): boolean {
    return this.sql.exec(`SELECT 1 FROM work WHERE status = 'queued' OR ${ACTIVE}`).toArray().length > 0;
  }

  /**
   * Records the PR's close and its delivery, so a redelivered close cannot mark the PR closed again after a reopen.
   * Writes nothing when the delivery was seen or a close is recorded already.
   */
  private recordClose(delivery: Delivery, now: number): 'recorded' | 'duplicate' | 'unchanged' {
    this.ensureSchema();
    return this.ctx.storage.transactionSync(() => {
      if (this.isReplay(delivery)) return 'duplicate';
      if (this.getMeta<number>('closed_at') !== null) return 'unchanged';
      this.remember(delivery, now);
      this.setMeta('closed_at', now);
      return 'recorded';
    });
  }

  /**
   * Returns when the storage may go: a week after the PR closed, or `IDLE_RETENTION_MS` after the last delivery of a PR
   * still open. A reopen or work queued after the close clears the close. Null when there is neither.
   */
  private retainUntil(): number | null {
    const closedAt = this.getMeta<number>('closed_at');
    if (closedAt !== null) return closedAt + DELIVERY_RETENTION_MS;
    const newest = this.sql.exec<{ at: number | null }>('SELECT MAX(received_at) AS at FROM deliveries').one().at;
    return newest === null ? null : newest + IDLE_RETENTION_MS;
  }

  /** Deletes all storage once nothing is queued, dispatching or running and the retention ran out. */
  private async cleanUpWhenIdle(): Promise<boolean> {
    const pending = this.hasUnfinishedWork();
    const until = this.retainUntil();
    if (pending || (until !== null && Date.now() < until)) return false;
    log('coordinator_deleted', this.logFields());
    await this.ctx.storage.deleteAll();
    // The instance can stay in memory, so the next delivery must create the tables again.
    this.schemaReady = false;
    return true;
  }

  private async advance(): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `DELETE FROM work WHERE status NOT IN ('queued', 'dispatching', 'running') AND enqueued_at < ?`,
      now - FINISHED_RETENTION_MS,
    );
    this.sql.exec(
      `UPDATE work SET status = 'dropped', note = 'queued too long' WHERE status = 'queued' AND enqueued_at < ?`,
      now - QUEUED_MAX_AGE_MS,
    );
    this.sql.exec(`UPDATE work SET status = 'queued', lease_until = NULL WHERE status = 'dispatching' AND lease_until <= ?`, now);
    // The lanes go one after another, so each step sees what the ones before it spent. The lane that waited goes first.
    const first = this.waitingLane ?? 0;
    this.waitingLane = null;
    for (const lane of [...LANES.slice(first), ...LANES.slice(0, first)]) {
      try {
        if (!(await this.advanceLane(lane, now))) this.waitingLane ??= LANES.indexOf(lane);
      } catch (error) {
        log('coordinator_lane_error', { ...this.logFields(), lane, error: String(error) });
      }
    }
    // A review that ended in this pass has its waiting check ended at once.
    if (this.checksToEnd().length === 0) return;
    if (this.fits(STEP_COST)) await this.endWaitingChecks();
    else this.waitingLane ??= LANES.indexOf('state');
  }

  /** Whether `cost` more calls fit in what the lanes of this alarm may still make. */
  private fits(cost: number): boolean {
    return this.calls + cost <= this.laneBudget;
  }

  /**
   * Polls the lane's run when it is due, and starts its next item once the lane is free. Each step runs only when its
   * costliest path fits the alarm's budget. Returns false when a step has to wait for the next alarm.
   */
  private async advanceLane(lane: Lane, now: number): Promise<boolean> {
    const running = this.sql.exec<WorkRow>(`SELECT * FROM work WHERE lane = ? AND status = 'running'`, lane).toArray()[0];
    if (running && (running.check_at ?? 0) <= now) {
      if (!this.fits(STEP_COST)) return false;
      await this.poll(running);
    }
    if (this.sql.exec(`SELECT 1 FROM work WHERE lane = ? AND ${ACTIVE}`, lane).toArray().length > 0) return true;
    // The next run can create a `Manki` check, and none may appear on a head while a waiting check is open there.
    if (lane === 'state' && this.checksToEnd().length > 0) {
      if (!this.fits(STEP_COST)) return false;
      if (!(await this.endWaitingChecks())) return true;
    }
    const next = this.nextQueued(lane);
    // A queued item's `check_at` holds it until the dispatch cap allows another run.
    if (!next || (next.check_at ?? 0) > now) return true;
    if (!this.fits(LIGHT_KINDS.has(next.kind) ? LIGHT_COST : STEP_COST)) return false;
    if (next.kind === 'thread') {
      this.sql.exec(
        `UPDATE work SET passed_at = ? WHERE lane = ? AND status = 'queued' AND kind IN ('review', 'review_state') AND id < ? AND passed_at IS NULL`,
        now, lane, next.id,
      );
    }
    await this.start(next);
    return true;
  }

  /**
   * Returns the item a lane starts next: the oldest queued one, except that a queued thread reply goes before a review
   * and before a review state check. The review then sees each thread as the reply leaves it, instead of requesting
   * changes the reply withdraws a minute later. The check reads the PR when it runs, so it loses nothing, and a person
   * waits for the reply. Once replies have gone ahead of a review or a check for `REPLY_FIRST_MS`, it goes first again,
   * so a stream of replies cannot hold it back. Time spent waiting behind a run does not count. A review that holds a
   * waiting check lets no reply go first. The reply's approval would create a newer `Manki` check on that head, and a
   * required check reads the check created last, so the review's verdict in the waiting check would not count.
   */
  private nextQueued(lane: Lane): WorkRow | undefined {
    const next = this.sql.exec<WorkRow>(`SELECT * FROM work WHERE lane = ? AND status = 'queued' ORDER BY id LIMIT 1`, lane).toArray()[0];
    const yields = (next?.kind === 'review' && next.check_ref === null) || next?.kind === 'review_state';
    if (!next || !yields || (next.passed_at !== null && Date.now() - next.passed_at >= REPLY_FIRST_MS)) return next;
    return this.sql.exec<WorkRow>(`SELECT * FROM work WHERE lane = ? AND status = 'queued' AND kind = 'thread' ORDER BY id LIMIT 1`, lane).toArray()[0] ?? next;
  }

  private row(id: number): WorkRow | undefined {
    return this.sql.exec<WorkRow>('SELECT * FROM work WHERE id = ?', id).toArray()[0];
  }

  private isDispatching(id: number): boolean {
    return this.row(id)?.status === 'dispatching';
  }

  private finish(id: number, status: WorkStatus, note: string, conclusion: string | null = null): void {
    this.sql.exec(
      'UPDATE work SET status = ?, note = ?, conclusion = ?, lease_until = NULL, check_at = NULL, ended_at = ? WHERE id = ?',
      status, note, conclusion, Date.now(), id,
    );
    log('coordinator_finished', { ...this.logFields(), work_id: id, status, note, conclusion });
  }

  private target(): Target {
    const target = this.getMeta<Target>('target');
    if (!target) throw new Error('no target recorded');
    return target;
  }

  /** Calls the GitHub REST API and counts the call against the alarm's budget. */
  private api(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
    this.calls++;
    return githubApi(token, path, init);
  }

  /** Mints a token for this repository alone, or reuses one this instance minted that is not about to expire. */
  private async mint(permissions: Permissions): Promise<MintResult> {
    const target = this.target();
    const key = JSON.stringify([target.installationId, target.repositoryId, Object.entries(permissions).sort()]);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return { ok: true, ...cached };
    this.calls++;
    const mint = await mintRepositoryToken(this.env, target.installationId, target.repositoryId, permissions, {
      purpose: 'coordinator',
      repository: `${target.owner}/${target.repo}`,
    });
    if (mint.ok) this.tokens.set(key, { token: mint.token, expiresAt: mint.expiresAt });
    return mint;
  }

  /**
   * Returns a token for this repository alone. Returns null when GitHub refuses, which it does for an ungranted
   * permission. Throws on any other failure, so the caller retries after its backoff.
   */
  private async token(permissions: Permissions): Promise<string | null> {
    const mint = await this.mint(permissions);
    if (mint.ok) return mint.token;
    log('coordinator_token_failed', { ...this.logFields(), permissions, status: mint.status, refused: mint.refused, message: mint.message });
    if (!mint.refused) throw new Error(`token mint failed with ${mint.status}`);
    return null;
  }

  /**
   * Returns the target with the owner, name and default branch GitHub gives for its repository id. Returns null when
   * GitHub refused to show the repository.
   */
  private async verifiedTarget(): Promise<Target | null> {
    await this.optIn();
    const repository = this.getMeta<CachedOptIn>('opt_in')?.repository;
    return repository ? { ...this.target(), ...repository } : null;
  }

  private async start(item: WorkRow): Promise<void> {
    this.sql.exec(`UPDATE work SET status = 'dispatching', lease_until = ? WHERE id = ?`, Date.now() + LEASE_MS, item.id);
    try {
      const optIn = await this.optIn();
      // A close may have dropped the item while the opt-in was read.
      if (!this.isDispatching(item.id)) return;
      if (this.env.DISPATCH_ENABLED !== 'true') {
        log('coordinator_would_dispatch', { ...this.logFields(), ...this.describe(item), opted_in: optIn.optedIn, opt_in_reason: optIn.reason });
        this.finish(item.id, 'skipped', 'dispatch is not enabled');
        return;
      }
      if (!optIn.optedIn) {
        this.finish(item.id, 'skipped', `not opted in: ${optIn.reason}`);
        return;
      }
      if (!(await this.senderMayAsk(item))) {
        if (item.kind === 'settings') await this.revertBoxes(item);
        if (this.isDispatching(item.id)) this.finish(item.id, 'skipped', 'commenter has no write access');
        return;
      }
      if (!this.isDispatching(item.id)) return;
      if (item.kind === 'settings') {
        await this.applySettings(item);
        return;
      }
      if (item.kind === 'bot_push') {
        await this.skipBotPush(item);
        return;
      }
      if (this.capped(item)) return;
      if (item.kind === 'help') await this.answerHelp(item);
      else await this.dispatch(item, optIn.workflow);
    } catch (error) {
      const retryAt = Date.now() + backoff(item.errors);
      // An item with no dispatch attempt waits in the queue, so a newer push merges into it instead of queueing behind it.
      this.sql.exec(
        `UPDATE work SET status = 'queued', lease_until = NULL, check_at = ?, errors = errors + 1 WHERE id = ? AND status = 'dispatching' AND attempts = 0`,
        retryAt, item.id,
      );
      // One with an attempt keeps its delivery id, which `findRun` looks for, so it waits out its lease instead.
      this.sql.exec(
        `UPDATE work SET lease_until = ?, errors = errors + 1 WHERE id = ? AND status = 'dispatching'`,
        retryAt, item.id,
      );
      log('coordinator_start_error', { ...this.logFields(), work_id: item.id, error: String(error) });
    }
  }

  /**
   * Applies the hourly dispatch cap of the item's lane, counted apart for trusted and untrusted work. A trusted
   * review or merge over the cap is held until the hour allows another run. Any other item is dropped. Returns
   * whether the item was held or dropped.
   */
  private capped(item: WorkRow): boolean {
    const cap = item.trusted ? DISPATCHES_PER_HOUR : UNTRUSTED_DISPATCHES_PER_HOUR;
    const recent = this.sql.exec<{ at: number }>(
      'SELECT dispatched_at AS at FROM work WHERE lane = ? AND trusted = ? AND dispatched_at > ? ORDER BY dispatched_at DESC LIMIT ?',
      item.lane, item.trusted, Date.now() - HOUR, cap,
    ).toArray();
    if (recent.length < cap) return false;
    if (item.trusted && (item.kind === 'review' || item.kind === 'merged')) {
      // The oldest of the newest `cap` runs leaving the hour is what brings the count under the cap.
      const until = recent[cap - 1].at + HOUR;
      this.sql.exec(`UPDATE work SET status = 'queued', lease_until = NULL, check_at = ? WHERE id = ?`, until, item.id);
      log('coordinator_held', { ...this.logFields(), work_id: item.id, until, note: `over ${cap} dispatches in the last hour` });
    } else {
      this.finish(item.id, 'dropped', `over ${cap} dispatches in the last hour`);
    }
    return true;
  }

  private describe(item: WorkRow): Record<string, unknown> {
    return {
      work_id: item.id,
      lane: item.lane,
      kind: item.kind,
      event: item.event,
      head_sha: item.head_sha,
      object_id: item.object_id,
      sender: item.sender,
      delivery: item.delivery,
    };
  }

  /**
   * Starts a run of `workflow` for `item`. Every GitHub call is followed by a fresh read of the row before anything is
   * written.
   */
  private async dispatch(item: WorkRow, workflow: string): Promise<void> {
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const review = item.kind === 'review' ? await this.refreshReview(item, target) : undefined;
    if (review === null) return;

    const current = this.row(item.id);
    if (current?.status !== 'dispatching') return;
    if (current.attempts > 0) {
      // A run that asked `/token` already gave the item its id (`refuseRun`), and `findRun` leaves out every known run.
      const runId = current.run_id ?? await this.findRun(current, target);
      if (!this.isDispatching(item.id)) return;
      if (runId !== null) {
        this.markRunning(current, runId, 'recovered the run of an earlier attempt');
        return;
      }
    }

    const token = await this.token({ actions: 'write' });
    if (!this.isDispatching(item.id)) return;
    if (token === null) {
      log('coordinator_lacks_actions_write', { ...this.logFields(), work_id: item.id });
      this.setMeta('opt_in', {
        optedIn: false,
        reason: 'installation lacks actions: write',
        expires: Date.now() + OPT_IN_TTL_MS,
        repository: { owner: target.owner, ownerId: target.ownerId, repo: target.repo, defaultBranch: target.defaultBranch },
      } satisfies CachedOptIn);
      this.finish(item.id, 'skipped', 'installation lacks actions: write');
      return;
    }

    if (current.kind === 'review') {
      await this.showWaiting(current, target, review?.waitingCheck ?? false).catch((error: unknown) => {
        log('coordinator_waiting_check_failed', { ...this.logFields(), work_id: item.id, error: error instanceof Error ? error.message : String(error) });
      });
      if (!this.isDispatching(item.id)) return;
    }

    const now = Date.now();
    this.sql.exec(
      'UPDATE work SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), workflow = ? WHERE id = ?',
      now, workflow, item.id,
    );
    const attempts = current.attempts + 1;
    let response: Response | null = null;
    try {
      response = await this.api(token, `/repos/${target.owner}/${target.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: 'POST',
        body: { ref: target.defaultBranch, inputs: dispatchInputs(current, target.number), return_run_details: true },
      });
    } catch (error) {
      log('coordinator_dispatch_error', { ...this.logFields(), work_id: item.id, attempts, error: String(error) });
    }
    const latest = this.row(item.id);
    // A run that started is tracked even when a close dropped the item meanwhile, so the lane waits for it.
    const started = response?.status === 200 || response?.status === 204;
    if (!latest || (latest.status !== 'dispatching' && !started)) return;
    const failure = response && !started ? await response.text() : '';

    if (started) {
      const runId = response?.status === 200 ? (await response.json() as { workflow_run_id?: number }).workflow_run_id ?? null : null;
      this.markRunning(latest, runId, runId === null ? 'dispatched without run details' : 'dispatched');
      if (latest.kind === 'review' && modesOf(latest).length > 0) {
        await this.showStarting(latest, target).catch((error: unknown) => {
          log('coordinator_starting_status_failed', { ...this.logFields(), work_id: item.id, error: error instanceof Error ? error.message : String(error) });
        });
      }
    } else if (response === null || response.status >= 500 || response.status === 429 || isRateLimited(response, failure)) {
      if (attempts > DISPATCH_BACKOFF_MS.length) {
        this.finish(item.id, 'failed', `dispatch failed ${attempts} times, last with ${response?.status ?? 'a network error'}`);
      } else {
        this.sql.exec('UPDATE work SET lease_until = ? WHERE id = ?', Date.now() + DISPATCH_BACKOFF_MS[attempts - 1], item.id);
        log('coordinator_dispatch_retry', { ...this.logFields(), work_id: item.id, attempts, status: response?.status ?? null });
      }
    } else if (response.status === 404 && latest.requeues === 0) {
      // The cached opt-in can name a file renamed since, so the item waits for a fresh read once.
      this.sql.exec(`DELETE FROM meta WHERE key = 'opt_in'`);
      this.requeue(item.id, `${workflow} not found`, `${workflow} not found, queued again`);
    } else {
      // 403, 404 and 422 mean the permission, the file or its `workflow_dispatch` trigger is missing.
      this.sql.exec(`DELETE FROM meta WHERE key = 'opt_in'`);
      this.finish(item.id, 'failed', `dispatch refused with ${response.status}: ${failure.slice(0, 200)}`);
    }
  }

  /**
   * Creates the queued `Manki` check that shows a review of `item.run_head` is ordered, while its run waits for a
   * runner. A check the review left behind on an earlier head ends first. A check is created only when all of this is
   * certain: `create` allows it, `WAITING_CHECK_ENABLED` is on, the registry holds that the repository's runs take a
   * waiting check over, and the head has no `Manki` check, since GitHub would read the new check ahead of the verdict
   * the head shows. Throws on a failure.
   */
  private async showWaiting(item: WorkRow, target: Target, create: boolean): Promise<void> {
    const head = item.run_head;
    // A check whose create reply was lost is looked for when its run asks for a token and when the review ends. Until then the review gets no other.
    const lost = item.check_ref !== null && item.check_id === null;
    if (head === null || item.check_head === head || lost) return;
    const wanted = () => create && this.env.WAITING_CHECK_ENABLED === 'true' && this.getMeta<CachedOptIn>('opt_in')?.takesOverCheck === true;
    if (!wanted() && item.check_id === null) return;
    const token = await this.token({ checks: 'write' });
    if (token === null) return;
    const repo = `/repos/${target.owner}/${target.repo}`;
    if (item.check_id !== null) await this.endWaitingCheck(item, target, token, true);
    if (!wanted() || await this.hasMankiCheck(head, target, token)) return;
    const output = {
      title: 'Waiting for a runner',
      summary: `Manki started the review run for \`${head.slice(0, 7)}\`. It begins when GitHub Actions gives the run a runner.`,
    };
    this.sql.exec('UPDATE work SET check_id = NULL, check_head = ?, check_ref = ?, check_own = 0 WHERE id = ?', head, item.delivery, item.id);
    const created = await this.api(token, `${repo}/check-runs`, {
      method: 'POST',
      body: { name: 'Manki', head_sha: head, status: 'queued', external_id: item.delivery, output },
    });
    if (!created.ok) {
      // A refusal created nothing. After any other failure GitHub may hold the check, so `check_ref` stays to find it by.
      if (isRefusal(created, await created.text())) this.forgetCheck(item.id);
      throw new Error(`creating the waiting check failed with ${created.status}`);
    }
    const { id } = await created.json() as { id: number };
    this.sql.exec('UPDATE work SET check_id = ? WHERE id = ?', id, item.id);
  }

  /** Whether `head` holds a `Manki` check of the App, in any state. Throws when GitHub fails to list them. */
  private async hasMankiCheck(head: string, target: Target, token: string): Promise<boolean> {
    const path = `/repos/${target.owner}/${target.repo}/commits/${head}/check-runs?check_name=Manki&app_id=${this.env.APP_ID}&filter=all&per_page=1`;
    const list = await this.api(token, path);
    if (!list.ok) throw new Error(`listing the Manki checks failed with ${list.status}`);
    return ((await list.json()) as { total_count: number }).total_count > 0;
  }

  /** Returns the reviews whose waiting check is still to end. */
  private checksToEnd(): WorkRow[] {
    return this.sql.exec<WorkRow>(`SELECT * FROM work WHERE ${CHECK_TO_END}`).toArray();
  }

  /**
   * Ends every waiting check whose review ended or whose run reports in a check of its own. A failure is logged and
   * tried again. Returns whether none is left to end.
   */
  private async endWaitingChecks(): Promise<boolean> {
    const rows = this.checksToEnd();
    if (rows.length === 0) return true;
    try {
      const target = await this.verifiedTarget();
      const token = target && await this.token({ checks: 'write' });
      for (const row of rows) {
        if (target && token) await this.endWaitingCheck(row, target, token);
        else this.forgetCheck(row.id);
      }
      return true;
    } catch (error) {
      log('coordinator_waiting_check_failed', { ...this.logFields(), error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Completes the waiting check of `item` unless its run completed it, and forgets it. Without `superseded`, the PR is
   * read to see whether its head left the check's commit. A check GitHub refuses to show or change is forgotten too.
   * A check without a stored id, whose create reply was lost, is found by its `external_id` among the `Manki` checks
   * of its commit, and forgotten when the review ended and GitHub lists none. Throws on any other failure, which keeps
   * the check for the next try.
   */
  private async endWaitingCheck(item: WorkRow, target: Target, token: string, superseded?: boolean): Promise<void> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    const call = async (path: string, init?: { method: string; body: unknown }, as = token): Promise<Response | null> => {
      const response = await this.api(as, path, init);
      if (response.ok) return response;
      if (!isRefusal(response, await response.text())) throw new Error(`ending the waiting check failed with ${response.status}`);
      log('coordinator_waiting_check_refused', { ...this.logFields(), work_id: item.id, check_id: item.check_id, status: response.status });
      return null;
    };
    let id = item.check_id;
    if (id === null) {
      const list = await call(`${repo}/commits/${item.check_head}/check-runs?check_name=Manki&app_id=${this.env.APP_ID}&filter=all&per_page=100`);
      const runs = list ? (await list.json() as { check_runs: Array<{ id: number; external_id: string | null }> }).check_runs : [];
      id = runs.find((run) => run.external_id === item.check_ref)?.id ?? null;
      if (id === null) {
        // GitHub may list a check late, so a review under way is looked at again on the next pass.
        const review = this.row(item.id);
        if (!review || !['queued', 'dispatching', 'running'].includes(review.status)) this.forgetCheck(item.id);
        return;
      }
      log('coordinator_waiting_check_found', { ...this.logFields(), work_id: item.id, check_id: id });
    }
    const read = await call(`${repo}/check-runs/${id}`);
    const { status } = read ? await read.json() as { status: string } : { status: 'completed' };
    if (status !== 'completed') {
      // A token for checks alone cannot read the PR of a private repository.
      const reader = superseded === undefined && !item.check_own ? await this.token({ pull_requests: 'read' }) : null;
      const pr = reader === null ? null : await call(`${repo}/pulls/${target.number}`, undefined, reader);
      const left = superseded ?? (pr !== null && ((await pr.json()) as PullRequestRead).head.sha !== item.check_head);
      const { conclusion, ...output } = waitingCheckEnd(this.row(item.id) ?? item, status, left);
      await call(`${repo}/check-runs/${id}`, { method: 'PATCH', body: { status: 'completed', conclusion, output } });
    }
    this.forgetCheck(item.id);
  }

  private forgetCheck(id: number): void {
    this.sql.exec('UPDATE work SET check_id = NULL, check_head = NULL, check_ref = NULL, check_own = 0 WHERE id = ?', id);
  }

  /**
   * Shows on the settings comment of a review asked for by a box that the review is starting, since its run takes a
   * minute before it edits the comment. A comment that is not Manki's settings comment is left alone.
   */
  private async showStarting(item: WorkRow, target: Target): Promise<void> {
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null || item.object_id === null) return;
    const path = `/repos/${target.owner}/${target.repo}/issues/comments/${item.object_id}`;
    const read = await this.api(token, path);
    if (!read.ok) throw new Error(`reading the settings comment failed with ${read.status}`);
    const { body, user } = await read.json() as IssueCommentRead;
    if (!MANKI_LOGINS.includes(user?.login ?? '')) return;
    const labels = boxLabels(body ?? '', modesOf(item));
    const starting = withSettingsStatus(body ?? '', `${labels.join(' and ') || 'Review'} requested by @${item.sender}, starting…`, [], item.run_head ?? undefined);
    if (starting === body) return;
    const response = await this.api(token, path, { method: 'PATCH', body: { body: starting } });
    if (!response.ok) throw new Error(`showing the review as starting failed with ${response.status}`);
  }

  /**
   * Whether the sender of a comment or submitted review item has write access, as Manki requires of anyone who starts
   * it from a comment. Only a sender not known as a writer is looked up. Other items need no check.
   */
  private async senderMayAsk(item: WorkRow): Promise<boolean> {
    const asked = item.event.startsWith('issue_comment.') || item.event.startsWith('pull_request_review_comment.')
      || item.event === 'pull_request_review.submitted' || item.event === 'pull_request_review.edited';
    if (item.writer || !asked) return true;
    if (!item.sender) return false;
    const cached = this.writers.get(item.sender);
    if (cached && cached.until > Date.now()) return cached.writer;
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const token = await this.token({ metadata: 'read' });
    if (token === null) return false;
    this.calls++;
    const writer = await hasWriteAccess(token, target.owner, target.repo, item.sender);
    this.writers.set(item.sender, { writer, until: Date.now() + WRITER_CACHE_MS });
    return writer;
  }

  /**
   * Applies a writer's box changes. Pause is set and cleared. A tick of a review box asks for one review with that mode,
   * and Cancel cancels the running review. Unticking any other box changes nothing, since it clears itself. Pause is the
   * only state an edit sets, so only its change is ignored when the edit is older than the last Pause change applied,
   * such as a late redelivery.
   */
  private async applySettings(item: WorkRow): Promise<void> {
    const { at, changes } = editOf(item);
    // Cancel goes first, since a failed cancel throws and the whole edit is tried again.
    const ordered = [...changes].sort((a, b) => Number(b.box === 'cancel') - Number(a.box === 'cancel'));
    const effects: string[] = [];
    for (const { box, ticked } of ordered) {
      if (box === 'pause') {
        if (at < (this.getMeta<number>('pause_at') ?? 0)) {
          effects.push('pause older than the last pause change');
          continue;
        }
        this.setMeta('pause_at', at);
        const state = this.reported();
        if (state.settings.paused === ticked) continue;
        this.setMeta('pr_state', { ...state, settings: { paused: ticked } });
        effects.push(ticked ? 'paused' : state.pause === null ? this.resume(item) : 'resumed');
      } else if (ticked && (REVIEW_MODES as readonly string[]).includes(box)) {
        effects.push(await this.reviewBox(item, box as ReviewMode, at));
      } else if (ticked && box === 'cancel') {
        effects.push(await this.cancelReview(item, at));
      }
    }
    if (this.isDispatching(item.id)) this.finish(item.id, 'done', effects.join(', ') || 'nothing changed');
  }

  /**
   * Lifts the Pause box. When no review ran or waits since the last push the pause skipped, one review of that push is
   * queued as if it had just arrived. A later push a skip rule or a conflict handled counts as a review. A later review
   * that started no run otherwise, or waits for its sender's write access, does not count, since the lookup can drop it.
   */
  private resume(item: WorkRow): string {
    const [waiting] = this.sql.exec<WorkRow>(
      `SELECT * FROM work WHERE kind = 'review' AND status = 'skipped' AND note = ? ORDER BY id DESC LIMIT 1`, PAUSED_NOTE,
    ).toArray();
    if (!waiting) return 'resumed';
    const since = this.sql.exec(
      `SELECT 1 FROM work WHERE kind = 'review' AND id > ?
         AND (status IN ('running', 'done', 'failed') OR (status IN ('queued', 'dispatching') AND writer = 1)
           OR conclusion IN ('cancelled', 'skipped', 'conflict'))`,
      waiting.id,
    ).toArray();
    if (since.length > 0) return 'resumed';
    const work: Work = {
      lane: 'state', kind: 'review', event: waiting.event, headSha: waiting.head_sha, objectId: null, sender: '',
      trusted: true, acknowledge: false, writer: true,
    };
    return `resumed, ${this.enqueue(work, item.delivery, Date.now())}`;
  }

  /**
   * Handles a tick of a review box. While a review runs, Deeper review replaces it with a deeper one on the current
   * commit, and Review again replaces it only when the PR's head moved since it started. On the same head Review again
   * leaves it running and says so in the status line. Without a running review, or when its head is unknown, the box
   * asks for one review as before.
   */
  private async reviewBox(item: WorkRow, mode: ReviewMode, at: number): Promise<string> {
    const running = mode === 'draft' ? undefined : this.runningReview(at);
    if (!running) return this.requestReview(item, mode);
    if (mode === 'again') {
      const target = await this.verifiedTarget();
      if (!target) throw new Error('the repository could not be read');
      const token = await this.token({ issues: 'write', pull_requests: 'write' });
      if (token === null) return this.requestReview(item, mode);
      const repo = `/repos/${target.owner}/${target.repo}`;
      const pr = await this.api(token, `${repo}/pulls/${target.number}`);
      if (!pr.ok) throw new Error(`reading the pull request failed with ${pr.status}`);
      const head = ((await pr.json()) as PullRequestRead).head.sha;
      const progress = await this.runningProgress(token, item.object_id, running, target);
      const reviewing = running.run_head ?? (progress && settingsHead(progress.body));
      if (!reviewing) return this.requestReview(item, mode);
      if (head.startsWith(reviewing)) {
        // The box may be ticked on another settings comment than the running review's, which then gets unticked too.
        const ticked = item.object_id !== null && item.object_id !== progress?.id ? await this.readComment(token, repo, item.object_id) : null;
        for (const comment of [progress, ticked]) {
          if (!comment) continue;
          const body = withSettingsStatus(comment.body, `already reviewing \`${head.slice(0, 7)}\``, ['again'], head);
          const edited = await this.api(token, `${repo}/issues/comments/${comment.id}`, { method: 'PATCH', body: { body } });
          if (!edited.ok) throw new Error(`showing the running review failed with ${edited.status}`);
        }
        return `already reviewing ${head.slice(0, 7)}`;
      }
    }
    const replaced = await this.cancelReview(item, at, mode === 'deeper' ? 'a deeper review' : 'a review of the new commits');
    return `${replaced}, ${this.requestReview(item, mode)}`;
  }

  /** Returns comment `id` of `repo` and whether one of Manki's logins wrote it, or null when it is gone. */
  private async readComment(token: string, repo: string, id: number): Promise<{ id: number; body: string; byManki: boolean } | null> {
    const read = await this.api(token, `${repo}/issues/comments/${id}`);
    if (read.status === 404) return null;
    if (!read.ok) throw new Error(`reading the settings comment failed with ${read.status}`);
    const { body, user } = await read.json() as IssueCommentRead;
    return body ? { id, body, byManki: MANKI_LOGINS.includes(user?.login ?? '') } : null;
  }

  /** Returns the review running since before the edit at `at`, so a late edit cannot reach a newer run. */
  private runningReview(at: number): WorkRow | undefined {
    return this.sql.exec<WorkRow>(
      `SELECT * FROM work WHERE kind = 'review' AND status = 'running' AND run_id IS NOT NULL AND dispatched_at <= ?`, at || Date.now(),
    ).toArray()[0];
  }

  /**
   * Asks for one review with `mode`. The mode joins a review a writer already queued, and a queued push review becomes
   * the box's review, so a pause, a skip rule or a draft cannot drop it. Otherwise a review is queued.
   */
  private requestReview(item: WorkRow, mode: ReviewMode): string {
    const review = this.queued('state', ['review']).filter((row) => row.writer).at(-1);
    if (!review) {
      const work: Work = {
        lane: 'state', kind: 'review', event: item.event, headSha: null, objectId: item.object_id, sender: item.sender,
        trusted: true, acknowledge: false, writer: true, modes: [mode],
      };
      return `${mode} review ${this.insert(work, item.delivery, Date.now())}`;
    }
    const modes = JSON.stringify([...new Set([...modesOf(review), mode])]);
    if (review.event.startsWith('pull_request.')) {
      this.sql.exec(
        'UPDATE work SET event = ?, object_id = ?, sender = ?, delivery = ?, modes = ? WHERE id = ?',
        item.event, item.object_id, item.sender, item.delivery, modes, review.id,
      );
    } else {
      this.sql.exec('UPDATE work SET modes = ? WHERE id = ?', modes, review.id);
    }
    return `${mode} review in work ${review.id}`;
  }

  /**
   * Cancels the running review, if it started before the edit at `at`, so a late Cancel cannot hit a newer run. A review
   * not yet running, or one GitHub gave no run id, cannot be cancelled. With `replacement`, such as "a deeper review", the
   * comment and check say the review was replaced by it instead of cancelled.
   */
  private async cancelReview(item: WorkRow, at: number, replacement?: string): Promise<string> {
    const running = this.runningReview(at);
    if (!running) return 'no review to cancel';
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const reason = replacement ? `replaced by ${item.sender}` : `cancelled by ${item.sender}`;
    if (!(await this.cancel(running, target, reason, false, ['skipped', 'cancelled']))) {
      throw new Error(`cancelling the run of work ${running.id} failed`);
    }
    const ended = this.row(running.id);
    if (ended?.status === 'skipped' && ended.conclusion === 'cancelled') {
      const headline = replacement ? `Review replaced by ${replacement} requested by @${item.sender}.` : `Review cancelled by @${item.sender}.`;
      await this.reportStopped(running, target, item.object_id, 'Review cancelled', headline);
    }
    return `${replacement ? 'replacing' : 'cancel of'} work ${running.id} requested`;
  }

  /**
   * Ends the progress comment and the `Manki` check of a review whose run the Worker cancelled, with `headline`. The
   * run's own post step can no longer mint a token, so it cannot end them itself. A failure is logged.
   */
  private async reportStopped(running: WorkRow, target: Target, ticked: number | null, title: string, headline: string): Promise<void> {
    const failed = (part: string) => (error: unknown) => {
      log('coordinator_cancel_report_failed', { ...this.logFields(), work_id: running.id, part, error: error instanceof Error ? error.message : String(error) });
    };
    await this.markCommentCancelled(ticked, running, target, headline).catch(failed('comment'));
    await this.markCheckCancelled(running, target, title, headline).catch(failed('check'));
  }

  /**
   * Marks the progress comment of the cancelled review as cancelled, with `headline`. The comment is `ticked`, the one
   * whose box was ticked, or else Manki's newest progress comment of a review that has not ended. Without one, it does nothing.
   */
  private async markCommentCancelled(ticked: number | null, running: WorkRow, target: Target, headline: string): Promise<void> {
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null) return;
    const comment = await this.runningProgress(token, ticked, running, target);
    if (comment === null) {
      log('coordinator_cancel_no_comment', { ...this.logFields(), work_id: running.id });
      return;
    }
    const path = `/repos/${target.owner}/${target.repo}/issues/comments/${comment.id}`;
    const response = await this.api(token, path, { method: 'PATCH', body: { body: cancelledProgress(comment.body, headline) } });
    if (!response.ok) throw new Error(`marking the progress comment cancelled failed with ${response.status}`);
  }

  /** Completes the in-progress `Manki` checks on the cancelled review's head as cancelled, with `title` and `headline`. */
  private async markCheckCancelled(running: WorkRow, target: Target, title: string, headline: string): Promise<void> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    const checks = await this.token({ checks: 'write' });
    if (checks === null) return;
    let head = running.run_head;
    if (head === null) {
      // A token for checks alone cannot read the PR of a private repository.
      const reader = await this.token({ pull_requests: 'read' });
      if (reader === null) return;
      const pr = await this.api(reader, `${repo}/pulls/${target.number}`);
      if (!pr.ok) throw new Error(`reading the pull request failed with ${pr.status}`);
      head = ((await pr.json()) as PullRequestRead).head.sha;
    }
    // Another app's check of the same name is not Manki's, and the App could not edit it.
    const list = await this.api(checks, `${repo}/commits/${head}/check-runs?check_name=Manki&status=in_progress&app_id=${this.env.APP_ID}`);
    if (!list.ok) throw new Error(`listing the Manki checks failed with ${list.status}`);
    const { check_runs: runs } = await list.json() as { check_runs: Array<{ id: number }> };
    for (const run of runs) {
      const response = await this.api(checks, `${repo}/check-runs/${run.id}`, {
        method: 'PATCH',
        body: { status: 'completed', conclusion: 'cancelled', output: { title, summary: headline } },
      });
      if (!response.ok) throw new Error(`completing the Manki check failed with ${response.status}`);
    }
  }

  /** Returns the progress comment of the cancelled review, or null when Manki has none that is still running. */
  private async runningProgress(token: string, ticked: number | null, running: WorkRow, target: Target): Promise<{ id: number; body: string } | null> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    // Only a comment posted since the run started can be its own. An older one still in progress is from a run that died.
    // The first attempt bounds the start, since a run adopted after a lost dispatch response started before its adoption.
    const since = (running.first_attempt_at ?? running.dispatched_at ?? Date.now()) - MINUTE;
    const isOwn = (comment: IssueCommentRead) =>
      !!comment.body && isRunningProgress(comment.body) && Date.parse(comment.created_at ?? '') >= since;
    if (ticked !== null) {
      const read = await this.api(token, `${repo}/issues/comments/${ticked}`);
      if (read.ok) {
        const comment = await read.json() as IssueCommentRead;
        if (isOwn(comment)) return { id: ticked, body: comment.body! };
      } else if (read.status !== 404) {
        throw new Error(`reading the settings comment failed with ${read.status}`);
      }
    }
    return this.newestMankiComment(token, target, isRunningProgress, since);
  }

  /**
   * Returns Manki's newest comment posted since `since` whose body `matches`, among the PR's newest 100 comments, or
   * null. Anyone can comment, so the list leaves out the bodies, and only Manki's newest few are read.
   */
  private async newestMankiComment(
    token: string, target: Target, matches: (body: string) => boolean, since = 0,
  ): Promise<{ id: number; body: string } | null> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    this.calls++;
    const data = await githubGraphql<RecentCommentsResponse>(token, RECENT_COMMENTS_QUERY, {
      owner: target.owner, name: target.repo, number: target.number,
    });
    const mankis = (data.repository?.pullRequest?.comments.nodes ?? [])
      .filter((c) => c.fullDatabaseId !== null && isMankiGraphqlLogin(c.author?.login) && Date.parse(c.createdAt) >= since);
    for (const { fullDatabaseId } of mankis.reverse().slice(0, MANKI_COMMENT_READS)) {
      const comment = await this.readComment(token, repo, Number(fullDatabaseId));
      if (comment && matches(comment.body)) return comment;
    }
    return null;
  }

  /** Puts back the boxes someone without write access changed: Pause as it applies, and every other box unticked. */
  private async revertBoxes(item: WorkRow): Promise<void> {
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null || item.object_id === null) return;
    const path = `/repos/${target.owner}/${target.repo}/issues/comments/${item.object_id}`;
    const read = await this.api(token, path);
    if (!read.ok) throw new Error(`reading the settings comment failed with ${read.status}`);
    const { body } = await read.json() as { body?: string };
    const { paused } = this.reported().settings;
    const reverted = setBoxes(body ?? '', editOf(item).changes.map(({ box }) => ({ box, ticked: box === 'pause' && paused })));
    if (reverted === body) return;
    const response = await this.api(token, path, { method: 'PATCH', body: { body: reverted } });
    if (!response.ok) throw new Error(`reverting the settings comment failed with ${response.status}`);
  }

  /** Answers a help command with Manki's command table and a thumbs-up on the command, with no run. */
  private async answerHelp(item: WorkRow): Promise<void> {
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (!this.isDispatching(item.id)) return;
    if (token === null) {
      this.finish(item.id, 'skipped', 'installation lacks issues: write');
      return;
    }
    const repo = `/repos/${target.owner}/${target.repo}`;
    const comments = item.event.startsWith('pull_request_review_comment.') ? 'pulls' : 'issues';
    if (item.object_id !== null) {
      const reaction = await this.api(token, `${repo}/${comments}/comments/${item.object_id}/reactions`, { method: 'POST', body: { content: '+1' } });
      if (!reaction.ok) log('coordinator_reaction_failed', { ...this.logFields(), comment_id: item.object_id, status: reaction.status });
    }
    // Manki marks the reply to a PR comment as its answer, as its `markAnswers` does.
    const body = comments === 'issues' ? `${HELP_REPLY}\n<!-- manki-answered:${item.object_id} -->` : HELP_REPLY;
    const response = await this.api(token, `${repo}/issues/${target.number}/comments`, { method: 'POST', body: { body } });
    if (!response.ok) throw new Error(`posting the help reply failed with ${response.status}`);
    this.sql.exec('UPDATE work SET dispatched_at = ? WHERE id = ?', Date.now(), item.id);
    this.finish(item.id, 'done', 'answered help');
  }

  /** Reads the PR, and returns it with the token that read it. Throws when it cannot be read. */
  private async readPull(target: Target): Promise<{ pr: PullRequestRead; token: string }> {
    const token = await this.token({ pull_requests: 'read' });
    if (token === null) throw new Error('could not mint a token to read the pull request');
    const response = await this.api(token, `/repos/${target.owner}/${target.repo}/pulls/${target.number}`);
    if (!response.ok) throw new Error(`reading the pull request failed with ${response.status}`);
    return { pr: await response.json() as PullRequestRead, token };
  }

  /**
   * Re-reads the PR before a review starts. Returns null when the review does not start now, and otherwise whether its
   * run may get a waiting check.
   */
  private async refreshReview(item: WorkRow, target: Target): Promise<{ waitingCheck: boolean } | null> {
    const { pr, token } = await this.readPull(target);
    if (!this.isDispatching(item.id)) return null;
    if (pr.state !== 'open') {
      this.finish(item.id, 'dropped', 'pull request closed');
      return null;
    }
    // A retry after a dispatch attempt may find that attempt's run, so only the first attempt can drop or skip.
    const first = item.attempts === 0;
    const push = item.event.startsWith('pull_request.');
    const config = push && first ? await this.baseConfig(pr, target) : null;
    if (!this.isDispatching(item.id)) return null;
    // A draft is reviewed on request, such as by its settings box, unless the base config reviews drafts.
    if (push && first && pr.draft && !reviewsDrafts(config)) {
      this.finish(item.id, 'dropped', 'pull request is a draft');
      return null;
    }
    const reviewed = first ? await this.reviewedInstead(pr, target, token) : null;
    if (!this.isDispatching(item.id)) return null;
    if (reviewed !== null) {
      await this.reportYielded(item, pr.head.sha, reviewed, target);
      if (this.isDispatching(item.id)) this.finish(item.id, 'skipped', `#${reviewed} has the same head commit`);
      return null;
    }
    let waitingCheck = true;
    if (push) {
      // With `auto_review` off the run of a push reviews nothing, so only a config read as leaving it on allows the check.
      waitingCheck = first && autoReviewIsOn(config);
      const rule = first ? this.skipRule(config, pr, item.head_sha, item.sender, target) : null;
      if (rule !== null) {
        await this.reportSkipped(pr.head.sha, rule, target);
        if (!this.isDispatching(item.id)) return null;
      }
      // Who pushed a newer head is unknown, so its sender goes with the queued head, also for a retry after a failure.
      this.sql.exec(
        `UPDATE work SET sender = CASE WHEN head_sha IS ? THEN sender ELSE '' END, head_sha = ? WHERE id = ?`,
        pr.head.sha, pr.head.sha, item.id,
      );
      if (rule !== null) {
        this.finish(item.id, 'skipped', `matches the skip rule for ${rule}`, 'skipped');
        return null;
      }
      // Only a review nobody asked for waits out a pause. A request, a reply or a settings box review still runs.
      const paused = () => {
        const { pause, settings } = this.reported();
        return pause !== null || settings.paused;
      };
      if (first && paused()) {
        await this.reportPaused(pr, target);
        if (!this.isDispatching(item.id)) return null;
        // An untick applied meanwhile saw this review in flight and queued none, so the review goes on.
        if (paused()) {
          this.finish(item.id, 'skipped', PAUSED_NOTE);
          return null;
        }
      }
    }
    // A review of a PR that conflicts with its base would only end in a held approval, so none starts until a rebase.
    if (item.attempts === 0) {
      const conflict = pr.mergeable === false || pr.mergeable_state === 'dirty';
      if (!conflict && pr.mergeable === null && item.merge_checks < MERGEABILITY_RETRY_MS.length) {
        // GitHub computes mergeability once the PR is read, so the review waits briefly and reads it again.
        this.sql.exec(
          `UPDATE work SET status = 'queued', lease_until = NULL, check_at = ?, merge_checks = merge_checks + 1 WHERE id = ?`,
          Date.now() + MERGEABILITY_RETRY_MS[item.merge_checks], item.id,
        );
        log('coordinator_mergeability_pending', { ...this.logFields(), work_id: item.id, merge_checks: item.merge_checks + 1 });
        return null;
      }
      if (conflict) {
        await this.reportConflict(pr, target);
        if (this.isDispatching(item.id)) this.finish(item.id, 'skipped', `conflicts with ${pr.base.ref}`, 'conflict');
        return null;
      }
    }
    this.sql.exec('UPDATE work SET run_head = ? WHERE id = ?', pr.head.sha, item.id);
    return { waitingCheck };
  }

  /**
   * Returns the open pull request that is reviewed instead of this one, or null when this one is reviewed. A commit has
   * one `Manki` status, so of the repository's open pull requests with the head `pr.head.sha` only the one with the
   * lowest number is reviewed. GitHub also lists a pull request that merely contains the commit, which does not count.
   * In doubt the review runs: when the list fails, is not a list of pull requests, may be cut off or does not name this
   * pull request.
   */
  private async reviewedInstead(pr: PullRequestRead, target: Target, token: string): Promise<number | null> {
    const head = pr.head.sha;
    const unsure = (reason: string): null => {
      log('coordinator_head_pulls_unsure', { ...this.logFields(), head_sha: head, reason });
      return null;
    };
    try {
      const response = await this.api(token, `/repos/${target.owner}/${target.repo}/commits/${head}/pulls?per_page=${HEAD_PULLS_PAGE}`);
      if (!response.ok) return unsure(`listing the pull requests of the commit failed with ${response.status}`);
      const listed: unknown = await response.json();
      if (!Array.isArray(listed) || !listed.every(isHeadPull)) return unsure('the reply is not a list of pull requests');
      if (listed.length >= HEAD_PULLS_PAGE) return unsure('the list may be cut off');
      const sharing = listed
        .filter((pull) => pull.state === 'open' && pull.head.sha === head && pull.head.repo?.id === target.repositoryId)
        .map((pull) => pull.number);
      if (!sharing.includes(target.number)) return unsure('the list does not name this pull request');
      const lowest = Math.min(...sharing);
      return lowest < target.number ? lowest : null;
    } catch (error) {
      return unsure(`listing the pull requests of the commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Tells the PR that `reviewed` is reviewed instead of it. Manki's settings comments say so in their status line, and
   * the boxes that asked are unticked. Without a settings comment the PR gets one Manki note per head. A review command
   * gets the note each time, as a new comment below it. The PR gets no check, which would be the newest on the commit
   * that `reviewed` shares. A failure is logged and still skips the review.
   */
  private async reportYielded(item: WorkRow, head: string, reviewed: number, target: Target): Promise<void> {
    try {
      const told = `${head}:${reviewed}`;
      const shown = await this.showStatus(head, target, `not reviewed, #${reviewed} has the same head commit`, modesOf(item), item.object_id);
      // A comment that asked and is not a settings comment is a review command.
      const command = item.object_id !== null && !shown.includes(item.object_id);
      if (command || (shown.length === 0 && this.getMeta<string>('yielded') !== told)) {
        const note = `Manki reviews one pull request per commit. #${reviewed} has the same head commit \`${head.slice(0, 7)}\` and the lower number, so Manki reviews #${reviewed} and not this pull request. `
          + `The \`Manki\` check shown here is the one of #${reviewed}. To have this pull request reviewed, close #${reviewed} and comment \`/manki review\` here, or push a commit that only this pull request has.`;
        await this.postNote(`${note}\n\n${CONFLICT_NOTE_MARKER}`, target, command);
      }
      this.setMeta('yielded', told);
    } catch (error) {
      log('coordinator_yielded_report_failed', { ...this.logFields(), head_sha: head, reviewed, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Tells the PR's author that its review waits for a rebase: one Manki note, which replaces the note an earlier skip
   * posted, and a `Manki` check on the head that asks for the rebase.
   */
  private async reportConflict(pr: PullRequestRead, target: Target): Promise<void> {
    const text = `This PR conflicts with \`${pr.base.ref}\`. Rebase it, and Manki reviews it then.`;
    try {
      await this.postNote(`${text}\n\n${CONFLICT_NOTE_MARKER}`, target);
    } catch (error) {
      // The note only explains the skip, so a failure to post it never holds the lane.
      log('coordinator_conflict_note_failed', { ...this.logFields(), error: String(error) });
    }
    await this.completeCheck(pr.head.sha, 'action_required', { title: 'Rebase needed', summary: text }, target, pr.html_url);
  }

  /**
   * Posts the Manki note that says why no review starts, or edits the one an earlier skip posted. With `anew` the note
   * replaces that one as a new comment, so it stands below the comment it answers.
   */
  private async postNote(body: string, target: Target, anew = false): Promise<void> {
    // A comment on a pull request needs `pull_requests: write`, one on a plain issue `issues: write`.
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null) return;
    const noteId = this.getMeta<number>('conflict_note');
    const edited = noteId === null ? null
      : await this.api(token, `/repos/${target.owner}/${target.repo}/issues/comments/${noteId}`, anew ? { method: 'DELETE' } : { method: 'PATCH', body: { body } });
    // Manki deletes the note once a review posts, so a note that is gone is posted again.
    if (edited === null || edited.status === 404 || anew) {
      const posted = await this.api(token, `/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`, { method: 'POST', body: { body } });
      if (!posted.ok) throw new Error(`posting the note failed with ${posted.status}`);
      this.setMeta('conflict_note', ((await posted.json()) as { id: number }).id);
    } else if (!edited.ok) {
      throw new Error(`updating the note failed with ${edited.status}`);
    }
  }

  /**
   * Reads `.manki.yml` from the PR's base branch, so a PR cannot change what applies to itself. A missing file gives an
   * empty config. A file that cannot be read, is oversized or does not parse gives null. Neither sets anything, as in
   * Manki.
   */
  private async baseConfig(pr: PullRequestRead, target: Target): Promise<BaseConfig> {
    const token = await this.token({ contents: 'read', metadata: 'read' });
    if (token === null) return null;
    const response = await this.api(token, `/repos/${target.owner}/${target.repo}/contents/.manki.yml?ref=${encodeURIComponent(pr.base.ref)}`);
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`reading .manki.yml failed with ${response.status}`);
    const file = await response.json() as { type?: string; size?: number; encoding?: string; content?: string };
    if (file.type !== 'file' || file.encoding !== 'base64' || file.content === undefined || (file.size ?? 0) > MAX_CONFIG_BYTES) return null;
    return parseConfig(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))));
  }

  /**
   * Ends a bot's push, which gets no review. A PR that matches a skip rule gets its `Manki` check completed as skipped,
   * as for a person's push. The check is added only when it cannot hide another: the pushed commit is still the head,
   * no other pull request is reviewed for it, and it holds no `Manki` check, since GitHub reads the check created last.
   */
  private async skipBotPush(item: WorkRow): Promise<void> {
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const end = (note: string, conclusion: string | null = null) => {
      if (this.isDispatching(item.id)) this.finish(item.id, 'skipped', note, conclusion);
    };
    const { pr, token } = await this.readPull(target);
    if (pr.state !== 'open' || pr.head.sha !== item.head_sha) return end('pushed by a bot, and no longer the head');
    const config = await this.baseConfig(pr, target);
    // A draft gets no check from a push, as a person's push to it gets none.
    const rule = pr.draft && !reviewsDrafts(config) ? null : this.skipRule(config, pr, item.head_sha, item.sender, target);
    if (rule === null) return end('pushed by a bot');
    const skipped = `matches the skip rule for ${rule}`;
    const reviewed = await this.reviewedInstead(pr, target, token);
    if (reviewed !== null) return end(`${skipped}, no check added, #${reviewed} has the same head commit`, 'skipped');
    const checks = await this.token({ checks: 'write' });
    if (checks === null || await this.hasMankiCheck(pr.head.sha, target, checks)) return end(`${skipped}, no check added`, 'skipped');
    if (!this.isDispatching(item.id)) return;
    await this.reportSkipped(pr.head.sha, rule, target);
    end(skipped, 'skipped');
  }

  /** Returns the skip rule of `config` the PR matches, or null when none does. */
  private skipRule(config: BaseConfig, pr: PullRequestRead, queuedHead: string | null, sender: string, target: Target): string | null {
    const rules = skipRulesOf(config);
    if (rules === null) return null;
    return matchSkipRule(rules, {
      labels: pr.labels?.map((label) => label.name) ?? [],
      author: pr.user?.login,
      // Who pushed a head other than the queued one is unknown, as for a catch-up, so no author rule matches it.
      sender: pr.head.sha === queuedHead ? sender : '',
      branch: pr.head.ref,
      fromFork: pr.head.repo?.id !== target.repositoryId,
    });
  }

  /** Completes a `Manki` check on `head` as skipped, as Manki does for a PR it skips. */
  private async reportSkipped(head: string, rule: string, target: Target): Promise<void> {
    const summary = `This PR matches the skip rule for ${rule} in \`.manki.yml\` on the base branch.`;
    await this.completeCheck(head, 'skipped', { title: 'Review skipped', summary }, target);
  }

  /**
   * Tells the PR's author that the push of its head waits out a pause: one `Manki` check per head that says why and what
   * starts a review, and the status line of Manki's settings comment. A failure is logged and still skips the review.
   */
  private async reportPaused(pr: PullRequestRead, target: Target): Promise<void> {
    const head = pr.head.sha;
    const { pause, settings } = this.reported();
    const failed = (part: string) => (error: unknown) => {
      log('coordinator_paused_report_failed', { ...this.logFields(), head_sha: head, part, error: error instanceof Error ? error.message : String(error) });
    };
    // A catch-up of a head whose push was skipped asks again, and must not add a second check.
    if (this.getMeta<string>('paused_head') !== head) {
      const output = { title: 'Automatic review paused', summary: pausedSummary(pause?.reason ?? null, settings.paused) };
      await this.completeCheck(head, 'action_required', output, target, pr.html_url)
        .then(() => this.setMeta('paused_head', head), failed('check'));
    }
    await this.showStatus(head, target, `automatic review paused, \`${head.slice(0, 7)}\` waits`).catch(failed('comment'));
  }

  /**
   * Sets the status line of Manki's settings comments to `status` for `head` and clears the boxes in `untick`: on the
   * newest one among the PR's newest comments, and on comment `ticked` when that is another one. Returns the ids of the
   * settings comments that show it.
   */
  private async showStatus(head: string, target: Target, status: string, untick: SettingsBox[] = [], ticked: number | null = null): Promise<number[]> {
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null) return [];
    const repo = `/repos/${target.owner}/${target.repo}`;
    const newest = await this.newestMankiComment(token, target, (body) => settingsHead(body) !== null);
    const other = ticked === null || ticked === newest?.id ? null : await this.readComment(token, repo, ticked);
    const shown: number[] = [];
    for (const settings of [newest, other?.byManki && settingsHead(other.body) !== null ? other : null]) {
      // A progress comment still in progress belongs to its run, which may edit it at any time.
      if (!settings || isRunningProgress(settings.body)) continue;
      const body = withSettingsStatus(settings.body, status, untick, head);
      if (body !== settings.body) {
        const response = await this.api(token, `${repo}/issues/comments/${settings.id}`, { method: 'PATCH', body: { body } });
        if (!response.ok) throw new Error(`setting the status line failed with ${response.status}`);
      }
      shown.push(settings.id);
    }
    return shown;
  }

  /** Completes a `Manki` check on `head` with `output`. Without `checks: write` on the installation, it creates none. */
  private async completeCheck(
    head: string, conclusion: string, output: { title: string; summary: string }, target: Target, detailsUrl?: string,
  ): Promise<void> {
    const token = await this.token({ checks: 'write' });
    if (token === null) return;
    const repo = `/repos/${target.owner}/${target.repo}`;
    const body = { status: 'completed', conclusion, ...(detailsUrl && { details_url: detailsUrl }), output };
    // The waiting check of the review being started becomes the report while a required check would read it. Past
    // another `Manki` check on `head` the report is a new check, the one created last, and the waiting one ends with the review.
    const held = () => this.sql.exec<WorkRow>(`SELECT * FROM work WHERE status = 'dispatching' AND check_id IS NOT NULL AND check_head = ?`, head).toArray()[0];
    const first = held();
    let waiting = first && await this.holdsVerdict(first, target, token) ? held() : undefined;
    let response = waiting && await this.api(token, `${repo}/check-runs/${waiting.check_id}`, { method: 'PATCH', body });
    // A waiting check GitHub refuses to change is forgotten, as `endWaitingCheck` does, and the report is a new check.
    if (waiting && response && !response.ok && isRefusal(response, await response.text())) {
      log('coordinator_waiting_check_refused', { ...this.logFields(), work_id: waiting.id, check_id: waiting.check_id, status: response.status });
      this.forgetCheck(waiting.id);
      waiting = response = undefined;
    }
    response ??= await this.api(token, `${repo}/check-runs`, { method: 'POST', body: { name: 'Manki', head_sha: head, ...body } });
    if (!response.ok) throw new Error(`creating the ${output.title} check failed with ${response.status}`);
    if (waiting) this.forgetCheck(waiting.id);
  }

  private markRunning(item: WorkRow, runId: number | null, note: string): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE work SET status = 'running', run_id = COALESCE(?, run_id), dispatched_at = ?, check_at = ?, lease_until = NULL, errors = 0, note = ? WHERE id = ?`,
      runId, now, now + POLL_MS, note, item.id,
    );
    log('coordinator_dispatched', { ...this.logFields(), ...this.describe(this.row(item.id)!), run_id: runId, note });
  }

  /**
   * Finds the run an earlier attempt started when its response was lost. Its `display_title` names the item's
   * delivery id, so only that item's run matches. It must also come from the App and belong to no other item.
   */
  private async findRun(item: WorkRow, target: Target): Promise<number | null> {
    if (item.workflow === null) return null;
    const token = await this.token({ actions: 'read' });
    if (token === null) return null;
    const since = new Date((item.first_attempt_at ?? Date.now()) - MINUTE).toISOString();
    const response = await this.api(
      token,
      `/repos/${target.owner}/${target.repo}/actions/workflows/${encodeURIComponent(item.workflow)}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${since}`)}&per_page=50`,
    );
    if (!response.ok) throw new Error(`listing dispatch runs failed with ${response.status}`);
    const { workflow_runs: runs } = await response.json() as {
      workflow_runs: Array<{ id: number; display_title: string; created_at: string; actor?: { login?: string } }>;
    };
    const known = new Set(this.sql.exec<{ run_id: number }>('SELECT run_id FROM work WHERE run_id IS NOT NULL').toArray().map((row) => row.run_id));
    const title = runTitle(item, target.number);
    const match = runs
      .filter((run) => run.display_title === title && run.actor?.login === BOT_LOGIN && !known.has(run.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    return match?.id ?? null;
  }

  /** Checks a running item's run, the safety net for a missed `workflow_run` delivery and runs that never start. */
  private async poll(item: WorkRow): Promise<void> {
    const now = Date.now();
    const dispatchedAt = item.dispatched_at ?? now;
    // Moved forward before any GitHub call, so a failing call backs off instead of firing the alarm again at once.
    this.sql.exec(
      'UPDATE work SET check_at = ?, errors = errors + 1 WHERE id = ?',
      now + backoff(item.errors), item.id,
    );
    const target = await this.verifiedTarget();
    if (!target) {
      // The run cannot be read or cancelled without the repository's names, so the item waits for them to come back.
      // Past the deadline it ends, since no cancel is possible and a started run is past the workflow's `timeout-minutes`.
      if (now - dispatchedAt > RUN_DEADLINE_MS) this.finish(item.id, 'timed_out', 'the repository can no longer be read');
      return;
    }

    if (item.run_id === null) {
      if (now - dispatchedAt > RUN_LOOKUP_TIMEOUT_MS) {
        this.finish(item.id, 'failed', 'no run found for the dispatch');
        return;
      }
      const runId = await this.findRun({ ...item, first_attempt_at: item.first_attempt_at ?? dispatchedAt }, target);
      if (this.row(item.id)?.status !== 'running') return;
      this.polled(item.id);
      if (runId !== null) this.sql.exec('UPDATE work SET run_id = ? WHERE id = ?', runId, item.id);
      return;
    }

    const token = await this.token({ actions: 'read' });
    const response = token === null ? null : await this.api(token, `/repos/${target.owner}/${target.repo}/actions/runs/${item.run_id}`);
    if (this.row(item.id)?.status !== 'running') return;
    if (response?.status === 404) {
      this.finish(item.id, 'done', 'run deleted');
      return;
    }
    const run = response?.ok
      ? await response.json() as { status: string; conclusion: string | null; run_started_at?: string }
      : null;
    if (run) this.polled(item.id);
    if (run?.status === 'completed') {
      this.finish(item.id, 'done', 'run completed (poll)', run.conclusion);
      return;
    }
    // Past the deadline the run is cancelled even when it could not be read, since only a cancel frees the lane.
    if (now - dispatchedAt > RUN_DEADLINE_MS) {
      if (await this.cancel(item, target, 'no end of the run seen in time')) {
        await this.reportTimedOut(item, target, `no end of the run was seen within ${RUN_DEADLINE_MS / MINUTE} minutes`);
      }
      return;
    }
    if (!run) return;
    const startedAt = run.run_started_at ? Date.parse(run.run_started_at) : dispatchedAt;
    // A run that never started posted no progress comment or check, so only a run that started has any to end.
    if (NOT_STARTED.has(run.status) && now - dispatchedAt > QUEUED_RUN_TIMEOUT_MS) {
      await this.cancel(item, target, 'run never started', item.requeues === 0);
    } else if (!NOT_STARTED.has(run.status) && now - startedAt > RUNNING_RUN_TIMEOUT_MS) {
      if (await this.cancel(item, target, 'run went past its timeout')) {
        await this.reportTimedOut(item, target, `it ran longer than ${RUNNING_RUN_TIMEOUT_MS / MINUTE} minutes`);
      }
    }
  }

  /** Ends the progress comment and check of a review whose run the poll cancelled, saying `why`. */
  private async reportTimedOut(item: WorkRow, target: Target, why: string): Promise<void> {
    if (item.kind !== 'review') return;
    // The review's own comment id names the comment that asked for it, which can be someone else's, so only Manki's are searched.
    await this.reportStopped(item, target, null, 'Review stopped', `Review stopped: ${why}.`);
  }

  /** Records a poll that reached GitHub, so the next one comes after the normal interval. */
  private polled(id: number): void {
    this.sql.exec('UPDATE work SET errors = 0, check_at = ? WHERE id = ?', Date.now() + POLL_MS, id);
  }

  /**
   * Cancels a run and ends its item as `ended`, a status and conclusion, or queues the item again when `requeue` is set.
   * A failed cancel keeps the item running, so the next poll tries again. Returns false only for a failed cancel.
   */
  private async cancel(
    item: WorkRow, target: Target, reason: string, requeue = false, ended: [WorkStatus, string | null] = ['timed_out', null],
  ): Promise<boolean> {
    const token = await this.token({ actions: 'write' });
    if (token === null) {
      // Without `actions: write` no other run can be dispatched either, so ending the item cannot let two overlap.
      if (this.row(item.id)?.status === 'running') this.finish(item.id, 'timed_out', `${reason}, cannot cancel without actions: write`);
      return true;
    }
    const response = await this.api(token, `/repos/${target.owner}/${target.repo}/actions/runs/${item.run_id}/cancel`, { method: 'POST' });
    if (this.row(item.id)?.status !== 'running') return true;
    if (!response.ok) {
      log('coordinator_cancel_failed', { ...this.logFields(), work_id: item.id, run_id: item.run_id, reason, status: response.status });
      return false;
    } else if (requeue) {
      this.requeue(item.id, reason, `${reason}, cancel requested, queued again`);
    } else {
      this.finish(item.id, ended[0], `${reason}, cancel requested`, ended[1]);
    }
    return true;
  }

  /** Queues an item that started no run again. The fresh attempt count keeps its next dispatch from adopting an old run. */
  private requeue(id: number, reason: string, note: string): void {
    const runId = this.row(id)?.run_id ?? null;
    this.sql.exec(
      `UPDATE work SET status = 'queued', run_id = NULL, check_at = NULL, lease_until = NULL, attempts = 0,
       first_attempt_at = NULL, errors = 0, requeues = requeues + 1, workflow = NULL, note = ? WHERE id = ?`,
      note, id,
    );
    log('coordinator_requeued', { ...this.logFields(), work_id: id, run_id: runId, reason });
  }

  /** Ends the item whose run finished, from the `workflow_run` webhook, and frees its lane. */
  async runCompleted(delivery: Delivery, runId: number, conclusion: string | null): Promise<ReceiveResult> {
    if (!this.hasState()) {
      log('coordinator_run_completed', { delivery: delivery.id, run_id: runId, accepted: false, reason: 'no coordinator state' });
      return { accepted: false, reason: 'no coordinator state' };
    }
    this.ensureSchema();
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): ReceiveResult => {
      if (this.isReplay(delivery)) return { accepted: false, reason: 'duplicate delivery' };
      const [item] = this.sql.exec<{ id: number }>(`SELECT id FROM work WHERE run_id = ? AND status = 'running'`, runId).toArray();
      if (!item) return { accepted: false, reason: `no running item for run ${runId}` };
      this.remember(delivery, now);
      this.finish(item.id, 'done', 'run completed', conclusion);
      return { accepted: true, effect: `finished work ${item.id}` };
    });
    log('coordinator_run_completed', { ...this.logFields(), delivery: delivery.id, run_id: runId, conclusion, ...result });
    if (result.accepted) await this.ctx.storage.setAlarm(now);
    return result;
  }

  /** Returns whether the repository opted in to webhook mode, read at most every `OPT_IN_TTL_MS`. */
  private async optIn(): Promise<OptIn> {
    const cached = this.getMeta<CachedOptIn>('opt_in');
    // An entry cached without the repository, or opted in without the workflow, predates reading them, so it is read again.
    if (cached && cached.expires > Date.now() && cached.repository !== undefined && (!cached.optedIn || cached.workflow !== undefined)) return cached;
    this.optInRead ??= this.readOptIn().finally(() => {
      this.optInRead = null;
    });
    return this.optInRead;
  }

  /**
   * Reads the repository by its id and its workflows from the default branch GitHub names. The payload's names are
   * not used, so a forged delivery cannot pick the branch a run starts from. A failure GitHub may recover from throws
   * and is not cached.
   */
  private async readOptIn(): Promise<OptIn> {
    const target = this.getMeta<Target>('target');
    if (!target) return { optedIn: false, reason: 'no target recorded' };
    const mint = await this.mint({ contents: 'read', metadata: 'read' });
    if (!mint.ok && !mint.refused) throw new Error(`token mint failed with ${mint.status}`);
    let repository: Repository | null = null;
    let optIn: OptIn;
    let takesOverCheck = false;
    if (!mint.ok) {
      optIn = { optedIn: false, reason: `token mint refused with ${mint.status}` };
    } else {
      const response = await this.api(mint.token, `/repositories/${target.repositoryId}`);
      if (response.status === 404) {
        optIn = { optedIn: false, reason: 'repository not found' };
      } else if (!response.ok) {
        throw new Error(`reading the repository failed with ${response.status}`);
      } else {
        const repo = await response.json() as { name: string; owner: { login: string; id: number }; default_branch: string };
        repository = { owner: repo.owner.login, ownerId: repo.owner.id, repo: repo.name, defaultBranch: repo.default_branch };
        this.calls++;
        optIn = await readOptIn(mint.token, repository);
      }
      takesOverCheck = await this.reportOptIn(repository === null ? target : { ...target, ...repository }, optIn.optedIn);
    }
    log('coordinator_opt_in', { ...this.logFields(), opted_in: optIn.optedIn, reason: optIn.reason });
    if (optIn.optedIn && optIn.others) {
      log('coordinator_opt_in_warning', { ...this.logFields(), workflow: optIn.workflow, ignored: optIn.others, reason: 'several dispatch workflows qualify' });
    }
    this.setMeta('opt_in', { ...optIn, expires: Date.now() + OPT_IN_TTL_MS, repository, takesOverCheck } satisfies CachedOptIn);
    return optIn;
  }

  /**
   * Tells the reconciler what the opt-in read found, and returns whether it holds that the repository's runs take over
   * a waiting check. A failure is logged, never blocks the coordinator and counts as false.
   */
  private async reportOptIn(target: Target, optedIn: boolean): Promise<boolean> {
    try {
      // Cloudflare does not say which limit a call to another Durable Object counts against, so it counts here too.
      this.calls++;
      return await this.env.RECONCILER.getByName(RECONCILER_NAME).recordOptIn(target, optedIn);
    } catch (error) {
      log('coordinator_record_opt_in_error', { ...this.logFields(), error: String(error) });
      return false;
    }
  }

  private async scheduleNext(): Promise<void> {
    const now = Date.now();
    const times: number[] = [];
    // A waiting check that could not be ended is tried again, and holds the state lane until then.
    const checkToEnd = this.checksToEnd().length > 0;
    if (checkToEnd) times.push(now + POLL_MS);
    for (const lane of LANES) {
      const active = this.sql.exec<{ at: number | null }>(
        `SELECT COALESCE(lease_until, check_at) AS at FROM work WHERE lane = ? AND ${ACTIVE}`, lane,
      ).toArray()[0];
      const next = active || (checkToEnd && lane === 'state') ? undefined : this.nextQueued(lane);
      if (active?.at) times.push(active.at);
      else if (next) times.push(next.check_at ?? now);
    }
    // Past the retention an active item keeps the storage, and its own times wake the alarm.
    const until = this.retainUntil();
    const pending = this.hasUnfinishedWork();
    if (until !== null && (until > now || !pending)) times.push(until);
    // Comments still waiting for their reaction wake the alarm at once, since no lane's time stands for them.
    if (this.getMeta<PendingReaction[]>('reactions')) times.push(now);
    // So does a step that did not fit the budget of the alarm.
    if (this.waitingLane !== null) times.push(now);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.max(now, Math.min(...times)));
  }
}
