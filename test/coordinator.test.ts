import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELIVERY_RETENTION_MS, FINISHED_RETENTION_MS, OPT_IN_TTL_MS, QUEUED_MAX_AGE_MS } from '../src/coordinator';
import { routeDelivery, type WebhookPayload } from '../src/routing';
import { apiRequests, coordinator, freezeClock, type GitHubStub, INSTALLATION_ID, stubGitHub, workRows } from './helpers';
import {
  DISPATCH_WORKFLOW_YAML,
  EVENT_WORKFLOW_YAML,
  issueCommentEvent,
  pullRequestEvent,
  REPOSITORY_ID,
  reviewCommentEvent,
  reviewEvent,
  reviewThreadEvent,
  workflowsReply,
} from './payloads';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const SHA_3 = '3'.repeat(40);
const MINUTE = 60_000;

const OPTED_IN: GitHubStub = { api: { 'POST /graphql': workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }) } };

// Storage outlives a single test, so each test works on its own PR number.
let nextNumber = 100;

function pullRequest() {
  const number = nextNumber++;
  const stub = coordinator(REPOSITORY_ID, number);
  return {
    stub,
    push: (sha: string, action = 'synchronize') => pullRequestEvent(action, { number, head: { sha, repo: { full_name: 'manki-review/manki' } } }),
    comment: (body: string, action = 'created') => issueCommentEvent(body, { number, action }),
    review: () => reviewEvent('submitted', {}, { number }),
    resolve: (action = 'resolved') => reviewThreadEvent(action, { number }),
    reply: (body: string) => reviewCommentEvent(body, { in_reply_to_id: 1 }, 'created', { number }),
    close: (merged: boolean) => pullRequestEvent('closed', { number, merged }),
    async send(event: string, payload: WebhookPayload, delivery: string = crypto.randomUUID()) {
      const route = routeDelivery(event, payload);
      if (route.type !== 'work' && route.type !== 'close') throw new Error(`Route ${route.type} is not for the coordinator`);
      return stub.receive(delivery, route);
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
    expect(await pr.send('issue_comment', { ...pr.comment('@manki review again'), comment: { id: 1002, body: '@manki review again', user: { login: 'bob', type: 'User' } } }))
      .toEqual({ accepted: true, effect: 'queued work 2' });
    await pr.send('pull_request', pr.push(SHA_2));
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, event: 'issue_comment.created', object_id: 1001, head_sha: SHA_1 },
      { id: 2, event: 'issue_comment.created', object_id: 1002, head_sha: SHA_2 },
    ]);
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

  it('retries an item a minute after the opt-in read failed', async () => {
    stubGitHub({ api: { 'POST /graphql': { status: 502, body: {} } } });
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_opt_in_error')).toMatchObject([{ work_id: 1, error: 'Error: GraphQL request failed with 502' }]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', lease_until: Date.now() + 60_000 }]);
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.now() + 60_000);

    stubGitHub(OPTED_IN);
    advanceClock(60_000);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped' }]);
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
