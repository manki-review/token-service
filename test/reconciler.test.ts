import {
  createExecutionContext,
  createScheduledController,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { RUN_DEADLINE_MS } from '../src/coordinator';
import {
  CATCH_UP_WINDOW_MS,
  MAX_DELIVERY_PAGES,
  MAX_REDELIVERIES,
  RECONCILER_NAME,
  Reconciler,
  REDELIVERY_WINDOW_MS,
  SUBREQUEST_BUDGET,
} from '../src/reconciler';
import { routeDelivery, type Target } from '../src/routing';
import { coordinator, freezeClock, INSTALLATION_ID, logged, OWNER, OWNER_ID, postWebhook, RUNTIME_ENV, setDispatchEnabled, tableNames, TEST_ENV, workRows } from './helpers';
import { DISPATCH_WORKFLOW_YAML, EVENT_WORKFLOW_YAML, pullRequestEvent, workflowsReply } from './payloads';

const MINUTE = 60_000;
const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
// The fake mints for this installation fail with 422, as when the repository was removed from it.
const LEFT_INSTALLATION = 422422;

// Storage outlives a single test, so each test uses its own reconciler and repository ids.
let nextId = 50_000;

function setup() {
  const name = `reconciler-${nextId}`;
  const stub = RUNTIME_ENV.RECONCILER.getByName(name);
  const repo = (suffix = '', ownerId = OWNER_ID) => {
    const id = nextId++;
    const target: Target = { installationId: INSTALLATION_ID, repositoryId: id, owner: OWNER, ownerId, repo: `repo-${id}${suffix}`, defaultBranch: 'main', number: 0 };
    return target;
  };
  return { stub, repo };
}

interface Delivery {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status_code: number;
  event: string;
  repository_id: number | null;
}

interface Pull {
  number: number;
  user?: { type: string };
  updated_at: string;
  draft?: boolean;
  head: { sha: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

/** A fake of the App deliveries API and the PR reads the catch-up makes. */
function fakeGitHub() {
  const state = {
    /** Pages of deliveries, newest first. */
    pages: [[]] as Delivery[][],
    redelivered: [] as number[],
    pulls: new Map<string, Pull[]>(),
    /** Reviews as GraphQL returns them, keyed `<repo>#<number>`. */
    reviews: new Map<string, Array<{ author: string; oid: string }>>(),
    pullsStatus: new Map<string, number>(),
    graphqlCalls: 0,
    calls: 0,
    deliveryListCalls: 0,
    dispatches: 0,
    cancels: [] as number[],
    /** The repositories whose open PRs were listed, in order. */
    pullListCalls: [] as string[],
    /** Statuses the next redelivery requests answer with, in order. Afterwards 202. */
    redeliverStatuses: [] as Array<number | { status: number; headers: Record<string, string> }>,
    /** Statuses for listed delivery pages, by page index. */
    deliveryPageStatus: new Map<number, number>(),
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    state.calls++;
    const request = new Request(input, init);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /app/hook/deliveries') {
      state.deliveryListCalls++;
      const page = Number(url.searchParams.get('page') ?? 0);
      const status = state.deliveryPageStatus.get(page);
      if (status) return Response.json({ message: 'no' }, { status });
      const headers = page + 1 < state.pages.length
        ? { Link: `<https://api.github.com/app/hook/deliveries?per_page=100&page=${page + 1}>; rel="next"` }
        : undefined;
      return Response.json(state.pages[page], { headers });
    }
    const attempt = url.pathname.match(/^\/app\/hook\/deliveries\/(\d+)\/attempts$/);
    if (attempt && request.method === 'POST') {
      state.redelivered.push(Number(attempt[1]));
      const next = state.redeliverStatuses.shift() ?? 202;
      const { status, headers } = typeof next === 'number' ? { status: next, headers: {} } : next;
      return Response.json({}, { status, headers });
    }
    const mint = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && request.method === 'POST') {
      if (Number(mint[1]) === LEFT_INSTALLATION) return Response.json({ message: 'There is at least one repository that does not exist or is not accessible' }, { status: 422 });
      if (Number(mint[1]) !== INSTALLATION_ID) return Response.json({ message: 'Not Found' }, { status: 404 });
      const { permissions } = await request.json() as { permissions: Record<string, string> };
      return Response.json({ token: 'ghs_repo', expires_at: '2030-01-01T01:00:00Z', permissions }, { status: 201 });
    }
    const single = url.pathname.match(/^\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/);
    if (single && request.method === 'GET') {
      const found = (state.pulls.get(single[1]) ?? []).find((candidate) => candidate.number === Number(single[2]));
      return Response.json({ state: 'open', draft: false, head: { sha: found?.head.sha } });
    }
    if (url.pathname.endsWith('/actions/workflows/manki-dispatch.yml/dispatches') && request.method === 'POST') {
      state.dispatches++;
      return Response.json({ workflow_run_id: 7000 + state.dispatches });
    }
    const cancel = url.pathname.match(/\/actions\/runs\/(\d+)\/cancel$/);
    if (cancel && request.method === 'POST') {
      state.cancels.push(Number(cancel[1]));
      return new Response(null, { status: 202 });
    }
    // Run reads fail, so only the deadline can end a dispatched item.
    if (/\/actions\/runs\/\d+$/.test(url.pathname)) return Response.json({ message: 'no' }, { status: 500 });
    const pulls = url.pathname.match(/^\/repos\/[^/]+\/([^/]+)\/pulls$/);
    if (pulls && request.method === 'GET') {
      state.pullListCalls.push(pulls[1]);
      const status = state.pullsStatus.get(pulls[1]);
      if (status) return Response.json({ message: 'no' }, { status });
      return Response.json(state.pulls.get(pulls[1]) ?? []);
    }
    const repository = url.pathname.match(/^\/repositories\/(\d+)$/);
    if (repository && request.method === 'GET') {
      const id = Number(repository[1]);
      return Response.json({ id, name: id === 4242 ? 'manki' : `repo-${id}`, owner: { login: OWNER, id: OWNER_ID }, default_branch: 'main' });
    }
    if (route === 'POST /graphql') {
      const { query, variables } = await request.json() as { query: string; variables: { name: string; number: number } };
      if (query.includes('reviews')) {
        state.graphqlCalls++;
        const reviews = state.reviews.get(`${variables.name}#${variables.number}`) ?? [];
        const nodes = reviews.map((review) => ({ author: { login: review.author }, commit: { oid: review.oid } }));
        return Response.json({ data: { repository: { pullRequest: { reviews: { nodes } } } } });
      }
      return Response.json(workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }).body);
    }
    throw new Error(`Unexpected fetch: ${route}`);
  });
  return state;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

