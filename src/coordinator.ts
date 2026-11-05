import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { mintRepositoryToken } from './github';
import { log } from './log';
import { type OptIn, readOptIn } from './opt-in';
import type { Lane, Route, Target, Work } from './routing';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How long a delivery id is remembered. Longer than the 3 days in which GitHub can redeliver it. */
export const DELIVERY_RETENTION_MS = 7 * DAY;
/** A queued item older than this is dropped. A review is derived from the current head anyway. */
export const QUEUED_MAX_AGE_MS = DAY;
export const OPT_IN_TTL_MS = 5 * MINUTE;
/** How long a finished, skipped or dropped item stays, for the logs and the tests to read. */
export const FINISHED_RETENTION_MS = 7 * DAY;
/** How long an alarm may hold an item in `dispatching` before another pass takes it back. */
const LEASE_MS = 5 * MINUTE;
const RETRY_MS = MINUTE;
const LANES: readonly Lane[] = ['state', 'chat'];

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
}

export type ReceiveResult = { accepted: false; reason: string } | { accepted: true; effect: string };

// Each entry runs once, in order. Append new entries; never edit a shipped one.
const MIGRATIONS = [
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
];

const ACTIVE = `status IN ('dispatching', 'running')`;

/**
 * Orders the Manki work of one pull request or issue, named `<repository id>:<number>`. Request handlers only touch
 * SQLite, so an acknowledged delivery is durable before GitHub sees the 202. All GitHub I/O happens in `alarm()`.
 */
export class PrCoordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** The opt-in read in flight, shared by both lanes of one alarm pass. */
  private optInRead: Promise<OptIn> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
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

  /** Records a routed delivery and queues its work. A delivery id seen before is refused, which stops replays. */
  async receive(delivery: string, route: Extract<Route, { type: 'work' | 'close' }>): Promise<ReceiveResult> {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync((): ReceiveResult => {
      this.sql.exec('DELETE FROM deliveries WHERE received_at < ?', now - DELIVERY_RETENTION_MS);
      if (this.sql.exec('SELECT 1 FROM deliveries WHERE id = ?', delivery).toArray().length > 0) {
        return { accepted: false, reason: 'duplicate delivery' };
      }
      this.sql.exec('INSERT INTO deliveries (id, received_at) VALUES (?, ?)', delivery, now);
      this.setMeta('target', route.target);

      if (route.type === 'close') {
        const dropped = this.sql.exec(
          `UPDATE work SET status = 'dropped', note = 'pull request closed' WHERE status IN ('queued', 'dispatching') RETURNING id`,
        ).toArray().length;
        const merged = route.merged ? `, queued ${this.insert(route.merged, delivery, now)}` : '';
        return { accepted: true, effect: `closed, dropped ${dropped}${merged}` };
      }
      return { accepted: true, effect: this.enqueue(route.work, delivery, now) };
    });
    log('coordinator_receive', { ...this.logFields(), delivery, ...result });
    if (result.accepted) await this.ctx.storage.setAlarm(now);
    return result;
  }

  private insert(work: Work, delivery: string, now: number): string {
    const id = this.sql.exec<{ id: number }>(
      `INSERT INTO work (lane, kind, event, head_sha, object_id, sender, delivery, enqueued_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued') RETURNING id`,
      work.lane, work.kind, work.event, work.headSha, work.objectId, work.sender, delivery, now,
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
    if (work.kind === 'review') {
      const review = this.queued('state', ['review']).at(-1);
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
        // A review carries the id the dispatch names, so it replaces the queued trigger. A thread change does not.
        if (work.event.startsWith('pull_request_review.')) {
          this.sql.exec(
            'UPDATE work SET event = ?, head_sha = ?, object_id = ?, sender = ?, delivery = ? WHERE id = ?',
            work.event, work.headSha, work.objectId, work.sender, delivery, check.id,
          );
        }
        return `merged into work ${check.id}`;
      }
    }
    return `queued ${this.insert(work, delivery, now)}`;
  }

  override async alarm(): Promise<void> {
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
    // The object can stay in memory after `deleteAll()`, so its tables must exist again for the next delivery.
    this.migrate();
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
      if (this.sql.exec(`SELECT 1 FROM work WHERE lane = ? AND ${ACTIVE}`, lane).toArray().length > 0) return;
      const next = this.sql.exec<WorkRow>(
        `SELECT * FROM work WHERE lane = ? AND status = 'queued' ORDER BY id LIMIT 1`, lane,
      ).toArray()[0];
      if (next) await this.start(next);
    }));
  }

  private hasQueued(lane: Lane): boolean {
    return this.sql.exec(`SELECT 1 FROM work WHERE lane = ? AND status = 'queued' LIMIT 1`, lane).toArray().length > 0;
  }

  private row(id: number): WorkRow | undefined {
    return this.sql.exec<WorkRow>('SELECT * FROM work WHERE id = ?', id).toArray()[0];
  }

  private finish(id: number, status: WorkStatus, note: string): void {
    this.sql.exec('UPDATE work SET status = ?, note = ?, lease_until = NULL WHERE id = ?', status, note, id);
  }

  private async start(item: WorkRow): Promise<void> {
    this.sql.exec(`UPDATE work SET status = 'dispatching', lease_until = ? WHERE id = ?`, Date.now() + LEASE_MS, item.id);
    let optIn: OptIn;
    try {
      optIn = await this.optIn();
    } catch (error) {
      // The lease runs out after `RETRY_MS`, and the next pass takes the item again.
      this.sql.exec('UPDATE work SET lease_until = ? WHERE id = ? AND status = ?', Date.now() + RETRY_MS, item.id, 'dispatching');
      log('coordinator_opt_in_error', { ...this.logFields(), work_id: item.id, error: String(error) });
      return;
    }
    // A close may have dropped the item while the opt-in was read.
    if (this.row(item.id)?.status !== 'dispatching') return;

    log('coordinator_would_dispatch', {
      ...this.logFields(),
      work_id: item.id,
      lane: item.lane,
      kind: item.kind,
      event: item.event,
      head_sha: item.head_sha,
      object_id: item.object_id,
      sender: item.sender,
      delivery: item.delivery,
      opted_in: optIn.optedIn,
      opt_in_reason: optIn.reason,
    });
    this.finish(item.id, 'skipped', 'dispatch is not enabled');
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
    const mint = await mintRepositoryToken(this.env, target.installationId, target.repositoryId, { contents: 'read', metadata: 'read' });
    const optIn = mint.ok
      ? await readOptIn(mint.token, target)
      : { optedIn: false, reason: `token mint refused with ${mint.status}` };
    this.setMeta('opt_in', { ...optIn, expires: Date.now() + OPT_IN_TTL_MS });
    return optIn;
  }

  private async scheduleNext(): Promise<void> {
    const now = Date.now();
    const times: number[] = [];
    for (const lane of LANES) {
      const active = this.sql.exec<{ lease_until: number | null }>(
        `SELECT lease_until FROM work WHERE lane = ? AND ${ACTIVE}`, lane,
      ).toArray()[0];
      if (active?.lease_until) times.push(active.lease_until);
      else if (!active && this.hasQueued(lane)) times.push(now);
    }
    const newest = this.sql.exec<{ at: number | null }>('SELECT MAX(received_at) AS at FROM deliveries').one().at;
    if (newest !== null) times.push(newest + DELIVERY_RETENTION_MS);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.max(now, Math.min(...times)));
  }
}
