import { DurableObject } from 'cloudflare:workers';
import { dispatchInputs, runTitle } from './dispatch';
import type { Env } from './env';
import { githubApi, type MintResult, mintRepositoryToken } from './github';
import { log } from './log';
import { BOT_LOGIN } from './manki';
import { type OptIn, readOptIn } from './opt-in';
import type { Permissions } from './permissions';
import { DISPATCH_WORKFLOW, type Lane, type Route, type Target, type Work } from './routing';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a delivery's id and body hash are remembered. Longer than the 3 days in which GitHub can redeliver it. */
export const DELIVERY_RETENTION_MS = 7 * DAY;
/** A queued item older than this is dropped. A review is derived from the current head anyway. */
export const QUEUED_MAX_AGE_MS = DAY;
export const OPT_IN_TTL_MS = 5 * MINUTE;
/** How long a finished, skipped or dropped item stays, for the logs and the tests to read. */
export const FINISHED_RETENTION_MS = 7 * DAY;
/** How long an alarm may hold an item in `dispatching` before another pass takes it back. */
const LEASE_MS = 5 * MINUTE;
const LANES: readonly Lane[] = ['state', 'chat'];

/** The wait before each retry of a dispatch that failed with a 5xx or a network error. */
export const DISPATCH_BACKOFF_MS = [15_000, MINUTE, 5 * MINUTE];
/** The safety net behind the `workflow_run` webhook, which normally reports a run's end within seconds. */
export const POLL_MS = 2 * MINUTE;
/** A run still waiting for a runner after this is cancelled. */
export const QUEUED_RUN_TIMEOUT_MS = 30 * MINUTE;
/** A run going this long outlived the dispatch workflow's `timeout-minutes: 30`, so it is cancelled. */
export const RUNNING_RUN_TIMEOUT_MS = 40 * MINUTE;
/** A running item ends as `timed_out` this long after its dispatch, whatever its polls returned. */
export const RUN_DEADLINE_MS = 75 * MINUTE;
/** A dispatch answered without a run id fails once no matching run turned up in this time. */
export const RUN_LOOKUP_TIMEOUT_MS = 10 * MINUTE;
/** Per lane, stops a comment loop from starting runs without end. */
export const DISPATCHES_PER_HOUR = 30;
/** Per lane, for work from people outside the repository. It is counted apart, so they cannot use up the cap above. */
export const UNTRUSTED_DISPATCHES_PER_HOUR = 5;
/** A token is minted again once it expires within this time. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * MINUTE;
const NOT_STARTED = new Set(['queued', 'requested', 'waiting', 'pending']);

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
}

/** A delivery's id and the SHA-256 of its raw body. A delivery is a replay when either was seen before. */
export interface Delivery {
  id: string;
  bodyHash: string;
}

export type ReceiveResult = { accepted: false; reason: string } | { accepted: true; effect: string };

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
];

const ACTIVE = `status IN ('dispatching', 'running')`;

/** The wait before the next try after `errors` failures in a row: 2, 4, 8, then at most 16 minutes. */
export function backoff(errors: number): number {
  return POLL_MS * 2 ** Math.min(errors, 3);
}

