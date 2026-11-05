import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_RETENTION_MS,
  MIGRATIONS,
  DISPATCH_BACKOFF_MS,
  DISPATCHES_PER_HOUR,
  FINISHED_RETENTION_MS,
  OPT_IN_TTL_MS,
  POLL_MS,
  QUEUED_MAX_AGE_MS,
  QUEUED_RUN_TIMEOUT_MS,
  RUN_DEADLINE_MS,
  RUN_LOOKUP_TIMEOUT_MS,
  RUNNING_RUN_TIMEOUT_MS,
  type Delivery,
  UNTRUSTED_DISPATCHES_PER_HOUR,
} from '../src/coordinator';
import { routeDelivery, type WebhookPayload } from '../src/routing';
import {
  apiRequests,
  coordinator,
  freezeClock,
  type GitHubStub,
  INSTALLATION_ID,
  OWNER,
  postWebhook,
  REPO,
  setDispatchEnabled,
  stubGitHub,
  tableNames,
  workRows,
} from './helpers';
import {
  DISPATCH_WORKFLOW_YAML,
  EVENT_WORKFLOW_YAML,
  issueCommentEvent,
  pullRequestEvent,
  REPOSITORY_ID,
  reviewCommentEvent,
  reviewEvent,
  reviewThreadEvent,
  workflowRunEvent,
  workflowsReply,
} from './payloads';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const SHA_3 = '3'.repeat(40);
const MINUTE = 60_000;

const OPTED_IN: GitHubStub = { api: { 'POST /graphql': workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }) } };

/** A delivery key with a body hash of its own, since the tests send the same payload as different deliveries. */
function key(id: string, bodyHash: string = crypto.randomUUID()): Delivery {
  return { id, bodyHash };
}

// Storage outlives a single test, so each test works on its own PR number.
let nextNumber = 100;

function pullRequest() {
  const number = nextNumber++;
  const stub = coordinator(REPOSITORY_ID, number);
  return {
    number,
    stub,
    push: (sha: string, action = 'synchronize') => pullRequestEvent(action, { number, head: { sha, repo: { full_name: 'manki-review/manki' } } }),
    comment: (body: string, action = 'created') => issueCommentEvent(body, { number, action }),
    outsiderComment: (body: string, action = 'created') => issueCommentEvent(body, { number, action, association: 'NONE' }),
    review: () => reviewEvent('submitted', {}, { number }),
    outsiderReview: (id = 3003) => reviewEvent('submitted', { id, author_association: 'NONE' }, { number }),
    resolve: (action = 'resolved') => reviewThreadEvent(action, { number }),
    reply: (body: string) => reviewCommentEvent(body, { in_reply_to_id: 1 }, 'created', { number }),
    close: (merged: boolean) => pullRequestEvent('closed', { number, merged }),
    async send(event: string, payload: WebhookPayload, delivery: string = crypto.randomUUID()) {
      const route = routeDelivery(event, payload);
      if (route.type !== 'work' && route.type !== 'close') throw new Error(`Route ${route.type} is not for the coordinator`);
      return stub.receive(key(delivery), route);
    },
  };
}

function logged(spy: { mock: { calls: unknown[][] } }, msg: string): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0]))).filter((line) => line.msg === msg);
}

let advanceClock: (ms: number) => number;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  advanceClock = freezeClock();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  setDispatchEnabled(false);
});

