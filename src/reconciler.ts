import { DurableObject } from 'cloudflare:workers';
import { createAppJWT } from './app-jwt';
import { allowedAccounts, type Env } from './env';
import { githubApi, githubGraphql, isRateLimited, mintRepositoryToken } from './github';
import { log } from './log';
import { BOT_LOGIN, MANKI_COMMENT_MARKER } from './manki';
import { STALE_COMMENT_MS, type Target } from './routing';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The name of the one `Reconciler` instance. */
export const RECONCILER_NAME = 'global';
/** Only a delivery whose first attempt failed within this window is redelivered. Older comments are dropped anyway. */
export const REDELIVERY_WINDOW_MS = STALE_COMMENT_MS;
/** Redeliveries per delivery, so a delivery that breaks the Worker cannot loop. */
export const MAX_REDELIVERIES = 2;
/** Open PRs updated within this window are checked for a head without a Manki review. */
export const CATCH_UP_WINDOW_MS = DAY;
/** GitHub calls per pass. Keeps a pass under the Free plan's 50 subrequests per invocation. */
export const SUBREQUEST_BUDGET = 40;
/** Pages of deliveries one pass reads at most. A longer scan goes on from the same page in the next pass. */
export const MAX_DELIVERY_PAGES = 10;
const HANDLED_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'issue_comment',
  'workflow_run',
]);

interface OptInRow extends Record<string, string | number | null> {
  repository_id: number;
  installation_id: number;
  owner: string;
  /** Null for a row recorded before the column existed, until the next pass reads it from GitHub. */
  owner_id: number | null;
  repo: string;
  default_branch: string;
  opted_in_at: number;
}

interface HookDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status_code: number;
  event: string;
  repository_id: number | null;
}