/** Whether a 403 is GitHub's rate limit, which passes, rather than a refusal. */
function isRateLimited(response: Response): boolean {
  return response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0');
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
    return this.sql.exec('SELECT 1 FROM deliveries WHERE id IN (?, ?)', delivery.id, `sha256:${delivery.bodyHash}`).toArray().length > 0;
  }

  private remember(delivery: Delivery, now: number): void {
    this.sql.exec('INSERT INTO deliveries (id, received_at) VALUES (?, ?), (?, ?)', delivery.id, now, `sha256:${delivery.bodyHash}`, now);
  }

  /** Records a routed delivery and queues its work. A delivery whose id or body was seen before is refused. */
  async receive(delivery: Delivery, route: Extract<Route, { type: 'work' | 'close' }>): Promise<ReceiveResult> {
    this.ensureSchema();
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): ReceiveResult => {
      this.sql.exec('DELETE FROM deliveries WHERE received_at < ?', now - DELIVERY_RETENTION_MS);
      if (this.isReplay(delivery)) return { accepted: false, reason: 'duplicate delivery' };
      this.remember(delivery, now);
      this.setMeta('target', route.target);

      if (route.type === 'close') {
        const dropped = this.sql.exec(
          `UPDATE work SET status = 'dropped', note = 'pull request closed' WHERE status IN ('queued', 'dispatching') RETURNING id`,
        ).toArray().length;
        const merged = route.merged ? `, queued ${this.insert(route.merged, delivery.id, now)}` : '';
        return { accepted: true, effect: `closed, dropped ${dropped}${merged}` };
      }
      return { accepted: true, effect: this.enqueue(route.work, delivery.id, now) };
    });
    log('coordinator_receive', { ...this.logFields(), delivery: delivery.id, ...result });
    if (result.accepted) await this.ctx.storage.setAlarm(now);
    return result;
  }

  private insert(work: Work, delivery: string, now: number): string {
    const id = this.sql.exec<{ id: number }>(
      `INSERT INTO work (lane, kind, event, head_sha, object_id, sender, delivery, enqueued_at, status, trusted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING id`,
      work.lane, work.kind, work.event, work.headSha, work.objectId, work.sender, delivery, now, Number(work.trusted),
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
    if (work.event === 'issue_comment.edited' && work.objectId !== null) {
      // The run reads the comment as it is then, so one queued item covers every edit of the comment.
      const [same] = this.sql.exec<{ id: number }>(
        `SELECT id FROM work WHERE status = 'queued' AND lane = ? AND kind = ? AND object_id = ? AND trusted = ? AND event LIKE 'issue_comment.%'`,
        work.lane, work.kind, work.objectId, Number(work.trusted),
      ).toArray();
      if (same) {
        this.sql.exec('UPDATE work SET event = ?, sender = ?, delivery = ? WHERE id = ?', work.event, work.sender, delivery, same.id);
        return `merged into work ${same.id}`;
      }
    }

    if (work.kind === 'review') {
      // A request by someone outside the repository can neither take over a push review nor take on its head.
      if (!work.trusted) return `queued ${this.insert(work, delivery, now)}`;
      const review = this.queued('state', ['review']).filter((row) => row.trusted).at(-1);
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
      } else {
        // Each review request or tick is answered on its own, so one never hides another.
        return `queued ${this.insert(work, delivery, now)}`;
      }
      return `merged into work ${review.id}`;
    }

    if (work.kind === 'review_state') {
      // The check reads the PR when it runs, so one queued check covers every review and thread change before it.
      const [check] = this.queued('state', ['review_state']);
      if (check) {
        // A review carries the id the dispatch names, so it replaces the queued trigger. A thread change does not, and
        // an outsider's review never replaces a trusted trigger. Trusted work makes the check trusted.
        if (work.event.startsWith('pull_request_review.') && (work.trusted || !check.trusted)) {
          this.sql.exec(
            'UPDATE work SET event = ?, head_sha = ?, object_id = ?, sender = ?, delivery = ?, trusted = ? WHERE id = ?',
            work.event, work.headSha, work.objectId, work.sender, delivery, Number(work.trusted), check.id,
          );
        } else if (work.trusted) {
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
      await this.advance();
    } catch (error) {
      log('coordinator_alarm_error', { ...this.logFields(), error: String(error) });
    }
    await this.scheduleNext();
  }

  /** Deletes all storage once nothing is pending and the newest delivery has aged out. */
  private async cleanUpWhenIdle(): Promise<boolean> {
    const pending = this.sql.exec(`SELECT 1 FROM work WHERE status = 'queued' OR ${ACTIVE}`).toArray().length > 0;
    const newest = this.sql.exec<{ at: number | null }>('SELECT MAX(received_at) AS at FROM deliveries').one().at;
    if (pending || (newest !== null && Date.now() - newest < DELIVERY_RETENTION_MS)) return false;
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
        if (next && (next.check_at ?? 0) <= now) await this.start(next);
      } catch (error) {
        log('coordinator_lane_error', { ...this.logFields(), lane, error: String(error) });
      }
    }));
  }

  private nextQueued(lane: Lane): WorkRow | undefined {
    return this.sql.exec<WorkRow>(`SELECT * FROM work WHERE lane = ? AND status = 'queued' ORDER BY id LIMIT 1`, lane).toArray()[0];
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
    const mint = await mintRepositoryToken(this.env, target.installationId, target.repositoryId, permissions);
    if (mint.ok) this.tokens.set(key, { token: mint.token, expiresAt: mint.expiresAt });
    return mint;
  }

  /** Returns a token for this repository alone. Returns null when GitHub refuses, which it does for an ungranted permission. */
  private async token(permissions: Permissions): Promise<string | null> {
    const mint = await this.mint(permissions);
    if (mint.ok) return mint.token;
    log('coordinator_token_refused', { ...this.logFields(), permissions, status: mint.status, message: mint.message });
    return null;
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
      if (this.capped(item)) return;
      await this.dispatch(item);
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

  /** Starts a run for `item`. Every GitHub call is followed by a fresh read of the row before anything is written. */
  private async dispatch(item: WorkRow): Promise<void> {
    const target = this.target();
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
      this.setMeta('opt_in', { optedIn: false, reason: 'installation lacks actions: write', expires: Date.now() + OPT_IN_TTL_MS });
      this.finish(item.id, 'skipped', 'installation lacks actions: write');
      return;
    }

    const now = Date.now();
    this.sql.exec(
      'UPDATE work SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ?',
      now, item.id,
    );
    const attempts = current.attempts + 1;
    let response: Response | null = null;
    try {
      response = await githubApi(token, `/repos/${target.owner}/${target.repo}/actions/workflows/${DISPATCH_WORKFLOW}/dispatches`, {
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

    if (response?.status === 200) {
      const { workflow_run_id } = await response.json() as { workflow_run_id?: number };
      this.markRunning(latest, workflow_run_id ?? null, 'dispatched');
    } else if (response?.status === 204) {
      this.markRunning(latest, null, 'dispatched without run details');
    } else if (response === null || response.status >= 500 || response.status === 429 || isRateLimited(response)) {
      if (attempts > DISPATCH_BACKOFF_MS.length) {
        this.finish(item.id, 'failed', `dispatch failed ${attempts} times, last with ${response?.status ?? 'a network error'}`);
      } else {
        this.sql.exec('UPDATE work SET lease_until = ? WHERE id = ?', Date.now() + DISPATCH_BACKOFF_MS[attempts - 1], item.id);
        log('coordinator_dispatch_retry', { ...this.logFields(), work_id: item.id, attempts, status: response?.status ?? null });
      }
    } else {
      // 403, 404 and 422 mean the permission, the file or its `workflow_dispatch` trigger is missing.
      this.sql.exec(`DELETE FROM meta WHERE key = 'opt_in'`);
      this.finish(item.id, 'failed', `dispatch refused with ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  }

  /** Re-reads the PR before a review starts. Returns false when the review was dropped. */
  private async refreshReview(item: WorkRow, target: Target): Promise<boolean> {
    const token = await this.token({ pull_requests: 'read' });
    if (token === null) throw new Error('could not mint a token to read the pull request');
    const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/pulls/${target.number}`);
    if (!response.ok) throw new Error(`reading the pull request failed with ${response.status}`);
    const pr = await response.json() as { state: string; draft?: boolean; head: { sha: string } };
    if (!this.isDispatching(item.id)) return false;
    if (pr.state !== 'open') {
      this.finish(item.id, 'dropped', 'pull request closed');
      return false;
    }
    if (item.event.startsWith('pull_request.')) {
      if (pr.draft) {
        this.finish(item.id, 'dropped', 'pull request is a draft');
        return false;
      }
      this.sql.exec('UPDATE work SET head_sha = ? WHERE id = ?', pr.head.sha, item.id);
    }
    return true;
  }

  private markRunning(item: WorkRow, runId: number | null, note: string): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE work SET status = 'running', run_id = ?, dispatched_at = ?, check_at = ?, lease_until = NULL, errors = 0, note = ? WHERE id = ?`,
      runId, now, now + POLL_MS, note, item.id,
    );
    log('coordinator_dispatched', { ...this.logFields(), ...this.describe(this.row(item.id)!), run_id: runId, note });
  }

  /**
   * Finds the run an earlier attempt started when its response was lost. Its `display_title` names the item's
   * delivery id, so only that item's run matches. It must also come from the App and belong to no other item.
   */
  private async findRun(item: WorkRow, target: Target): Promise<number | null> {
    const token = await this.token({ actions: 'read' });
    if (token === null) return null;
    const since = new Date((item.first_attempt_at ?? Date.now()) - MINUTE).toISOString();
    const response = await githubApi(
      token,
      `/repos/${target.owner}/${target.repo}/actions/workflows/${DISPATCH_WORKFLOW}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${since}`)}&per_page=50`,
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
    if (now - dispatchedAt > RUN_DEADLINE_MS) {
      this.finish(item.id, 'timed_out', 'no end of the run seen in time');
      return;
    }
    const target = this.target();

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
    if (token === null) return;
    const response = await githubApi(token, `/repos/${target.owner}/${target.repo}/actions/runs/${item.run_id}`);
    if (this.row(item.id)?.status !== 'running') return;
    if (response.status === 404) {
      this.finish(item.id, 'done', 'run deleted');
      return;
    }
    if (!response.ok) return;
    this.polled(item.id);
    const run = await response.json() as { status: string; conclusion: string | null; run_started_at?: string };
    if (run.status === 'completed') {
      this.finish(item.id, 'done', 'run completed (poll)', run.conclusion);
      return;
    }
    const startedAt = run.run_started_at ? Date.parse(run.run_started_at) : dispatchedAt;
    if (NOT_STARTED.has(run.status) && now - dispatchedAt > QUEUED_RUN_TIMEOUT_MS) {
      await this.cancel(item, target, 'run never started');
    } else if (!NOT_STARTED.has(run.status) && now - startedAt > RUNNING_RUN_TIMEOUT_MS) {
      await this.cancel(item, target, 'run went past its timeout');
    }
  }

  /** Records a poll that reached GitHub, so the next one comes after the normal interval. */
  private polled(id: number): void {
    this.sql.exec('UPDATE work SET errors = 0, check_at = ? WHERE id = ?', Date.now() + POLL_MS, id);
  }

  /** Cancels a run that overran. A failed cancel keeps the item running, so the next poll tries again. */
  private async cancel(item: WorkRow, target: Target, reason: string): Promise<void> {
    const token = await this.token({ actions: 'write' });
    const response = token === null
      ? null
      : await githubApi(token, `/repos/${target.owner}/${target.repo}/actions/runs/${item.run_id}/cancel`, { method: 'POST' });
    if (this.row(item.id)?.status !== 'running') return;
    if (response?.ok) {
      this.finish(item.id, 'timed_out', `${reason}, cancel requested`);
    } else {
      log('coordinator_cancel_failed', { ...this.logFields(), work_id: item.id, run_id: item.run_id, reason, status: response?.status ?? null });
    }
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
    const cached = this.getMeta<OptIn & { expires: number }>('opt_in');
    if (cached && cached.expires > Date.now()) return { optedIn: cached.optedIn, reason: cached.reason };
    this.optInRead ??= this.readOptIn().finally(() => {
      this.optInRead = null;
    });
    return this.optInRead;
  }

  private async readOptIn(): Promise<OptIn> {
    const target = this.getMeta<Target>('target');
    if (!target) return { optedIn: false, reason: 'no target recorded' };
    const mint = await this.mint({ contents: 'read', metadata: 'read' });
    const optIn = mint.ok
      ? await readOptIn(mint.token, target)
      : { optedIn: false, reason: `token mint refused with ${mint.status}` };
    log('coordinator_opt_in', { ...this.logFields(), opted_in: optIn.optedIn, reason: optIn.reason });
    this.setMeta('opt_in', { ...optIn, expires: Date.now() + OPT_IN_TTL_MS });
    return optIn;
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
    const newest = this.sql.exec<{ at: number | null }>('SELECT MAX(received_at) AS at FROM deliveries').one().at;
    if (newest !== null) times.push(newest + DELIVERY_RETENTION_MS);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.max(now, Math.min(...times)));
  }
}