describe('PrCoordinator.receive', () => {
  it('refuses a delivery it has seen until the retention runs out', async () => {
    const pr = pullRequest();
    expect(await pr.send('pull_request', pr.push(SHA_1), 'd-1')).toEqual({ accepted: true, effect: 'queued work 1' });
    expect(await pr.send('pull_request', pr.push(SHA_1), 'd-1')).toEqual({ accepted: false, reason: 'duplicate delivery' });
    advanceClock(DELIVERY_RETENTION_MS + 1);
    expect(await pr.send('pull_request', pr.push(SHA_1), 'd-1')).toMatchObject({ accepted: true });
  });

  it('sets an alarm for now once the work is stored', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.now());
  });

  it('coalesces pushes into one review of the newest head', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1, 'opened'));
    expect(await pr.send('pull_request', pr.push(SHA_2), 'd-2')).toEqual({ accepted: true, effect: 'merged into work 1' });
    await pr.send('pull_request', pr.push(SHA_3), 'd-3');
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, kind: 'review', event: 'pull_request.synchronize', head_sha: SHA_3, delivery: 'd-3', status: 'queued' },
    ]);
  });

  it('turns a queued push review into a comment-triggered review that keeps its place', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki review'), 'd-request');
    await pr.send('pull_request', pr.push(SHA_2));
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, lane: 'state', kind: 'review', event: 'issue_comment.created', head_sha: SHA_2, object_id: 1001, delivery: 'd-request' },
      { id: 2, lane: 'chat', kind: 'comment', event: 'issue_comment.created' },
    ]);
  });

  it('queues thread work in arrival order behind the review', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await pr.send('issue_comment', pr.comment('@manki check'));
    await pr.send('issue_comment', pr.comment('@manki remember tabs'));
    expect((await workRows(pr.stub)).map((row) => `${row.lane}:${row.kind}`)).toEqual([
      'state:review', 'state:thread', 'state:comment', 'chat:comment',
    ]);
  });

  it('keeps a review state check queued behind a thread reply', async () => {
    const pr = pullRequest();
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await pr.send('pull_request_review', pr.review());
    await pr.send('pull_request_review_comment', pr.reply('Agreed'));
    expect((await workRows(pr.stub)).map((row) => `${row.kind}:${row.status}`)).toEqual(['thread:queued', 'review_state:queued', 'thread:queued']);
  });

  it('merges review state checks into the queued one, which runs for the newest review', async () => {
    const pr = pullRequest();
    await pr.send('pull_request_review', pr.review());
    expect(await pr.send('pull_request_review', { ...pr.review(), review: { ...pr.review().review, id: 3003 } }, 'd-newest'))
      .toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await workRows(pr.stub)).toMatchObject([{ kind: 'review_state', object_id: 3003, sender: 'alice', delivery: 'd-newest' }]);
  });

  it('never lets an outsider\'s review replace a trusted review state trigger, and lets trusted work take over an outsider\'s', async () => {
    const pr = pullRequest();
    await pr.send('pull_request_review', pr.review(), 'd-trusted');
    expect(await pr.send('pull_request_review', pr.outsiderReview())).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await workRows(pr.stub)).toMatchObject([{ object_id: 2002, delivery: 'd-trusted', trusted: 1 }]);

    const other = pullRequest();
    await other.send('pull_request_review', other.outsiderReview());
    expect(await workRows(other.stub)).toMatchObject([{ trusted: 0 }]);
    await other.send('pull_request_review_thread', other.resolve());
    expect(await workRows(other.stub)).toMatchObject([{ event: 'pull_request_review.submitted', trusted: 1 }]);
  });

  it('queues a thread change as a review state check that merges with the others', async () => {
    const pr = pullRequest();
    expect(await pr.send('pull_request_review_thread', pr.resolve(), 'd-thread')).toEqual({ accepted: true, effect: 'queued work 1' });
    expect(await workRows(pr.stub)).toMatchObject([
      { lane: 'state', kind: 'review_state', event: 'pull_request_review_thread.resolved', object_id: null, delivery: 'd-thread' },
    ]);
    // A review takes over the queued check, since its id is what the dispatch can name.
    expect(await pr.send('pull_request_review', pr.review(), 'd-review')).toEqual({ accepted: true, effect: 'merged into work 1' });
    // A later thread change leaves the review trigger in place.
    expect(await pr.send('pull_request_review_thread', pr.resolve('unresolved'))).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await workRows(pr.stub)).toMatchObject([
      { kind: 'review_state', event: 'pull_request_review.submitted', object_id: 2002, delivery: 'd-review', status: 'queued' },
    ]);
  });

  it('queues each review request on its own once the push review became one', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('issue_comment', pr.comment('@manki review'));
    expect(await pr.send('issue_comment', { ...pr.comment('@manki review again'), comment: { id: 1002, body: '@manki review again', user: { login: 'bob', type: 'User' }, author_association: 'MEMBER' } }))
      .toEqual({ accepted: true, effect: 'queued work 2' });
    await pr.send('pull_request', pr.push(SHA_2));
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, event: 'issue_comment.created', object_id: 1001, head_sha: SHA_1 },
      { id: 2, event: 'issue_comment.created', object_id: 1002, head_sha: SHA_2 },
    ]);
  });

  it('queues an outsider\'s review request on its own, so it neither takes over nor joins a push review', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    expect(await pr.send('issue_comment', pr.outsiderComment('@manki review'))).toEqual({ accepted: true, effect: 'queued work 2' });
    expect(await pr.send('pull_request', pr.push(SHA_2))).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, event: 'pull_request.synchronize', head_sha: SHA_2, trusted: 1 },
      { id: 2, event: 'issue_comment.created', head_sha: null, trusted: 0 },
    ]);

    const other = pullRequest();
    await other.send('issue_comment', other.outsiderComment('@manki review'));
    expect(await other.send('pull_request', other.push(SHA_1))).toEqual({ accepted: true, effect: 'queued work 2' });
    expect(await workRows(other.stub)).toMatchObject([
      { id: 1, event: 'issue_comment.created', head_sha: null, trusted: 0 },
      { id: 2, event: 'pull_request.synchronize', head_sha: SHA_1, trusted: 1 },
    ]);
  });

  it('collapses the edits of one comment into its queued item', async () => {
    const pr = pullRequest();
    await pr.send('issue_comment', pr.comment('@manki explain'));
    expect(await pr.send('issue_comment', pr.comment('@manki explain this', 'edited'), 'd-edit-1')).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await pr.send('issue_comment', pr.comment('@manki explain that', 'edited'), 'd-edit-2')).toEqual({ accepted: true, effect: 'merged into work 1' });
    // An edit that turns the comment into another kind of work, or that comes from someone else, queues on its own.
    expect(await pr.send('issue_comment', pr.comment('@manki review', 'edited'))).toEqual({ accepted: true, effect: 'queued work 2' });
    expect(await pr.send('issue_comment', pr.outsiderComment('@manki explain', 'edited'))).toEqual({ accepted: true, effect: 'queued work 3' });
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, kind: 'comment', event: 'issue_comment.edited', delivery: 'd-edit-2', trusted: 1 },
      { id: 2, kind: 'review' },
      { id: 3, kind: 'comment', trusted: 0 },
    ]);
  });

  it('refuses a body it has seen under another delivery id', async () => {
    const pr = pullRequest();
    const route = routeDelivery('pull_request', pr.push(SHA_1));
    if (route.type !== 'work') throw new Error('expected work');
    expect(await pr.stub.receive(key('d-1', 'body'), route)).toMatchObject({ accepted: true });
    expect(await pr.stub.receive(key('d-2', 'body'), route)).toEqual({ accepted: false, reason: 'duplicate delivery' });
    expect(await workRows(pr.stub)).toHaveLength(1);
  });

  it('restarts the age of a queued comment-triggered review on a push', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    await pr.send('issue_comment', pr.comment('@manki review'));
    advanceClock(QUEUED_MAX_AGE_MS - MINUTE);
    await pr.send('pull_request', pr.push(SHA_2));
    advanceClock(2 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ event: 'issue_comment.created', head_sha: SHA_2, status: 'skipped' }]);
  });

  it('restarts the age of a queued review on every push', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    advanceClock(QUEUED_MAX_AGE_MS - MINUTE);
    await pr.send('pull_request', pr.push(SHA_2));
    advanceClock(2 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ head_sha: SHA_2, status: 'skipped' }]);
  });

  it('drops queued work on a merge and queues the fix rate run', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('issue_comment', pr.comment('@manki explain'));
    expect(await pr.send('pull_request', pr.close(true))).toEqual({ accepted: true, effect: 'closed, dropped 2, queued work 3' });
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'dropped', note: 'pull request closed' },
      { status: 'dropped', note: 'pull request closed' },
      { kind: 'merged', event: 'pull_request.closed', status: 'queued' },
    ]);
  });

  it('drops queued work on a close without merge and queues nothing', async () => {
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    expect(await pr.send('pull_request', pr.close(false))).toEqual({ accepted: true, effect: 'closed, dropped 1' });
    expect((await workRows(pr.stub)).map((row) => row.status)).toEqual(['dropped']);
  });
});

