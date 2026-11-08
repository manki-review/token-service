import { DurableObject } from 'cloudflare:workers';
import { dispatchInputs, runTitle } from './dispatch';
import type { Env } from './env';
import { githubApi, hasWriteAccess, isRateLimited, type MintResult, mintRepositoryToken } from './github';
import { log } from './log';
import {
  type BaseConfig, BOT_LOGIN, type BoxChange, cancelledProgress, HELP_REPLY, isRunningProgress, MANKI_LOGINS, matchSkipRule, parseConfig, settingsHead, withSettingsStatus,
  REVIEW_MODES, type ReviewMode, reviewsDrafts, setBoxes, skipRulesOf,
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
/** How long a queued review lets thread replies go first. */
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
/** How long a review waits before each new read of a PR whose mergeability GitHub has not computed yet. */
const MERGEABILITY_RETRY_MS = [5_000, 15_000];
/** Marks the Worker's note that a review waits for a rebase. Manki removes it once a review posts. */
export const CONFLICT_NOTE_MARKER = '<!-- manki-conflict-note -->';
const NOT_STARTED = new Set(['queued', 'requested', 'waiting', 'pending']);
/** A larger `.manki.yml` is not parsed for skip rules, as it costs too much CPU in an alarm. */
const MAX_CONFIG_BYTES = 64 * 1024;

export type WorkStatus = 'queued' | 'dispatching' | 'running' | 'done' | 'failed' | 'timed_out' | 'dropped' | 'skipped';

export interface WorkRow extends Record<string, string | number | null> {
  id: number;
  lane: Lane;
  kind: Work['kind'];
  event: string;
  head_sha: string | null;
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
  /** For a queued review, when a thread reply first went ahead of it. */
  passed_at: number | null;
  /** How often a review read the PR again because GitHub had not computed its mergeability. */
  merge_checks: number;
}

/** The fields of `GET /repos/{owner}/{repo}/pulls/{number}` a review start reads. */
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

/** The opt-in result as cached, with the repository as GitHub names it when it was read. */
type CachedOptIn = OptIn & {
  expires: number;
  repository: Repository | null;
};

/** A delivery's id and the SHA-256 of its raw body. A delivery is a replay when either was seen before. */
export interface Delivery {
  id: string;
  /** Null for a body that can repeat in a genuine delivery, which only its id identifies. */
  bodyHash: string | null;
}

/** A comment `receive` queued a command from, waiting for its eyes reaction. `pulls` names a review comment. */
interface PendingReaction {
  comments: 'issues' | 'pulls';
  commentId: number;
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
];

const ACTIVE = `status IN ('dispatching', 'running')`;
/** The event of a review command in a new comment. A settings box review is always an edit, so it never has this event. */
const REVIEW_COMMAND_EVENT = 'issue_comment.created';

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
        // A late redelivery of the push, after a catch-up already reviews this head, must not review it twice.
        const state = this.reviewState(route.work.headSha);
        if (state !== null) return { accepted: true, effect: 'head already reviewed or under review' };
      }
      if (route.work.acknowledge && route.work.writer && route.work.objectId !== null) {
        const reaction: PendingReaction = {
          comments: route.work.event.startsWith('pull_request_review_comment.') ? 'pulls' : 'issues',
          commentId: route.work.objectId,
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

  /**
   * Records a head pushed by a bot, which Manki does not review, without queuing work. The cron then knows the head
   * was skipped on purpose and does not catch it up.
   */
  async markSeen(delivery: Delivery, target: Target, head: string): Promise<ReceiveResult> {
    this.ensureSchema();
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): ReceiveResult => {
      if (this.isReplay(delivery)) return { accepted: false, reason: 'duplicate delivery' };
      this.remember(delivery, now);
      this.setMeta('target', target);
      this.setMeta('bot_head', head);
      return { accepted: true, effect: 'head marked as seen' };
    });
    log('coordinator_receive', { ...this.logFields(), delivery: delivery.id, ...result });
    if (result.accepted) await this.scheduleNext();
    return result;
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

  /** Queues `work`, merging it with what is already queued where one run covers both. */
  private enqueue(work: Work, delivery: string, now: number): string {
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
      const [check] = this.queued('state', ['review_state']);
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
      // Both read the opt-in through `optIn`, which shares one read between them.
      await Promise.all([this.react(), this.advance()]);
    } catch (error) {
      log('coordinator_alarm_error', { ...this.logFields(), error: String(error) });
    }
    await this.scheduleNext();
  }

  /**
   * Adds the eyes reaction to each comment `receive` queued a command from, so the commenter sees it was received
   * before the run starts. Only a repository that takes dispatches gets one. A failure is logged and never retried.
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
    for (const { comments, commentId } of pending) {
      try {
        // A comment on a pull request needs `pull_requests: write` to take a reaction, one on a plain issue `issues: write`.
        const token = await this.token(comments === 'pulls' ? { pull_requests: 'write' } : { issues: 'write', pull_requests: 'write' });
        if (token === null) continue;
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
    await Promise.all(LANES.map(async (lane) => {
      try {
        const running = this.sql.exec<WorkRow>(`SELECT * FROM work WHERE lane = ? AND status = 'running'`, lane).toArray()[0];
        if (running && (running.check_at ?? 0) <= now) await this.poll(running);
        if (this.sql.exec(`SELECT 1 FROM work WHERE lane = ? AND ${ACTIVE}`, lane).toArray().length > 0) return;
        const next = this.nextQueued(lane);
        // A queued item's `check_at` holds it until the dispatch cap allows another run.
        if (!next || (next.check_at ?? 0) > now) return;
        if (next.kind === 'thread') {
          this.sql.exec(`UPDATE work SET passed_at = ? WHERE lane = ? AND status = 'queued' AND kind = 'review' AND id < ? AND passed_at IS NULL`, now, lane, next.id);
        }
        await this.start(next);
      } catch (error) {
        log('coordinator_lane_error', { ...this.logFields(), lane, error: String(error) });
      }
    }));
  }

  /**
   * Returns the item a lane starts next: the oldest queued one, except that a queued thread reply goes before a review.
   * The review then sees each thread as the reply leaves it, instead of requesting changes the reply withdraws a minute
   * later. Once replies have gone ahead of a review for `REPLY_FIRST_MS`, the review goes first again, so a stream of
   * replies cannot hold it back. Time spent waiting behind a run does not count.
   */
  private nextQueued(lane: Lane): WorkRow | undefined {
    const next = this.sql.exec<WorkRow>(`SELECT * FROM work WHERE lane = ? AND status = 'queued' ORDER BY id LIMIT 1`, lane).toArray()[0];
    if (next?.kind !== 'review' || (next.passed_at !== null && Date.now() - next.passed_at >= REPLY_FIRST_MS)) return next;
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

  /** Mints a token for this repository alone, or reuses one this instance minted that is not about to expire. */
  private async mint(permissions: Permissions): Promise<MintResult> {
    const target = this.target();
    const key = JSON.stringify([target.installationId, target.repositoryId, Object.entries(permissions).sort()]);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return { ok: true, ...cached };
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
      if (this.capped(item)) return;
      if (item.kind === 'help') await this.answerHelp(item);
      else await this.dispatch(item, optIn.workflow);
    } catch (error) {
      // The lease runs out after the backoff, and the next pass takes the item again.
      this.sql.exec(
        `UPDATE work SET lease_until = ?, errors = errors + 1 WHERE id = ? AND status = 'dispatching'`,
        Date.now() + backoff(item.errors), item.id,
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
    // Only a review nobody asked for waits out a pause. A request, a reply or a settings box review still runs.
    const { pause, settings } = this.reported();
    if (item.kind === 'review' && item.event.startsWith('pull_request.') && (pause !== null || settings.paused)) {
      this.finish(item.id, 'skipped', 'pull request is paused');
      return;
    }
    if (item.kind === 'review' && !(await this.refreshReview(item, target))) return;

    const current = this.row(item.id);
    if (current?.status !== 'dispatching') return;
    if (current.attempts > 0) {
      const runId = await this.findRun(current, target);
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

    const now = Date.now();
    this.sql.exec(
      'UPDATE work SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), workflow = ? WHERE id = ?',
      now, workflow, item.id,
    );
    const attempts = current.attempts + 1;
    let response: Response | null = null;
    try {
      response = await githubApi(token, `/repos/${target.owner}/${target.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
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

    if (response?.status === 200) {
      const { workflow_run_id } = await response.json() as { workflow_run_id?: number };
      this.markRunning(latest, workflow_run_id ?? null, 'dispatched');
    } else if (response?.status === 204) {
      this.markRunning(latest, null, 'dispatched without run details');
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
        effects.push(ticked ? 'paused' : 'resumed');
      } else if (ticked && (REVIEW_MODES as readonly string[]).includes(box)) {
        effects.push(await this.reviewBox(item, box as ReviewMode, at));
      } else if (ticked && box === 'cancel') {
        effects.push(await this.cancelReview(item, at));
      }
    }
    if (this.isDispatching(item.id)) this.finish(item.id, 'done', effects.join(', ') || 'nothing changed');
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
      const pr = await githubApi(token, `${repo}/pulls/${target.number}`);
      if (!pr.ok) throw new Error(`reading the pull request failed with ${pr.status}`);
      const head = ((await pr.json()) as PullRequestRead).head.sha;
      const progress = await this.runningProgress(token, item, running, target);
      const reviewing = running.head_sha ?? (progress && settingsHead(progress.body));
      if (!reviewing) return this.requestReview(item, mode);
      if (head.startsWith(reviewing)) {
        // The box may be ticked on another settings comment than the running review's, which then gets unticked too.
        const ticked = item.object_id !== null && item.object_id !== progress?.id ? await this.readComment(token, repo, item.object_id) : null;
        for (const comment of [progress, ticked]) {
          if (!comment) continue;
          const body = withSettingsStatus(comment.body, `already reviewing \`${head.slice(0, 7)}\``, ['again']);
          const edited = await githubApi(token, `${repo}/issues/comments/${comment.id}`, { method: 'PATCH', body: { body } });
          if (!edited.ok) throw new Error(`showing the running review failed with ${edited.status}`);
        }
        return `already reviewing ${head.slice(0, 7)}`;
      }
    }
    const replaced = await this.cancelReview(item, at, mode === 'deeper' ? 'a deeper review' : 'a review of the new commits');
    return `${replaced}, ${this.requestReview(item, mode)}`;
  }

  /** Returns comment `id` of `repo`, or null when it is gone. */
  private async readComment(token: string, repo: string, id: number): Promise<{ id: number; body: string } | null> {
    const read = await githubApi(token, `${repo}/issues/comments/${id}`);
    if (read.status === 404) return null;
    if (!read.ok) throw new Error(`reading the settings comment failed with ${read.status}`);
    const { body } = await read.json() as { body?: string };
    return body ? { id, body } : null;
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
      // The run's own post step can no longer mint a token, so the Worker ends its progress comment and check instead.
      const failed = (part: string) => (error: unknown) => {
        log('coordinator_cancel_report_failed', { ...this.logFields(), work_id: running.id, part, error: error instanceof Error ? error.message : String(error) });
      };
      const headline = replacement ? `Review replaced by ${replacement} requested by @${item.sender}.` : `Review cancelled by @${item.sender}.`;
      await this.markCommentCancelled(item, running, target, headline).catch(failed('comment'));
      await this.markCheckCancelled(running, target, headline).catch(failed('check'));
    }
    return `${replacement ? 'replacing' : 'cancel of'} work ${running.id} requested`;
  }

  /**
   * Marks the progress comment of the cancelled review as cancelled, with `headline`. The comment is the one whose box was
   * ticked, or else Manki's newest progress comment of a review that has not ended. Without one, it does nothing.
   */
  private async markCommentCancelled(item: WorkRow, running: WorkRow, target: Target, headline: string): Promise<void> {
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null) return;
    const comment = await this.runningProgress(token, item, running, target);
    if (comment === null) {
      log('coordinator_cancel_no_comment', { ...this.logFields(), work_id: running.id });
      return;
    }
    const path = `/repos/${target.owner}/${target.repo}/issues/comments/${comment.id}`;
    const response = await githubApi(token, path, { method: 'PATCH', body: { body: cancelledProgress(comment.body, headline) } });
    if (!response.ok) throw new Error(`marking the progress comment cancelled failed with ${response.status}`);
  }

  /** Completes the in-progress `Manki` checks on the cancelled review's head as cancelled, with `headline` as the summary. */
  private async markCheckCancelled(running: WorkRow, target: Target, headline: string): Promise<void> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    const checks = await this.token({ checks: 'write' });
    if (checks === null) return;
    let head = running.head_sha;
    if (head === null) {
      const pr = await githubApi(checks, `${repo}/pulls/${target.number}`);
      if (!pr.ok) throw new Error(`reading the pull request failed with ${pr.status}`);
      head = ((await pr.json()) as PullRequestRead).head.sha;
    }
    // Another app's check of the same name is not Manki's, and the App could not edit it.
    const list = await githubApi(checks, `${repo}/commits/${head}/check-runs?check_name=Manki&status=in_progress&app_id=${this.env.APP_ID}`);
    if (!list.ok) throw new Error(`listing the Manki checks failed with ${list.status}`);
    const { check_runs: runs } = await list.json() as { check_runs: Array<{ id: number }> };
    for (const run of runs) {
      const response = await githubApi(checks, `${repo}/check-runs/${run.id}`, {
        method: 'PATCH',
        body: { status: 'completed', conclusion: 'cancelled', output: { title: 'Review cancelled', summary: headline } },
      });
      if (!response.ok) throw new Error(`completing the Manki check failed with ${response.status}`);
    }
  }

  /** Returns the progress comment of the cancelled review, or null when Manki has none that is still running. */
  private async runningProgress(token: string, item: WorkRow, running: WorkRow, target: Target): Promise<{ id: number; body: string } | null> {
    const repo = `/repos/${target.owner}/${target.repo}`;
    if (item.object_id !== null) {
      const read = await githubApi(token, `${repo}/issues/comments/${item.object_id}`);
      if (read.ok) {
        const { body } = await read.json() as { body?: string };
        if (body && isRunningProgress(body)) return { id: item.object_id, body };
      } else if (read.status !== 404) {
        throw new Error(`reading the settings comment failed with ${read.status}`);
      }
    }
    // Only comments edited since the run started can belong to it. GitHub lists them oldest first.
    const since = new Date((running.dispatched_at ?? Date.now()) - MINUTE).toISOString();
    const list = await githubApi(token, `${repo}/issues/${target.number}/comments?since=${since}&per_page=100`);
    if (!list.ok) throw new Error(`listing the PR comments failed with ${list.status}`);
    const comments = await list.json() as Array<{ id: number; body?: string; user?: { login?: string } | null }>;
    const newest = comments.reverse().find((c) => MANKI_LOGINS.includes(c.user?.login ?? '') && !!c.body && isRunningProgress(c.body));
    return newest ? { id: newest.id, body: newest.body! } : null;
  }

  /** Puts back the boxes someone without write access changed: Pause as it applies, and every other box unticked. */
  private async revertBoxes(item: WorkRow): Promise<void> {
    const target = await this.verifiedTarget();
    if (!target) throw new Error('the repository could not be read');
    const token = await this.token({ issues: 'write', pull_requests: 'write' });
    if (token === null || item.object_id === null) return;
    const path = `/repos/${target.owner}/${target.repo}/issues/comments/${item.object_id}`;
    const read = await githubApi(token, path);
    if (!read.ok) throw new Error(`reading the settings comment failed with ${read.status}`);
    const { body } = await read.json() as { body?: string };
    const { paused } = this.reported().settings;
    const reverted = setBoxes(body ?? '', editOf(item).changes.map(({ box }) => ({ box, ticked: box === 'pause' && paused })));
    if (reverted === body) return;
    const response = await githubApi(token, path, { method: 'PATCH', body: { body: reverted } });
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
      const reaction = await githubApi(token, `${repo}/${comments}/comments/${item.object_id}/reactions`, { method: 'POST', body: { content: '+1' } });
      if (!reaction.ok) log('coordinator_reaction_failed', { ...this.logFields(), comment_id: item.object_id, status: reaction.status });
    }
    // Manki marks the reply to a PR comment as its answer, as its `markAnswers` does.
    const body = comments === 'issues' ? `${HELP_REPLY}\n<!-- manki-answered:${item.object_id} -->` : HELP_REPLY;
    const response = await githubApi(token, `${repo}/issues/${target.number}/comments`, { method: 'POST', body: { body } });
    if (!response.ok) throw new Error(`posting the help reply failed with ${response.status}`);
    this.sql.exec('UPDATE work SET dispatched_at = ? WHERE id = ?', Date.now(), item.id);
    this.finish(item.id, 'done', 'answered help');
  }

  /** Re-reads the PR before a review starts. Returns false when the review was dropped. */
  private async refreshReview(item: WorkRow, target: Target): Promise<boolean> {
    const token = await this.token({ pull_requests: 'read' });
    if (token === null) throw new Error('could not mint a token to read the pull request');
    const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/pulls/${target.number}`);
    if (!response.ok) throw new Error(`reading the pull request failed with ${response.status}`);
    const pr = await response.json() as PullRequestRead;
    if (!this.isDispatching(item.id)) return false;
    if (pr.state !== 'open') {
      this.finish(item.id, 'dropped', 'pull request closed');
      return false;
    }
    if (item.event.startsWith('pull_request.')) {
      // A retry after a dispatch attempt may find that attempt's run, so only the first attempt can drop or skip.
      const first = item.attempts === 0;
      const config = first ? await this.baseConfig(pr, target) : null;
      if (!this.isDispatching(item.id)) return false;
      // A draft is reviewed on request, such as by its settings box, unless the base config reviews drafts.
      if (first && pr.draft && !reviewsDrafts(config)) {
        this.finish(item.id, 'dropped', 'pull request is a draft');
        return false;
      }
      const rule = first ? this.skipRule(config, pr, item.head_sha, item.sender, target) : null;
      if (rule !== null) {
        await this.reportSkipped(pr.head.sha, rule, target);
        if (!this.isDispatching(item.id)) return false;
      }
      // Who pushed a newer head is unknown, so its sender goes with the queued head, also for a retry after a failure.
      this.sql.exec(
        `UPDATE work SET sender = CASE WHEN head_sha IS ? THEN sender ELSE '' END, head_sha = ? WHERE id = ?`,
        pr.head.sha, pr.head.sha, item.id,
      );
      if (rule !== null) {
        this.finish(item.id, 'skipped', `matches the skip rule for ${rule}`, 'skipped');
        return false;
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
        return false;
      }
      if (conflict) {
        await this.reportConflict(pr, target);
        if (this.isDispatching(item.id)) this.finish(item.id, 'skipped', `conflicts with ${pr.base.ref}`, 'conflict');
        return false;
      }
    }
    return true;
  }

  /**
   * Tells the PR's author that its review waits for a rebase: one Manki note, which replaces the note an earlier skip
   * posted, and a `Manki` check on the head that asks for the rebase.
   */
  private async reportConflict(pr: PullRequestRead, target: Target): Promise<void> {
    const text = `This PR conflicts with \`${pr.base.ref}\`. Rebase it, and Manki reviews it then.`;
    const token = await this.token({ issues: 'write' });
    if (token !== null) {
      const body = `${text}\n\n${CONFLICT_NOTE_MARKER}`;
      const noteId = this.getMeta<number>('conflict_note');
      const edited = noteId === null ? null
        : await githubApi(token, `/repos/${target.owner}/${target.repo}/issues/comments/${noteId}`, { method: 'PATCH', body: { body } });
      // Manki deletes the note once a review posts, so a note that is gone is posted again.
      if (edited === null || edited.status === 404) {
        const posted = await githubApi(token, `/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`, { method: 'POST', body: { body } });
        if (!posted.ok) throw new Error(`posting the conflict note failed with ${posted.status}`);
        this.setMeta('conflict_note', ((await posted.json()) as { id: number }).id);
      } else if (!edited.ok) {
        throw new Error(`updating the conflict note failed with ${edited.status}`);
      }
    }
    const checks = await this.token({ checks: 'write' });
    if (checks === null) return;
    const response = await githubApi(checks, `/repos/${target.owner}/${target.repo}/check-runs`, {
      method: 'POST',
      body: {
        name: 'Manki',
        head_sha: pr.head.sha,
        status: 'completed',
        conclusion: 'action_required',
        ...(pr.html_url && { details_url: pr.html_url }),
        output: { title: 'Rebase needed', summary: text },
      },
    });
    if (!response.ok) throw new Error(`creating the rebase check failed with ${response.status}`);
  }

  /**
   * Reads `.manki.yml` from the PR's base branch, so a PR cannot change what applies to itself. A missing, oversized or
   * unparsable file gives null, which sets nothing, as in Manki.
   */
  private async baseConfig(pr: PullRequestRead, target: Target): Promise<BaseConfig> {
    const token = await this.token({ contents: 'read', metadata: 'read' });
    if (token === null) return null;
    const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/contents/.manki.yml?ref=${encodeURIComponent(pr.base.ref)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`reading .manki.yml failed with ${response.status}`);
    const file = await response.json() as { type?: string; size?: number; encoding?: string; content?: string };
    if (file.type !== 'file' || file.encoding !== 'base64' || file.content === undefined || (file.size ?? 0) > MAX_CONFIG_BYTES) return null;
    return parseConfig(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))));
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
    const token = await this.token({ checks: 'write' });
    if (token === null) return;
    const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/check-runs`, {
      method: 'POST',
      body: {
        name: 'Manki',
        head_sha: head,
        status: 'completed',
        conclusion: 'skipped',
        output: { title: 'Review skipped', summary: `This PR matches the skip rule for ${rule} in \`.manki.yml\` on the base branch.` },
      },
    });
    if (!response.ok) throw new Error(`creating the skipped check failed with ${response.status}`);
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
    const response = await githubApi(
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
    const response = token === null ? null : await githubApi(token, `/repos/${target.owner}/${target.repo}/actions/runs/${item.run_id}`);
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
      await this.cancel(item, target, 'no end of the run seen in time');
      return;
    }
    if (!run) return;
    const startedAt = run.run_started_at ? Date.parse(run.run_started_at) : dispatchedAt;
    if (NOT_STARTED.has(run.status) && now - dispatchedAt > QUEUED_RUN_TIMEOUT_MS) {
      await this.cancel(item, target, 'run never started', item.requeues === 0);
    } else if (!NOT_STARTED.has(run.status) && now - startedAt > RUNNING_RUN_TIMEOUT_MS) {
      await this.cancel(item, target, 'run went past its timeout');
    }
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
    const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/actions/runs/${item.run_id}/cancel`, { method: 'POST' });
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
    if (!mint.ok) {
      optIn = { optedIn: false, reason: `token mint refused with ${mint.status}` };
    } else {
      const response = await githubApi(mint.token, `/repositories/${target.repositoryId}`);
      if (response.status === 404) {
        optIn = { optedIn: false, reason: 'repository not found' };
      } else if (!response.ok) {
        throw new Error(`reading the repository failed with ${response.status}`);
      } else {
        const repo = await response.json() as { name: string; owner: { login: string; id: number }; default_branch: string };
        repository = { owner: repo.owner.login, ownerId: repo.owner.id, repo: repo.name, defaultBranch: repo.default_branch };
        optIn = await readOptIn(mint.token, repository);
      }
      await this.reportOptIn(repository === null ? target : { ...target, ...repository }, optIn.optedIn);
    }
    log('coordinator_opt_in', { ...this.logFields(), opted_in: optIn.optedIn, reason: optIn.reason });
    if (optIn.optedIn && optIn.others) {
      log('coordinator_opt_in_warning', { ...this.logFields(), workflow: optIn.workflow, ignored: optIn.others, reason: 'several dispatch workflows qualify' });
    }
    this.setMeta('opt_in', { ...optIn, expires: Date.now() + OPT_IN_TTL_MS, repository } satisfies CachedOptIn);
    return optIn;
  }

  /** Tells the reconciler what the opt-in read found. A failure is logged and never blocks the coordinator. */
  private async reportOptIn(target: Target, optedIn: boolean): Promise<void> {
    try {
      await this.env.RECONCILER.getByName(RECONCILER_NAME).recordOptIn(target, optedIn);
    } catch (error) {
      log('coordinator_record_opt_in_error', { ...this.logFields(), error: String(error) });
    }
  }

  private async scheduleNext(): Promise<void> {
    const now = Date.now();
    const times: number[] = [];
    for (const lane of LANES) {
      const active = this.sql.exec<{ at: number | null }>(
        `SELECT COALESCE(lease_until, check_at) AS at FROM work WHERE lane = ? AND ${ACTIVE}`, lane,
      ).toArray()[0];
      const next = active ? undefined : this.nextQueued(lane);
      if (active?.at) times.push(active.at);
      else if (next) times.push(next.check_at ?? now);
    }
    // Past the retention an active item keeps the storage, and its own times wake the alarm.
    const until = this.retainUntil();
    const pending = this.hasUnfinishedWork();
    if (until !== null && (until > now || !pending)) times.push(until);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.max(now, Math.min(...times)));
  }
}