let advanceClock: (ms: number) => number;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  advanceClock = freezeClock();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setDispatchEnabled(false);
});

const realCoordinators = RUNTIME_ENV.PR_COORDINATOR;

function key(id: string) {
  return { id, bodyHash: null };
}

afterEach(() => {
  vi.useRealTimers();
  RUNTIME_ENV.PR_COORDINATOR = realCoordinators;
  setDispatchEnabled(false);
});

/**
 * Counts the reconciler's calls to coordinators, by method, through the runtime env both share. `failCatchUp` makes
 * that many `catchUp` calls throw first. Restore `realCoordinators` before `workRows`, which needs the real binding.
 */
function watchCoordinators(options: { failCatchUp?: number } = {}) {
  const calls: string[] = [];
  let failures = options.failCatchUp ?? 0;
  RUNTIME_ENV.PR_COORDINATOR = {
    getByName(name: string) {
      const stub = realCoordinators.getByName(name);
      return {
        catchUpState: (head: string) => {
          calls.push('catchUpState');
          return stub.catchUpState(head);
        },
        catchUp: (target: Target, head: string) => {
          calls.push('catchUp');
          if (failures-- > 0) throw new Error('coordinator unavailable');
          return stub.catchUp(target, head);
        },
      };
    },
  } as unknown as typeof realCoordinators;
  return calls;
}