describe('PrCoordinator.alarm', () => {
  it('logs what it would dispatch, one item per lane, and marks it skipped', async () => {
    const mints: unknown[] = [];
    stubGitHub({
      api: {
        ...OPTED_IN.api,
        [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: async (request) => {
          mints.push(await request.json());
          return Response.json({ token: 'ghs_repo' }, { status: 201 });
        },
      },
    });
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1), 'd-push');
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await pr.send('issue_comment', pr.comment('@manki explain'));

    expect(await runDurableObjectAlarm(pr.stub)).toBe(true);
    expect((await workRows(pr.stub)).map((row) => `${row.kind}:${row.status}`)).toEqual(['review:skipped', 'thread:queued', 'comment:skipped']);
    expect(logged(log, 'coordinator_would_dispatch')).toEqual([
      expect.objectContaining({ work_id: 1, lane: 'state', kind: 'review', event: 'pull_request.synchronize', head_sha: SHA_1, delivery: 'd-push', opted_in: true }),
      expect.objectContaining({ work_id: 3, lane: 'chat', kind: 'comment', event: 'issue_comment.created', object_id: 1001, sender: 'alice' }),
    ]);

    expect(mints).toEqual([{ permissions: { contents: 'read', metadata: 'read' }, repository_ids: [REPOSITORY_ID] }]);

    expect(await runDurableObjectAlarm(pr.stub)).toBe(true);
    expect((await workRows(pr.stub)).map((row) => row.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('logs the reason a repository is not opted in', async () => {
    stubGitHub({ api: { 'POST /graphql': workflowsReply({ 'manki.yml': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }) } });
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_would_dispatch')).toMatchObject([
      { opted_in: false, opt_in_reason: 'event-driven Manki workflow manki.yml is next to manki-dispatch.yml' },
    ]);
  });

  it('reads the opt-in at most once per TTL', async () => {
    const requests = stubGitHub(OPTED_IN);
    const pr = pullRequest();
    const graphqlCalls = () => apiRequests(requests).filter((request) => request.url.endsWith('/graphql')).length;

    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(graphqlCalls()).toBe(1);

    advanceClock(OPT_IN_TTL_MS);
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    expect(graphqlCalls()).toBe(2);
  });

  it('counts a refused token as not opted in', async () => {
    stubGitHub({ accessToken: { status: 422, body: { message: 'permissions not granted' } } });
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_would_dispatch')).toMatchObject([{ opted_in: false, opt_in_reason: 'token mint refused with 422' }]);
  });

  it('retries a start that keeps failing with a growing backoff, capped at 16 minutes', async () => {
    stubGitHub({ api: { 'POST /graphql': { status: 502, body: {} } } });
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    const waits: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      await runDurableObjectAlarm(pr.stub);
      const alarm = await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm());
      waits.push((alarm! - Date.now()) / MINUTE);
      advanceClock(alarm! - Date.now());
    }
    expect(waits).toEqual([2, 4, 8, 16, 16]);
    expect(logged(log, 'coordinator_start_error')[0]).toMatchObject({ work_id: 1, error: 'Error: GraphQL request failed with 502' });

    stubGitHub(OPTED_IN);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped' }]);
  });

  it('upgrades the tables of an older object on its first alarm', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    // The state an object left by the first schema version, before this instance touched it.
    await runInDurableObject(pr.stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      sql.exec(MIGRATIONS[0]);
      sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`);
      sql.exec(`INSERT INTO deliveries (id, received_at) VALUES ('d-old', ?)`, Date.now());
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('target', ?)`,
        JSON.stringify({ installationId: 987, repositoryId: REPOSITORY_ID, owner: 'manki-review', repo: 'manki', defaultBranch: 'main', number: pr.number }),
      );
      sql.exec(
        `INSERT INTO work (lane, kind, event, head_sha, object_id, sender, delivery, enqueued_at, status)
         VALUES ('chat', 'comment', 'issue_comment.created', NULL, 1001, 'alice', 'd-old', ?, 'queued')`,
        Date.now(),
      );
    });
    expect(await runDurableObjectAlarm(pr.stub)).toBe(false);
    await runInDurableObject(pr.stub, (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_lane_error')).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', errors: 0 }]);
  });

  it('starts nothing else in a lane while an item there is dispatching', async () => {
    stubGitHub({ api: { 'POST /graphql': { status: 502, body: {} } } });
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(30_000);
    await runDurableObjectAlarm(pr.stub);
    expect((await workRows(pr.stub)).map((row) => row.status)).toEqual(['dispatching', 'queued']);
  });

  it('drops an item that a close lands on while the alarm waits for GitHub', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubGitHub({
      api: {
        'POST /graphql': async () => {
          await held;
          return Response.json(workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }).body);
        },
      },
    });
    const pr = pullRequest();
    await pr.send('issue_comment', pr.comment('@manki explain'));
    const alarm = runDurableObjectAlarm(pr.stub);
    await vi.waitFor(async () => expect((await workRows(pr.stub))[0].status).toBe('dispatching'));
    expect(await pr.send('pull_request', pr.close(false))).toEqual({ accepted: true, effect: 'closed, dropped 1' });
    release();
    await alarm;
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dropped', note: 'pull request closed' }]);
    expect(logged(log, 'coordinator_would_dispatch')).toEqual([]);
  });

  it('deletes finished items after a week', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(FINISHED_RETENTION_MS - MINUTE);
    await pr.send('issue_comment', pr.comment('@manki help'));
    advanceClock(2 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect((await workRows(pr.stub)).map((row) => row.id)).toEqual([2]);
  });

  it('drops work that stayed queued for more than a day', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    await pr.send('issue_comment', pr.comment('@manki explain'));
    advanceClock(QUEUED_MAX_AGE_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dropped', note: 'queued too long' }]);
    expect(logged(log, 'coordinator_would_dispatch')).toEqual([]);
  });

  it('deletes its storage and alarm a week after the last delivery', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    const alarm = await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(Date.now() + DELIVERY_RETENTION_MS);

    advanceClock(DELIVERY_RETENTION_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toEqual([]);
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
    expect(logged(log, 'coordinator_deleted')).toHaveLength(1);

    // The same instance keeps working after the cleanup.
    expect(await pr.send('pull_request', pr.push(SHA_2))).toEqual({ accepted: true, effect: 'queued work 1' });
  });
});