interface PullSummary {
  number: number;
  user?: { type?: string } | null;
  updated_at: string;
  draft?: boolean;
  head: { sha: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

// The `author` filter takes the REST login `<slug>[bot]` of an App. The plain `<slug>` matches no review.
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $author: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { reviews(last: 100, author: $author) { nodes { commit { oid } state body } } }
  }
}`;

interface ReviewsResponse {
  repository: { pullRequest: { reviews: { nodes: Array<{ commit: { oid: string } | null; state: string; body: string }> } } | null } | null;
}

/** Marks a Manki review that reached no verdict, which Manki does not count as covering its head. */
const NO_VERDICT_MARKER = '<!-- manki-no-verdict -->';

/** Counts the GitHub calls of one pass. */
class Budget {
  constructor(public left: number) {}

  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

type AllowedRow = OptInRow & { owner_id: number };

function isAllowed(env: Env, row: OptInRow): row is AllowedRow {
  return row.owner_id !== null && allowedAccounts(env).has(row.owner_id);
}

/** Returns the path and query of the `rel="next"` link, if any. */
function nextPage(link: string | null): string | null {
  const match = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * The singleton behind the 5 minute cron. It keeps which repositories opted in to webhook mode and since when,
 * redelivers recent failed deliveries for them, and queues a review for an open PR whose head has no Manki review.
 */
export class Reconciler extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** The pass in progress. The object runs as a single instance, so this guard sees every cron call. */
  private pass: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS opt_ins (
      repository_id INTEGER PRIMARY KEY,
      installation_id INTEGER NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      opted_in_at INTEGER NOT NULL
    )`);
    const columns = this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('opt_ins')`).toArray();
    if (!columns.some((column) => column.name === 'owner_id')) this.sql.exec('ALTER TABLE opt_ins ADD COLUMN owner_id INTEGER');
    // One row per delivery GUID a scan found failed, or `done` once any attempt of it succeeded.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS failed_deliveries (
      guid TEXT PRIMARY KEY,
      delivery_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      repository_id INTEGER,
      first_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS checked_heads (
      repository_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (repository_id, number, head_sha)
    )`);
  }

  /**
   * Records what a coordinator's opt-in check found. The first sighting of the dispatch workflow sets `opted_in_at`,
   * later ones keep it. Opting out forgets the repository, so opting in again starts a new timestamp.
   */
  async recordOptIn(target: Target, optedIn: boolean): Promise<void> {
    if (!optedIn) {
      if (this.sql.exec('DELETE FROM opt_ins WHERE repository_id = ? RETURNING repository_id', target.repositoryId).toArray().length > 0) {
        log('reconciler_opted_out', { repository_id: target.repositoryId, repo: `${target.owner}/${target.repo}` });
      }
      return;
    }
    const now = Date.now();
    const optedInAt = this.sql.exec<{ opted_in_at: number }>(
      `INSERT INTO opt_ins (repository_id, installation_id, owner, owner_id, repo, default_branch, opted_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repository_id) DO UPDATE SET
         installation_id = excluded.installation_id, owner = excluded.owner, owner_id = excluded.owner_id, repo = excluded.repo,
         default_branch = excluded.default_branch
       RETURNING opted_in_at`,
      target.repositoryId, target.installationId, target.owner, target.ownerId, target.repo, target.defaultBranch, now,
    ).one().opted_in_at;
    if (optedInAt === now) log('reconciler_opted_in', { repository_id: target.repositoryId, repo: `${target.owner}/${target.repo}` });
  }

  /**
   * One cron pass. A pass that starts while the previous one still waits on GitHub is skipped, since both would
   * redeliver the same failures and race on the scan state.
   */
  async reconcile(): Promise<void> {
    if (this.pass) {
      log('reconciler_pass_skipped', { reason: 'previous pass still running' });
      return;
    }
    this.pass = this.runPass().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  /** Each half catches its own errors, so a failing redelivery never stops the catch-up. */
  private async runPass(): Promise<void> {
    const budget = new Budget(SUBREQUEST_BUDGET);
    try {
      await this.backfillOwners(budget);
    } catch (error) {
      log('reconciler_backfill_error', { error: String(error) });
    }
    try {
      await this.redeliver(budget);
    } catch (error) {
      log('reconciler_redeliver_error', { error: String(error) });
    }
    try {
      await this.catchUp(budget);
    } catch (error) {
      log('reconciler_catch_up_error', { error: String(error) });
    }
  }

  /**
   * Reads the owner id of each repository recorded before `owner_id` existed and stores it, so the repository is
   * reconciled again without waiting for its next delivery. Each row costs a mint and a read, once.
   */
  private async backfillOwners(budget: Budget): Promise<void> {
    const rows = this.sql.exec<OptInRow>('SELECT * FROM opt_ins WHERE owner_id IS NULL ORDER BY repository_id').toArray();
    for (const row of rows) {
      if (budget.left < 2) return;
      budget.take();
      const mint = await mintRepositoryToken(this.env, row.installation_id, row.repository_id, { metadata: 'read' }, {
        purpose: 'reconciler',
        repository: `${row.owner}/${row.repo}`,
      });
      if (!mint.ok) {
        log('reconciler_token_refused', { repository_id: row.repository_id, status: mint.status });
        if (mint.status === 404 || mint.status === 422) this.sql.exec('DELETE FROM opt_ins WHERE repository_id = ?', row.repository_id);
        continue;
      }
      budget.take();
      const response = await githubApi(mint.token, `/repositories/${row.repository_id}`);
      if (!response.ok) {
        log('reconciler_backfill_error', { repository_id: row.repository_id, status: response.status });
        continue;
      }
      const ownerId = (await response.json() as { owner: { id: number } }).owner.id;
      this.sql.exec('UPDATE opt_ins SET owner_id = ? WHERE repository_id = ?', ownerId, row.repository_id);
      log('reconciler_owner_backfilled', { repository_id: row.repository_id, owner_id: ownerId });
    }
  }

  /** Returns the registry entry of a repository. The cron touches no repository of an account outside `WEBHOOK_ACCOUNTS`. */
  private optIn(repositoryId: number | null): OptInRow | undefined {
    if (repositoryId === null) return undefined;
    const row = this.sql.exec<OptInRow>('SELECT * FROM opt_ins WHERE repository_id = ?', repositoryId).toArray()[0];
    return row && isAllowed(this.env, row) ? row : undefined;
  }

  private getMeta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }

  private setMeta(key: string, value: unknown): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  /**
   * Redelivers failed App deliveries, at most twice each and those not retried yet first. Only a delivery whose first
   * attempt is under `REDELIVERY_WINDOW_MS` old, for a repository that had opted in by then, is sent again.
   * Deliveries from before the Worker was ready stay failed.
   */
  private async redeliver(budget: Budget): Promise<void> {
    const since = Date.now() - REDELIVERY_WINDOW_MS;
    this.sql.exec('DELETE FROM failed_deliveries WHERE first_at < ?', since);
    const jwt = await createAppJWT(this.env);
    try {
      await this.scanDeliveries(jwt, budget, since);
    } catch (error) {
      // Failures recorded by earlier passes are still redelivered, before they age out of the window.
      log('reconciler_scan_error', { error: String(error) });
    }

    const pending = this.sql.exec<{ guid: string; delivery_id: number; event: string; repository_id: number | null; attempts: number }>(
      `SELECT guid, delivery_id, event, repository_id, attempts FROM failed_deliveries
       WHERE done = 0 AND attempts < ? AND first_at >= ? ORDER BY attempts, first_at, delivery_id`,
      MAX_REDELIVERIES, since,
    ).toArray();
    for (const row of pending) {
      if (!budget.take()) return;
      const response = await githubApi(jwt, `/app/hook/deliveries/${row.delivery_id}/attempts`, { method: 'POST' });
      // A rate limit or a GitHub error did not try the delivery, so it keeps its attempts for a later pass.
      const failure = response.ok ? '' : await response.text();
      const transient = response.status >= 500 || response.status === 429 || isRateLimited(response, failure);
      if (!transient) this.sql.exec('UPDATE failed_deliveries SET attempts = attempts + 1 WHERE guid = ?', row.guid);
      log('reconciler_redelivered', { guid: row.guid, event: row.event, repository_id: row.repository_id, status: response.status, attempt: row.attempts + 1 });
    }
  }

  /**
   * Reads the deliveries listed since the last finished scan, newest first, down to the stored marker or the window.
   * A scan the page limit or the budget cuts short goes on from its next page in the following pass, so failures
   * behind a burst of `workflow_run` deliveries are still found.
   */
  private async scanDeliveries(jwt: string, budget: Budget, since: number): Promise<void> {
    const marker = this.getMeta<number>('delivery_marker') ?? 0;
    const resume = this.getMeta<{ path: string; top: number | null }>('delivery_resume');
    let path = resume?.path ?? '/app/hook/deliveries?per_page=100';
    let top = resume?.top ?? null;

    for (let page = 0; page < MAX_DELIVERY_PAGES && budget.take(); page++) {
      const response = await githubApi(jwt, path);
      if (!response.ok) {
        // A saved page GitHub refuses, such as an expired cursor, would fail every pass, so the scan starts over.
        if (resume && response.status >= 400 && response.status < 500) this.sql.exec(`DELETE FROM meta WHERE key = 'delivery_resume'`);
        throw new Error(`listing deliveries failed with ${response.status}`);
      }
      const batch = await response.json() as HookDelivery[];
      top ??= batch[0]?.id ?? null;
      const reachedEnd = batch.some((delivery) => {
        if (delivery.id <= marker || Date.parse(delivery.delivered_at) < since) return true;
        this.record(delivery);
        return false;
      });
      const next = nextPage(response.headers.get('Link'));
      if (reachedEnd || !next) {
        if (top !== null) this.setMeta('delivery_marker', Math.max(marker, top));
        this.sql.exec(`DELETE FROM meta WHERE key = 'delivery_resume'`);
        return;
      }
      path = next;
    }
    this.setMeta('delivery_resume', { path, top });
  }

  /** Notes one listed delivery attempt: a success settles its GUID, a failed first attempt may need redelivering. */
  private record(delivery: HookDelivery): void {
    const at = Date.parse(delivery.delivered_at);
    if (isSuccess(delivery.status_code)) {
      // Only a redelivery can settle a failure. A successful first attempt means its GUID never failed.
      if (!delivery.redelivery) return;
      // A scan sees the newer success before the older failure, so the success is stored even with no row yet.
      this.sql.exec(
        `INSERT INTO failed_deliveries (guid, delivery_id, event, repository_id, first_at, done) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (guid) DO UPDATE SET done = 1`,
        delivery.guid, delivery.id, delivery.event, delivery.repository_id, at,
      );
      return;
    }
    // A failed redelivery is counted in `attempts` already.
    if (delivery.redelivery || !HANDLED_EVENTS.has(delivery.event)) return;
    const optIn = this.optIn(delivery.repository_id);
    if (!optIn || at < optIn.opted_in_at) return;
    this.sql.exec(
      `INSERT INTO failed_deliveries (guid, delivery_id, event, repository_id, first_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guid) DO NOTHING`,
      delivery.guid, delivery.id, delivery.event, delivery.repository_id, at,
    );
  }

  /**
   * Hands each opted-in repository's recently updated open PRs to their coordinators when the head has no Manki
   * review yet. Repositories are visited in turn across passes, so a small budget still reaches all of them.
   */
  private async catchUp(budget: Budget): Promise<void> {
    const cursor = Number(this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'catch_up_cursor'`).toArray()[0]?.value ?? 0);
    const repos = this.sql.exec<OptInRow>('SELECT * FROM opt_ins ORDER BY repository_id').toArray()
      .filter((repo) => isAllowed(this.env, repo));
    this.sql.exec('DELETE FROM checked_heads WHERE checked_at < ?', Date.now() - CATCH_UP_WINDOW_MS);
    const ordered = [...repos.filter((repo) => repo.repository_id > cursor), ...repos.filter((repo) => repo.repository_id <= cursor)];

    for (const repo of ordered) {
      if (budget.left < 2) return;
      try {
        if (!(await this.catchUpRepository(repo, budget))) return;
      } catch (error) {
        // One broken repository must not hold up the others, so the cursor moves past it.
        log('reconciler_catch_up_error', { repository_id: repo.repository_id, repo: `${repo.owner}/${repo.repo}`, error: String(error) });
      }
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('catch_up_cursor', ?)`, String(repo.repository_id));
    }
  }

  /** Remembers a head as settled for a day, so later passes neither ask its coordinator nor GitHub again. */
  private markChecked(repo: OptInRow, pull: PullSummary): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO checked_heads (repository_id, number, head_sha, checked_at) VALUES (?, ?, ?, ?)',
      repo.repository_id, pull.number, pull.head.sha, Date.now(),
    );
  }

  /** Returns false when the budget ran out before every PR of `repo` was checked. */
  private async catchUpRepository(repo: AllowedRow, budget: Budget): Promise<boolean> {
    budget.take();
    const mint = await mintRepositoryToken(this.env, repo.installation_id, repo.repository_id, { pull_requests: 'read' }, {
      purpose: 'reconciler',
      repository: `${repo.owner}/${repo.repo}`,
    });
    if (!mint.ok) {
      log('reconciler_token_refused', { repository_id: repo.repository_id, status: mint.status });
      // A 404 means the installation is gone, and a 422 that the repository left it, so neither can be opted in.
      if (mint.status === 404 || mint.status === 422) this.sql.exec('DELETE FROM opt_ins WHERE repository_id = ?', repo.repository_id);
      return true;
    }
    budget.take();
    const response = await githubApi(mint.token, `/repos/${repo.owner}/${repo.repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`);
    if (!response.ok) throw new Error(`listing pull requests of ${repo.owner}/${repo.repo} failed with ${response.status}`);
    const since = Date.now() - CATCH_UP_WINDOW_MS;
    const pulls = (await response.json() as PullSummary[]).filter((pull) =>
      Date.parse(pull.updated_at) >= since && !pull.draft && pull.head.repo?.full_name === pull.base.repo.full_name);

    for (const pull of pulls) {
      const checked = this.sql.exec(
        'SELECT 1 FROM checked_heads WHERE repository_id = ? AND number = ? AND head_sha = ?',
        repo.repository_id, pull.number, pull.head.sha,
      ).toArray().length > 0;
      if (checked) continue;
      // Manki does not review a bot's PR. A bot's push to a person's PR is known only through its delivery.
      if (pull.user?.type === 'Bot') {
        this.markChecked(repo, pull);
        continue;
      }
      // Coordinator calls count against the budget too, as each one is a request on the Free plan.
      if (!budget.take()) return false;
      const coordinator = this.env.PR_COORDINATOR.getByName(`${repo.repository_id}:${pull.number}`);
      const state = await coordinator.catchUpState(pull.head.sha);
      if (state === 'handled') this.markChecked(repo, pull);
      // A review still queued or running is asked about again, so one that fails is caught up on a later pass.
      if (state !== 'needed') continue;
      if (!budget.take()) return false;
      const data = await githubGraphql<ReviewsResponse>(mint.token, REVIEWS_QUERY, {
        owner: repo.owner, name: repo.repo, number: pull.number, author: BOT_LOGIN,
      });
      // A review counts as Manki's `reviewCoversHead` counts it. Thread replies are reviews too, with an empty body.
      const reviewed = data.repository?.pullRequest?.reviews.nodes.some((review) =>
        review.commit?.oid === pull.head.sha && review.state !== 'DISMISSED'
        && review.body.includes(MANKI_COMMENT_MARKER) && !review.body.includes(NO_VERDICT_MARKER));
      if (reviewed) {
        this.markChecked(repo, pull);
        continue;
      }
      if (!budget.take()) return false;
      const target: Target = {
        installationId: repo.installation_id,
        repositoryId: repo.repository_id,
        owner: repo.owner,
        ownerId: repo.owner_id,
        repo: repo.repo,
        defaultBranch: repo.default_branch,
        number: pull.number,
      };
      const result = await coordinator.catchUp(target, pull.head.sha);
      // Marked only once the coordinator took it, so a failed call is tried again on the next pass.
      this.markChecked(repo, pull);
      log('reconciler_caught_up', { repo: `${repo.owner}/${repo.repo}`, pr: pull.number, head_sha: pull.head.sha, ...result });
    }
    return true;
  }
}