describe('Reconciler redelivery', () => {
  // GitHub lists deliveries newest first, and their ids grow with time.
  const failure = (target: Target, id: number, minutes: number, extra: Partial<Delivery> = {}): Delivery => ({
    id, guid: `g-${id}`, delivered_at: minutesAgo(minutes), redelivery: false, status_code: 500, event: 'pull_request', repository_id: target.repositoryId, ...extra,
  });

  it('redelivers failed deliveries for repositories that had opted in by then, oldest first', async () => {
    const { stub, repo } = setup();
    const optedIn = repo();
    const notOptedIn = repo();
    await stub.recordOptIn(optedIn, true);
    advanceClock(30 * MINUTE);
    const github = fakeGitHub();
    const failed = (id: number, guid: string, minutes: number, extra: Partial<Delivery> = {}) => failure(optedIn, id, minutes, { guid, ...extra });
    github.pages = [[
      failed(99, 'recent', 1),
      failed(98, 'issue-comment', 2, { event: 'issue_comment', status_code: 0 }),
      failed(97, 'fixed-later', 3, { redelivery: true, status_code: 202 }),
      failed(96, 'fixed-later', 4),
      failed(95, 'succeeded', 5, { status_code: 202 }),
      failed(94, 'other-repo', 6, { repository_id: notOptedIn.repositoryId }),
      failed(93, 'no-repo', 7, { event: 'installation', repository_id: null }),
      failed(92, 'push', 8, { event: 'push' }),
      failed(91, 'retried-before', 10, { redelivery: true }),
      failed(90, 'thread', 11, { event: 'pull_request_review_thread' }),
      failed(89, 'before-opt-in', 31),
    ]];
    await stub.reconcile();
    expect(github.redelivered).toEqual([90, 98, 99]);
    expect(logged(log, 'reconciler_redelivered')).toMatchObject([
      { guid: 'thread', event: 'pull_request_review_thread', attempt: 1, status: 202 },
      { guid: 'issue-comment', event: 'issue_comment', attempt: 1 },
      { guid: 'recent', event: 'pull_request', attempt: 1 },
    ]);
  });

  it('leaves failed deliveries older than 6 hours alone, even for a repository opted in long before', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    advanceClock(5 * REDELIVERY_WINDOW_MS);
    const github = fakeGitHub();
    github.pages = [[failure(target, 3, 6 * 60 - 1), failure(target, 2, 6 * 60 + 1), failure(target, 1, 10 * 60)]];
    await stub.reconcile();
    expect(github.redelivered).toEqual([3]);
  });

  it('skips deliveries from before the repository opted in', async () => {
    const { stub, repo } = setup();
    const target = repo();
    const github = fakeGitHub();
    const beforeOptIn = failure(target, 1, 0, { event: 'issue_comment' });
    advanceClock(MINUTE);
    await stub.recordOptIn(target, true);
    github.pages = [[failure(target, 2, 0, { event: 'issue_comment' }), beforeOptIn]];
    await stub.reconcile();
    expect(github.redelivered).toEqual([2]);
  });

  it(`redelivers a delivery at most ${MAX_REDELIVERIES} times`, async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    const first = failure(target, 1, 0, { guid: 'flaky' });
    github.pages = [[first]];
    for (let pass = 0; pass < 4; pass++) {
      await stub.reconcile();
      advanceClock(5 * MINUTE);
      github.pages = [[failure(target, 100 + pass, 0, { guid: 'flaky', redelivery: true }), ...github.pages[0]]];
    }
    expect(github.redelivered).toEqual([1, 1]);
  });

  it('keeps the attempts of a redelivery GitHub could not take, and spends one on a refusal', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [[failure(target, 1, 0)]];
    github.redeliverStatuses = [502, 429, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }, 422, 202, 202];
    for (let pass = 0; pass < 6; pass++) {
      await stub.reconcile();
      advanceClock(5 * MINUTE);
    }
    // Three transient refusals cost nothing, then the 422 and the 202 use up the two attempts.
    expect(github.redelivered).toEqual([1, 1, 1, 1, 1]);
    expect(logged(log, 'reconciler_redelivered').map((line) => line.status)).toEqual([502, 429, 403, 422, 202]);
  });

  it('stops redelivering once a later scan sees an attempt succeed', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [[failure(target, 1, 0, { guid: 'flaky' })]];
    await stub.reconcile();
    advanceClock(5 * MINUTE);
    github.pages = [[failure(target, 2, 0, { guid: 'flaky', redelivery: true, status_code: 202 }), ...github.pages[0]]];
    await stub.reconcile();
    expect(github.redelivered).toEqual([1]);
  });

  it('pages back only until the deliveries are older than the window', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    advanceClock(2 * REDELIVERY_WINDOW_MS);
    const github = fakeGitHub();
    github.pages = [[failure(target, 4, 10)], [failure(target, 3, 350)], [failure(target, 2, 370)], [failure(target, 1, 380)]];
    await stub.reconcile();
    expect(github.deliveryListCalls).toBe(3);
    expect(github.redelivered).toEqual([3, 4]);
  });

  it('stops paging at the first page that reaches past the window', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    advanceClock(3 * REDELIVERY_WINDOW_MS);
    const github = fakeGitHub();
    github.pages = [[failure(target, 4, 30), failure(target, 3, 361)], [failure(target, 2, 362)], [failure(target, 1, 363)]];
    await stub.reconcile();
    expect(github.deliveryListCalls).toBe(1);
    expect(github.redelivered).toEqual([4]);
  });

  it('resumes a scan the page limit cut short, then reads only down to the marker', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    const pages = MAX_DELIVERY_PAGES + 2;
    github.pages = Array.from({ length: pages }, (_, page) => [failure(target, 1000 - page, 0)]);
    const listCalls: number[] = [];
    let seen = 0;
    const pass = async () => {
      await stub.reconcile();
      listCalls.push(github.deliveryListCalls - seen);
      seen = github.deliveryListCalls;
    };
    await pass();
    await pass();
    github.pages[0] = [failure(target, 2000, 0), ...github.pages[0]];
    await pass();
    expect(listCalls).toEqual([MAX_DELIVERY_PAGES, 2, 1]);
    // Every failure was found, the deepest ones only by the resumed scan.
    expect(new Set(github.redelivered)).toEqual(new Set([2000, ...Array.from({ length: pages }, (_, page) => 1000 - page)]));
  });

  it('still redelivers recorded failures while the listing fails', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [[failure(target, 1, 0)]];
    await stub.reconcile();
    github.deliveryPageStatus.set(0, 502);
    advanceClock(5 * MINUTE);
    await stub.reconcile();
    expect(logged(log, 'reconciler_scan_error')).toMatchObject([{ error: 'Error: listing deliveries failed with 502' }]);
    expect(github.redelivered).toEqual([1, 1]);
  });

  it('starts the scan over when GitHub refuses the saved page', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = Array.from({ length: MAX_DELIVERY_PAGES + 2 }, (_, page) => [failure(target, 1000 - page, 0)]);
    await stub.reconcile();
    github.deliveryPageStatus.set(MAX_DELIVERY_PAGES, 422);
    await stub.reconcile();
    const before = github.deliveryListCalls;
    github.deliveryPageStatus.clear();
    await stub.reconcile();
    // The third pass reads from the newest page again instead of the refused one.
    expect(github.deliveryListCalls - before).toBe(MAX_DELIVERY_PAGES);
  });

  it('stores nothing for a successful first attempt', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [Array.from({ length: 5 }, (_, i) => failure(target, 5 - i, 0, { status_code: 202 }))];
    await stub.reconcile();
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM failed_deliveries').one().count);
    expect(rows).toBe(0);
  });

  it('adds owner_id to a registry from before it and reads it from GitHub for an old row in the next pass', async () => {
    const { stub, repo } = setup();
    const target = repo();
    const github = fakeGitHub();
    github.pages = [[failure(target, 1, 0)]];
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    const optedInAt = Date.now() - MINUTE;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('DROP TABLE opt_ins');
      state.storage.sql.exec(`CREATE TABLE opt_ins (
        repository_id INTEGER PRIMARY KEY, installation_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
        default_branch TEXT NOT NULL, opted_in_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        'INSERT INTO opt_ins VALUES (?, ?, ?, ?, ?, ?)', target.repositoryId, target.installationId, OWNER, target.repo, 'main', optedInAt,
      );
      // A new instance on the old schema, as after a deploy.
      const upgraded = new Reconciler(state, RUNTIME_ENV);
      await upgraded.reconcile();
      expect(state.storage.sql.exec('SELECT owner_id, opted_in_at FROM opt_ins').toArray()).toEqual([{ owner_id: OWNER_ID, opted_in_at: optedInAt }]);
      expect(logged(log, 'reconciler_owner_backfilled')).toEqual([expect.objectContaining({ repository_id: target.repositoryId, owner_id: OWNER_ID })]);
      expect(github.redelivered).toEqual([1]);
      expect(github.pullListCalls).toEqual([target.repo]);

      // The owner is read once.
      await upgraded.reconcile();
      expect(logged(log, 'reconciler_owner_backfilled')).toHaveLength(1);
    });
  });

  it('touches no repository of an account outside WEBHOOK_ACCOUNTS, even one in the registry', async () => {
    const { stub, repo } = setup();
    const allowed = repo();
    const dropped = repo('', OWNER_ID + 1);
    for (const target of [allowed, dropped]) await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [[failure(dropped, 2, 0), failure(allowed, 1, 0)]];
    github.pulls.set(allowed.repo, [pull(1, SHA_1, { repo: allowed.repo })]);
    github.pulls.set(dropped.repo, [pull(1, SHA_1, { repo: dropped.repo })]);
    await stub.reconcile();
    expect(github.redelivered).toEqual([1]);
    expect(logged(log, 'reconciler_caught_up').map((line) => line.repo)).toEqual([`${OWNER}/${allowed.repo}`]);
    expect(github.pullListCalls).toEqual([allowed.repo]);
  });

  it('skips a pass that starts while the previous one still waits on GitHub', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [[failure(target, 1, 0)]];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listing = false;
    const fake = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (new URL(new Request(input, init).url).pathname === '/app/hook/deliveries') {
        listing = true;
        await held;
      }
      return fake(input, init);
    });
    const first = stub.reconcile();
    await vi.waitFor(() => expect(listing).toBe(true));
    await stub.reconcile();
    expect(logged(log, 'reconciler_pass_skipped')).toHaveLength(1);
    release();
    await first;
    expect(github.redelivered).toEqual([1]);

    // Once the pass ended, the next one runs.
    await stub.reconcile();
    expect(github.deliveryListCalls).toBe(2);
  });

  it('stops redelivering when the pass runs out of budget, and reaches the rest first on the next pass', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pages = [Array.from({ length: 60 }, (_, i) => failure(target, 60 - i, 0))];
    await stub.reconcile();
    expect(github.redelivered).toEqual(Array.from({ length: SUBREQUEST_BUDGET - 1 }, (_, i) => i + 1));
    expect(github.calls).toBe(SUBREQUEST_BUDGET);
    await stub.reconcile();
    const second = github.redelivered.slice(SUBREQUEST_BUDGET - 1);
    expect(second.slice(0, 60 - (SUBREQUEST_BUDGET - 1))).toEqual(Array.from({ length: 60 - (SUBREQUEST_BUDGET - 1) }, (_, i) => SUBREQUEST_BUDGET + i));
    expect(second).toHaveLength(SUBREQUEST_BUDGET - 1);
  });

  it('keeps the first opt-in time and starts a new one after an opt-out', async () => {
    const { stub, repo } = setup();
    const target = repo();
    const optedInAt = () => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ at: number }>('SELECT opted_in_at AS at FROM opt_ins WHERE repository_id = ?', target.repositoryId).toArray()[0]?.at ?? null);
    const start = Date.now();
    await stub.recordOptIn(target, true);
    advanceClock(MINUTE);
    await stub.recordOptIn(target, true);
    expect(await optedInAt()).toBe(start);
    await stub.recordOptIn(target, false);
    expect(await optedInAt()).toBeNull();
    await stub.recordOptIn(target, true);
    expect(await optedInAt()).toBe(start + MINUTE);
  });
});

describe('opt-in timestamp', () => {
  it('is recorded by the coordinator when its opt-in check first sees the dispatch workflow', async () => {
    fakeGitHub();
    const pr = coordinator(4242, 900);
    const route = routeDelivery('pull_request', pullRequestEvent('synchronize', { number: 900 }));
    if (route.type !== 'work') throw new Error('expected work');
    const start = Date.now();
    await pr.receive(key(crypto.randomUUID()), route);
    await runDurableObjectAlarm(pr);
    const registry = RUNTIME_ENV.RECONCILER.getByName(RECONCILER_NAME);
    const rows = () => runInDurableObject(registry, (_instance, state) =>
      state.storage.sql.exec('SELECT repository_id, opted_in_at FROM opt_ins').toArray());
    expect(await rows()).toEqual([{ repository_id: 4242, opted_in_at: start }]);

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === '/graphql') return Response.json(workflowsReply({ 'manki.yml': EVENT_WORKFLOW_YAML }).body);
      if (path === '/repositories/4242') return Response.json({ name: 'manki', owner: { login: OWNER, id: OWNER_ID }, default_branch: 'main' });
      return Response.json({ token: 'ghs_repo', expires_at: '2030-01-01T01:00:00Z' }, { status: 201 });
    });
    advanceClock(10 * MINUTE);
    await pr.receive(key(crypto.randomUUID()), route);
    await runDurableObjectAlarm(pr);
    expect(await rows()).toEqual([]);
  });
});

function pull(number: number, sha: string, options: { draft?: boolean; fork?: boolean; updatedMinutesAgo?: number; repo: string }): Pull {
  return {
    number,
    updated_at: minutesAgo(options.updatedMinutesAgo ?? 5),
    draft: options.draft ?? false,
    head: { sha, repo: { full_name: options.fork ? 'mallory/fork' : `${OWNER}/${options.repo}` } },
    base: { repo: { full_name: `${OWNER}/${options.repo}` } },
  };
}

describe('Reconciler catch-up', () => {
  it('queues a review for an open PR whose head has no Manki review', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    advanceClock(MINUTE);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [
      pull(1, SHA_1, { repo: target.repo }),
      pull(2, SHA_1, { repo: target.repo, draft: true }),
      pull(3, SHA_1, { repo: target.repo, fork: true }),
      pull(4, SHA_1, { repo: target.repo, updatedMinutesAgo: 25 * 60 }),
      pull(5, SHA_2, { repo: target.repo }),
    ]);
    github.reviews.set(`${target.repo}#5`, [{ author: 'manki-review', oid: SHA_2 }]);
    await stub.reconcile();

    expect(logged(log, 'reconciler_caught_up')).toMatchObject([{ pr: 1, head_sha: SHA_1, accepted: true }]);
    expect(logged(log, 'token_minted')).toContainEqual({
      msg: 'token_minted',
      purpose: 'reconciler',
      repository: `${OWNER}/${target.repo}`,
      repository_id: target.repositoryId,
      installation_id: INSTALLATION_ID,
      permissions: { pull_requests: 'read' },
    });
    const pr = coordinator(target.repositoryId, 1);
    expect(await workRows(pr)).toMatchObject([
      { lane: 'state', kind: 'review', event: 'pull_request.synchronize', head_sha: SHA_1, delivery: `catch-up-${SHA_1.slice(0, 12)}`, status: 'queued' },
    ]);
    expect(`catch-up-${SHA_1.slice(0, 12)}`).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(await runInDurableObject(pr, (_instance, state) => state.storage.getAlarm())).toBe(Date.now());
    for (const number of [2, 3, 4, 5]) expect(await workRows(coordinator(target.repositoryId, number))).toEqual([]);
  });

  it('leaves a head alone that the coordinator already received or checked', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    const pushed = coordinator(target.repositoryId, 1);
    const route = routeDelivery('pull_request', {
      ...pullRequestEvent('synchronize', { number: 1, head: { sha: SHA_1, repo: { full_name: `${OWNER}/${target.repo}` } } }),
      repository: { id: target.repositoryId, name: target.repo, full_name: `${OWNER}/${target.repo}`, default_branch: 'main', owner: { login: OWNER, id: OWNER_ID } },
    });
    if (route.type !== 'work') throw new Error('expected work');
    await pushed.receive(key(crypto.randomUUID()), route);
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo }), pull(2, SHA_2, { repo: target.repo })]);
    github.reviews.set(`${target.repo}#2`, [{ author: 'manki-review', oid: SHA_2 }]);

    await stub.reconcile();
    const callsAfterFirstPass = github.calls;
    expect(await workRows(pushed)).toHaveLength(1);
    await stub.reconcile();
    // The second pass lists deliveries, mints and lists pulls again, but checks no review twice.
    expect(github.calls - callsAfterFirstPass).toBe(3);
    expect(logged(log, 'reconciler_caught_up')).toEqual([]);
  });

  it('does not review open PRs again on the first pass after an opt-in', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo }), pull(2, SHA_2, { repo: target.repo })]);
    github.reviews.set(`${target.repo}#1`, [{ author: 'manki-review', oid: SHA_1 }]);
    github.reviews.set(`${target.repo}#2`, [{ author: 'alice', oid: SHA_1 }, { author: 'manki-review', oid: SHA_2 }]);
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toEqual([]);
    // No coordinator state is created for a PR that needed nothing.
    expect(await tableNames(coordinator(target.repositoryId, 1))).toEqual([]);
    expect(await tableNames(coordinator(target.repositoryId, 2))).toEqual([]);
  });

  it.each([
    ['another author', [{ author: 'alice', oid: SHA_1 }]],
    ['an older commit', [{ author: 'manki-review', oid: SHA_2 }]],
    ['another bot', [{ author: 'acme-review', oid: SHA_1 }]],
  ])('catches up a head whose only review is by %s', async (_case, reviews) => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    github.reviews.set(`${target.repo}#1`, reviews);
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toMatchObject([{ pr: 1, head_sha: SHA_1, accepted: true }]);
  });

  it('skips a head a bot pushed, which Manki does not review', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    const payload = {
      ...pullRequestEvent('synchronize', { number: 1, head: { sha: SHA_1, repo: { full_name: `${OWNER}/${target.repo}` } } }, { login: 'dependabot[bot]', type: 'Bot' }),
      repository: { id: target.repositoryId, name: target.repo, full_name: `${OWNER}/${target.repo}`, default_branch: 'main', owner: { login: OWNER, id: OWNER_ID } },
    };
    expect((await postWebhook({ event: 'pull_request', payload })).status).toBe(202);
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    await stub.reconcile();
    expect(github.graphqlCalls).toBe(0);
    expect(await workRows(coordinator(target.repositoryId, 1))).toEqual([]);
  });

  it('waits while a caught-up review is pending and catches the head up again a day after it did not finish', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toHaveLength(1);
    const pr = coordinator(target.repositoryId, 1);
    expect(await pr.catchUpState(SHA_1)).toBe('pending');

    // Dispatch is off here, so the review ends skipped, which does not count as handled.
    await runDurableObjectAlarm(pr);
    expect(await pr.catchUpState(SHA_1)).toBe('needed');
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toHaveLength(1);

    advanceClock(CATCH_UP_WINDOW_MS + MINUTE);
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toHaveLength(2);
  });

  it('with dispatch on, ends a caught-up review whose run never finishes and catches the head up a day later', async () => {
    setDispatchEnabled(true);
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    await stub.reconcile();
    const pr = coordinator(target.repositoryId, 1);
    await runDurableObjectAlarm(pr);
    expect(github.dispatches).toBe(1);
    expect(await workRows(pr)).toMatchObject([{ status: 'running', run_id: 7001 }]);
    expect(await pr.catchUpState(SHA_1)).toBe('pending');

    advanceClock(RUN_DEADLINE_MS + MINUTE);
    await runDurableObjectAlarm(pr);
    expect(github.cancels).toEqual([7001]);
    expect(await workRows(pr)).toMatchObject([{ status: 'timed_out', note: 'no end of the run seen in time, cancel requested' }]);
    expect(await pr.catchUpState(SHA_1)).toBe('needed');
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toHaveLength(1);

    advanceClock(CATCH_UP_WINDOW_MS);
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toHaveLength(2);
  });

  it('skips a PR a bot opened without asking its coordinator', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [{ ...pull(1, SHA_1, { repo: target.repo }), user: { type: 'Bot' } }]);
    const calls = watchCoordinators();
    await stub.reconcile();
    expect(calls).toEqual([]);
    expect(github.graphqlCalls).toBe(0);
  });

  it('moves past a repository that fails and drops one that left its installation', async () => {
    const { stub, repo } = setup();
    const gone = { ...repo('-gone'), installationId: 404404 };
    const left = { ...repo('-left'), installationId: LEFT_INSTALLATION };
    const broken = repo('-broken');
    const healthy = repo('-healthy');
    for (const target of [gone, left, broken, healthy]) await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pullsStatus.set(broken.repo, 500);
    github.pulls.set(healthy.repo, [pull(1, SHA_1, { repo: healthy.repo })]);
    await stub.reconcile();
    expect(logged(log, 'reconciler_catch_up_error')).toMatchObject([{ repository_id: broken.repositoryId }]);
    expect(logged(log, 'reconciler_caught_up')).toMatchObject([{ pr: 1 }]);
    const registered = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ id: number }>('SELECT repository_id AS id FROM opt_ins ORDER BY repository_id').toArray().map((row) => row.id));
    expect(registered).toEqual([broken.repositoryId, healthy.repositoryId]);
    const cursor = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'catch_up_cursor'`).one().value);
    expect(Number(cursor)).toBe(healthy.repositoryId);
  });

  it('asks a coordinator about a handled head once a day, and about a pending one on every pass', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    await coordinator(target.repositoryId, 1).markSeen(key(crypto.randomUUID()), { ...target, number: 1 }, SHA_1);
    const pushed = routeDelivery('pull_request', {
      ...pullRequestEvent('synchronize', { number: 2, head: { sha: SHA_2, repo: { full_name: `${OWNER}/${target.repo}` } } }),
      repository: { id: target.repositoryId, name: target.repo, full_name: `${OWNER}/${target.repo}`, default_branch: 'main', owner: { login: OWNER, id: OWNER_ID } },
    });
    if (pushed.type !== 'work') throw new Error('expected work');
    await coordinator(target.repositoryId, 2).receive(key(crypto.randomUUID()), pushed);
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo }), pull(2, SHA_2, { repo: target.repo })]);
    const calls = watchCoordinators();
    await stub.reconcile();
    await stub.reconcile();
    expect(calls).toEqual(['catchUpState', 'catchUpState', 'catchUpState']);
    expect(github.graphqlCalls).toBe(0);
  });

  it('tries a catch-up again on the next pass when the coordinator call failed', async () => {
    const { stub, repo } = setup();
    const target = repo();
    await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    github.pulls.set(target.repo, [pull(1, SHA_1, { repo: target.repo })]);
    watchCoordinators({ failCatchUp: 1 });
    await stub.reconcile();
    expect(logged(log, 'reconciler_catch_up_error')).toMatchObject([{ repository_id: target.repositoryId, error: 'Error: coordinator unavailable' }]);
    await stub.reconcile();
    expect(logged(log, 'reconciler_caught_up')).toMatchObject([{ pr: 1, accepted: true }]);
    RUNTIME_ENV.PR_COORDINATOR = realCoordinators;
    expect(await workRows(coordinator(target.repositoryId, 1))).toHaveLength(1);
  });

  it('spends at most its budget per pass and reaches every repository over later passes', async () => {
    const { stub, repo } = setup();
    const first = repo('-first');
    const second = repo('-second');
    const quiet = repo('-quiet');
    for (const target of [first, second, quiet]) await stub.recordOptIn(target, true);
    const github = fakeGitHub();
    for (const target of [first, second]) {
      github.pulls.set(target.repo, Array.from({ length: 30 }, (_, i) => pull(i + 1, SHA_1, { repo: target.repo })));
    }
    github.pulls.set(quiet.repo, [pull(1, SHA_2, { repo: quiet.repo })]);

    const coordinatorCalls = watchCoordinators();
    const spentPerPass: number[] = [];
    let spent = 0;
    // Each new PR costs three calls: the coordinator check, the review query and the catch-up.
    for (let pass = 0; pass < 8; pass++) {
      await stub.reconcile();
      const total = github.calls + coordinatorCalls.length;
      spentPerPass.push(total - spent);
      spent = total;
    }
    // GitHub calls and coordinator calls together stay within the budget, and the first pass uses all of it.
    expect(spentPerPass[0]).toBe(SUBREQUEST_BUDGET);
    for (const pass of spentPerPass) expect(pass).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    RUNTIME_ENV.PR_COORDINATOR = realCoordinators;
    expect(await workRows(coordinator(quiet.repositoryId, 1))).toHaveLength(1);
    expect(await workRows(coordinator(first.repositoryId, 30))).toHaveLength(1);
    expect(await workRows(coordinator(second.repositoryId, 30))).toHaveLength(1);
  });
});

describe('cron trigger', () => {
  it('runs one reconcile pass on the singleton', async () => {
    const github = fakeGitHub();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '*/5 * * * *' }), TEST_ENV, ctx);
    await waitOnExecutionContext(ctx);
    expect(github.calls).toBeGreaterThanOrEqual(1);
  });
});