interface FakeRun {
  status: string;
  conclusion?: string | null;
  run_started_at?: string;
}

/** A GitHub that the dispatch path talks to, with state a test can change between alarms. */
function fakeGitHub(number: number) {
  const repo = `/repos/${OWNER}/${REPO}`;
  const state = {
    head: SHA_1,
    prState: 'open',
    draft: false,
    /** Replies the next dispatches get, in order. Afterwards 200 with a new run id. */
    dispatchStatuses: [] as Array<number | { status: number; headers: Record<string, string> }>,
    /** Statuses the next cancels answer with, in order. Afterwards 202. */
    cancelStatuses: [] as number[],
    listRunsStatus: 200,
    runReadStatus: 200,
    refuseActionsWrite: false,
    runs: new Map<number, FakeRun | null>(),
    listedRuns: [] as Array<{ id: number; display_title: string; created_at: string; actor: { login: string } }>,
    nextRunId: 9000,
    mints: [] as Array<{ permissions: Record<string, string>; repository_ids: number[] }>,
    dispatches: [] as Array<{ ref: string; inputs: Record<string, string>; return_run_details: boolean }>,
    cancels: [] as number[],
    graphqlCalls: 0,
  };
  const workflowsBody = workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }).body;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) {
      const body = await request.json() as (typeof state.mints)[number];
      state.mints.push(body);
      if (state.refuseActionsWrite && body.permissions.actions === 'write') {
        return Response.json({ message: 'The permissions requested are not granted to this installation.' }, { status: 422 });
      }
      return Response.json({ token: 'ghs_repo', expires_at: '2030-01-01T01:00:00Z' }, { status: 201 });
    }
    if (route === 'POST /graphql') {
      state.graphqlCalls++;
      return Response.json(workflowsBody);
    }
    if (route === `GET ${repo}/pulls/${number}`) {
      return Response.json({ state: state.prState, draft: state.draft, head: { sha: state.head } });
    }
    if (route === `POST ${repo}/actions/workflows/manki-dispatch.yml/dispatches`) {
      state.dispatches.push(await request.json() as (typeof state.dispatches)[number]);
      const next = state.dispatchStatuses.shift() ?? 200;
      const { status, headers } = typeof next === 'number' ? { status: next, headers: {} } : next;
      if (status === 204) return new Response(null, { status });
      if (status !== 200) return new Response('{"message":"no"}', { status, headers });
      const id = state.nextRunId++;
      state.runs.set(id, { status: 'queued' });
      return Response.json({ workflow_run_id: id, run_url: `https://api.github.com${repo}/actions/runs/${id}`, html_url: 'https://github.com' });
    }
    if (route === `GET ${repo}/actions/workflows/manki-dispatch.yml/runs`) {
      if (state.listRunsStatus !== 200) return Response.json({ message: 'no' }, { status: state.listRunsStatus });
      return Response.json({ total_count: state.listedRuns.length, workflow_runs: state.listedRuns });
    }
    const run = url.pathname.match(new RegExp(`^${repo}/actions/runs/(\\d+)(/cancel)?$`));
    if (run && request.method === 'POST' && run[2]) {
      state.cancels.push(Number(run[1]));
      return new Response(null, { status: state.cancelStatuses.shift() ?? 202 });
    }
    if (run && request.method === 'GET') {
      if (state.runReadStatus !== 200) return Response.json({ message: 'no' }, { status: state.runReadStatus });
      const found = state.runs.get(Number(run[1]));
      return found ? Response.json(found) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    throw new Error(`Unexpected fetch: ${route}`);
  });
  return state;
}

describe('PrCoordinator dispatch', () => {
  beforeEach(() => {
    setDispatchEnabled(true);
  });

  it('dispatches the oldest item of each lane with the inputs Manki reads', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1), 'd-push');
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await pr.send('issue_comment', pr.comment('@manki explain'), 'd-explain');

    await runDurableObjectAlarm(pr.stub);
    // The two lanes dispatch concurrently, so their order is not fixed.
    expect(github.dispatches).toHaveLength(2);
    expect(github.dispatches).toEqual(expect.arrayContaining([
      { ref: 'main', return_run_details: true, inputs: { event: 'pull_request', action: 'synchronize', pr: String(pr.number), head_sha: SHA_1, delivery_id: 'd-push' } },
      { ref: 'main', return_run_details: true, inputs: { event: 'issue_comment', action: 'created', pr: String(pr.number), comment_id: '1001', delivery_id: 'd-explain' } },
    ]));
    expect((await workRows(pr.stub)).map((row) => [row.kind, row.status, row.run_id !== null])).toEqual([
      ['review', 'running', true], ['thread', 'queued', false], ['comment', 'running', true],
    ]);
    expect(logged(log, 'coordinator_dispatched')).toHaveLength(2);
  });

  it('mints actions: write only for the dispatch, each token scoped to the repository', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.mints).toEqual([
      { permissions: { contents: 'read', metadata: 'read' }, repository_ids: [REPOSITORY_ID] },
      { permissions: { pull_requests: 'read' }, repository_ids: [REPOSITORY_ID] },
      { permissions: { actions: 'write' }, repository_ids: [REPOSITORY_ID] },
    ]);
  });

  it('holds the lane until the workflow_run webhook ends the run, then starts the next item', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await runDurableObjectAlarm(pr.stub);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);

    const runEnd = workflowRunEvent({ id: 9000, display_title: `Manki pull_request.synchronize on #${pr.number} (d-1)`, conclusion: 'success' });
    expect((await postWebhook({ event: 'workflow_run', payload: runEnd })).status).toBe(202);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', conclusion: 'success', note: 'run completed' }, { status: 'queued' }]);
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.now());

    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request', 'pull_request_review_comment']);
  });

  it('creates no state for the end of a run on a PR it never saw', async () => {
    fakeGitHub(999);
    const stub = coordinator(REPOSITORY_ID, 999);
    const runEnd = workflowRunEvent({ id: 4321, display_title: 'Manki issue_comment.created on #999 (d-x)' });
    expect((await postWebhook({ event: 'workflow_run', payload: runEnd })).status).toBe(202);
    expect(logged(log, 'coordinator_run_completed')).toMatchObject([{ accepted: false, reason: 'no coordinator state' }]);
    expect(await tableNames(stub)).toEqual([]);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('ignores the end of a run it does not hold and a replayed run end', async () => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await pr.stub.runCompleted(key('d-other'), 1234, 'success')).toEqual({ accepted: false, reason: 'no running item for run 1234' });
    expect(await pr.stub.runCompleted(key('d-end', 'end'), 9000, 'failure')).toMatchObject({ accepted: true });
    expect(await pr.stub.runCompleted(key('d-end'), 9000, 'failure')).toEqual({ accepted: false, reason: 'duplicate delivery' });
    expect(await pr.stub.runCompleted(key('d-replayed', 'end'), 9000, 'failure')).toEqual({ accepted: false, reason: 'duplicate delivery' });
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', conclusion: 'failure' }]);
  });

  it('tracks a run that started while a close dropped its item', async () => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatching = false;
    const fake = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (new Request(input, init).url.endsWith('/dispatches')) {
        dispatching = true;
        await held;
      }
      return fake(input, init);
    });
    await pr.send('issue_comment', pr.comment('@manki explain'));
    const alarm = runDurableObjectAlarm(pr.stub);
    await vi.waitFor(() => expect(dispatching).toBe(true));
    await pr.send('pull_request', pr.close(true));
    release();
    await alarm;
    expect(await workRows(pr.stub)).toMatchObject([
      { kind: 'comment', status: 'running', run_id: 9000 },
      { kind: 'merged', status: 'queued' },
    ]);
  });

  it('queues a review of a new head pushed while a review runs', async () => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await pr.send('pull_request', pr.push(SHA_2))).toEqual({ accepted: true, effect: 'queued work 2' });
  });

  it('reviews the head the PR has when the review starts', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.head = SHA_3;
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches[0].inputs.head_sha).toBe(SHA_3);
  });

  it.each([
    ['closed', { prState: 'closed' }, 'pull request closed'],
    ['back in draft', { draft: true }, 'pull request is a draft'],
  ])('drops a review when the PR is %s', async (_case, change, note) => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), change);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dropped', note }]);
  });

  it('polls a run every two minutes as a safety net and ends it once completed', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.now() + POLL_MS);

    github.runs.set(9000, { status: 'in_progress', run_started_at: new Date().toISOString() });
    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', check_at: Date.now() + POLL_MS }]);

    github.runs.set(9000, { status: 'completed', conclusion: 'cancelled' });
    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', conclusion: 'cancelled', note: 'run completed (poll)' }]);
  });

  it('ends an item whose run was deleted', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    github.runs.delete(9000);
    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', note: 'run deleted' }]);
  });

  it('cancels a run that never started and moves the lane on', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(QUEUED_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(github.dispatches).toHaveLength(2);
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'timed_out', note: 'run never started, cancel requested' },
      { status: 'running', run_id: 9001 },
    ]);
  });

  it('cancels a run that went past its timeout', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    github.runs.set(9000, { status: 'in_progress', run_started_at: new Date().toISOString() });
    advanceClock(RUNNING_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'timed_out', note: 'run went past its timeout, cancel requested' }]);
  });

  it('retries a failed dispatch after a backoff and adopts the run of an attempt whose response was lost', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [502];
    await pr.send('pull_request', pr.push(SHA_1), 'd-lost');
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', attempts: 1, lease_until: Date.now() + DISPATCH_BACKOFF_MS[0] }]);

    const event = `Manki pull_request.synchronize on #${pr.number}`;
    const run = (id: number, display_title: string, login = 'manki-review[bot]') =>
      ({ id, display_title, created_at: new Date().toISOString(), actor: { login } });
    github.listedRuns = [
      run(7001, `${event} (d-lost)`, 'alice'),
      run(7002, `${event} (d-other)`),
      run(7004, event),
      run(7003, `${event} (d-lost)`),
    ];
    advanceClock(DISPATCH_BACKOFF_MS[0]);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', run_id: 7003, note: 'recovered the run of an earlier attempt' }]);
  });

  it('dispatches again when no lost run turns up, and fails after the last backoff', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [500, 502, 503, 500];
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    for (const wait of DISPATCH_BACKOFF_MS) {
      advanceClock(wait);
      await runDurableObjectAlarm(pr.stub);
    }
    expect(github.dispatches).toHaveLength(4);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'failed', note: 'dispatch failed 4 times, last with 500' }]);
  });

  it('skips work and logs once when the installation lacks actions: write', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.refuseActionsWrite = true;
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(logged(log, 'coordinator_lacks_actions_write')).toHaveLength(1);
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'skipped', note: 'installation lacks actions: write' },
      { status: 'skipped', note: 'not opted in: installation lacks actions: write' },
    ]);
  });

  it('fails a refused dispatch and reads the opt-in again', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [422];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'failed', note: 'dispatch refused with 422: {"message":"no"}' }]);
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.graphqlCalls).toBe(2);
  });

  it(`drops work over ${DISPATCHES_PER_HOUR} dispatches an hour`, async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    for (let i = 0; i <= DISPATCHES_PER_HOUR; i++) {
      await pr.send('issue_comment', pr.comment(`@manki explain ${i}`));
      await runDurableObjectAlarm(pr.stub);
      await pr.stub.runCompleted(key(`d-end-${i}`), 9000 + i, 'success');
    }
    expect(github.dispatches).toHaveLength(DISPATCHES_PER_HOUR);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'dropped', note: `over ${DISPATCHES_PER_HOUR} dispatches in the last hour` });

    advanceClock(59 * MINUTE);
    await pr.send('issue_comment', pr.comment('@manki explain still capped'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(DISPATCHES_PER_HOUR);

    advanceClock(MINUTE + 1);
    await pr.send('issue_comment', pr.comment('@manki explain after the hour'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(DISPATCHES_PER_HOUR + 1);
  });

  it('counts the cap per lane', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    for (let i = 0; i < DISPATCHES_PER_HOUR; i++) {
      await pr.send('issue_comment', pr.comment(`@manki explain ${i}`));
      await runDurableObjectAlarm(pr.stub);
      await pr.stub.runCompleted(key(`d-end-${i}`), 9000 + i, 'success');
    }
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(DISPATCHES_PER_HOUR + 1);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ lane: 'state', status: 'running' });
  });

  it(`drops outsiders' work over ${UNTRUSTED_DISPATCHES_PER_HOUR} dispatches an hour without using up the cap of repository users`, async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    for (let i = 0; i <= UNTRUSTED_DISPATCHES_PER_HOUR; i++) {
      await pr.send('issue_comment', pr.outsiderComment(`@manki explain ${i}`));
      await runDurableObjectAlarm(pr.stub);
      await pr.stub.runCompleted(key(`d-end-${i}`), 9000 + i, 'success');
    }
    expect(github.dispatches).toHaveLength(UNTRUSTED_DISPATCHES_PER_HOUR);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'dropped', note: `over ${UNTRUSTED_DISPATCHES_PER_HOUR} dispatches in the last hour` });

    for (let i = 0; i < DISPATCHES_PER_HOUR; i++) {
      await pr.send('issue_comment', pr.comment(`@manki explain ${i}`));
      await runDurableObjectAlarm(pr.stub);
      await pr.stub.runCompleted(key(`d-user-end-${i}`), 9000 + UNTRUSTED_DISPATCHES_PER_HOUR + i, 'success');
    }
    expect(github.dispatches).toHaveLength(UNTRUSTED_DISPATCHES_PER_HOUR + DISPATCHES_PER_HOUR);
  });

  it.each([
    ['a review', (pr: ReturnType<typeof pullRequest>) => pr.send('pull_request', pr.push(SHA_1)), 'pull_request'],
    ['a merge', (pr: ReturnType<typeof pullRequest>) => pr.send('pull_request', pr.close(true)), 'pull_request'],
  ])(`holds %s over ${DISPATCHES_PER_HOUR} dispatches an hour until the hour allows it`, async (_case, queue, event) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    const start = Date.now();
    for (let i = 0; i < DISPATCHES_PER_HOUR; i++) {
      await pr.send('issue_comment', pr.comment(`@manki check ${i}`));
      await runDurableObjectAlarm(pr.stub);
      await pr.stub.runCompleted(key(`d-end-${i}`), 9000 + i, 'success');
    }
    advanceClock(10 * MINUTE);
    await queue(pr);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(DISPATCHES_PER_HOUR);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'queued', check_at: start + 60 * MINUTE });
    expect(logged(log, 'coordinator_held')).toHaveLength(1);
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(start + 60 * MINUTE);

    advanceClock(49 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(DISPATCHES_PER_HOUR);
    expect(logged(log, 'coordinator_held')).toHaveLength(1);

    advanceClock(MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.at(-1)?.inputs.event).toBe(event);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'running' });
  });

  it('reuses a token until shortly before it expires', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    const actionsWrites = () => github.mints.filter((mint) => mint.permissions.actions === 'write').length;
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    await pr.stub.runCompleted(key('d-end-1'), 9000, 'success');
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(2);
    expect(actionsWrites()).toBe(1);

    // The fake GitHub's tokens expire an hour after the clock starts.
    await pr.stub.runCompleted(key('d-end-2'), 9001, 'success');
    advanceClock(55 * MINUTE);
    await pr.send('issue_comment', pr.comment('@manki forget tabs'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(3);
    expect(actionsWrites()).toBe(2);
  });

  it.each<[string, number | { status: number; headers: Record<string, string> }]>([
    ['a 429', 429],
    ['a 403 with retry-after', { status: 403, headers: { 'retry-after': '30' } }],
    ['a 403 with no rate limit left', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
  ])('retries a dispatch refused with %s', async (_case, reply) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [reply];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', attempts: 1 }]);
    advanceClock(DISPATCH_BACKOFF_MS[0]);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(2);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', run_id: 9000 }]);
  });

  it('fails a dispatch refused with a plain 403', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [403];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'failed', note: 'dispatch refused with 403: {"message":"no"}' }]);
  });

  it('never adopts a run another item holds', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.dispatchStatuses = [502];
    await pr.send('pull_request', pr.push(SHA_1), 'd-lost');
    await runDurableObjectAlarm(pr.stub);

    const title = `Manki pull_request.synchronize on #${pr.number} (d-lost)`;
    const listed = (id: number, minutes: number) =>
      ({ id, display_title: title, created_at: new Date(Date.now() + minutes * MINUTE).toISOString(), actor: { login: 'manki-review[bot]' } });
    github.listedRuns = [listed(9000, 0), listed(7005, 1)];
    advanceClock(DISPATCH_BACKOFF_MS[0]);
    await runDurableObjectAlarm(pr.stub);
    expect((await workRows(pr.stub)).map((row) => [row.kind, row.run_id])).toEqual([['comment', 9000], ['review', 7005]]);
  });

  it('fails a dispatch whose run never turns up within 10 minutes', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [204];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', run_id: null }]);
    advanceClock(RUN_LOOKUP_TIMEOUT_MS - MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }]);
    advanceClock(2 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'failed', note: 'no run found for the dispatch' }]);
  });

  it('backs off a failing poll instead of firing the alarm again at once', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [204];
    github.listRunsStatus = 502;
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    const alarmAt = () => runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm());

    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_lane_error')).toHaveLength(1);
    expect(await alarmAt()).toBe(Date.now() + POLL_MS);

    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(await alarmAt()).toBe(Date.now() + 2 * POLL_MS);
  });

  it('caps the poll backoff at 16 minutes', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.runReadStatus = 500;
    const waits: number[] = [];
    for (let poll = 0; poll < 5; poll++) {
      const alarm = await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm());
      advanceClock(alarm! - Date.now());
      await runDurableObjectAlarm(pr.stub);
      waits.push(((await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm()))! - Date.now()) / MINUTE);
    }
    expect(waits).toEqual([2, 4, 8, 16, 16]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', errors: 5 }]);
  });

  it('ends a running item at the deadline whatever its polls return', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    github.runReadStatus = 500;
    advanceClock(RUN_DEADLINE_MS - MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }, { status: 'queued' }]);
    advanceClock(2 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'timed_out', note: 'no end of the run seen in time' }, { status: 'running' }]);
  });

  it('keeps the lane busy and retries a cancel that failed', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.cancelStatuses = [500];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(QUEUED_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_cancel_failed')).toMatchObject([{ run_id: 9000, status: 500 }]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }, { status: 'queued' }]);

    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000, 9000]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'timed_out', note: 'run never started, cancel requested' }, { status: 'running' }]);
  });

  it('does not dispatch for a repository that has not opted in', async () => {
    const pr = pullRequest();
    stubGitHub({ api: { 'POST /graphql': workflowsReply({ 'manki.yml': EVENT_WORKFLOW_YAML }) } });
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', note: 'not opted in: no manki-dispatch.yml' }]);
  });
});
