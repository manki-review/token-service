import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_RETENTION_MS,
  MIGRATIONS,
  DISPATCH_BACKOFF_MS,
  DISPATCHES_PER_HOUR,
  CONFLICT_NOTE_MARKER,
  FINISHED_RETENTION_MS,
  IDLE_RETENTION_MS,
  OPT_IN_TTL_MS,
  backoff,
  POLL_MS,
  QUEUED_MAX_AGE_MS,
  QUEUED_RUN_TIMEOUT_MS,
  REPLY_FIRST_MS,
  RUN_DEADLINE_MS,
  RUN_LOOKUP_TIMEOUT_MS,
  RUNNING_RUN_TIMEOUT_MS,
  type Delivery,
  UNTRUSTED_DISPATCHES_PER_HOUR,
} from '../src/coordinator';
import { HELP_REPLY } from '../src/manki';
import { routeDelivery, type Target, type WebhookPayload } from '../src/routing';
import {
  apiRequests,
  APP_ID,
  coordinator,
  freezeClock,
  type GitHubStub,
  INSTALLATION_ID,
  JWKS_URL,
  logged,
  OIDC_JWKS,
  oidcToken,
  OWNER,
  OWNER_ID,
  postToken,
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
  MANKI_AUTHOR,
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
const DAY = 24 * 60 * MINUTE;

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

let advanceClock: (ms: number) => number;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  advanceClock = freezeClock();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setDispatchEnabled(false);
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
    expect(await workRows(other.stub)).toMatchObject([{ trusted: 0, writer: 0 }]);
    // A writer's thread change takes the trigger over, so the check never runs under the outsider's name.
    await other.send('pull_request_review_thread', other.resolve(), 'd-writer');
    expect(await workRows(other.stub)).toMatchObject([
      { event: 'pull_request_review_thread.resolved', object_id: null, delivery: 'd-writer', trusted: 1, writer: 1 },
    ]);

    // A trusted review whose sender may lack write access never replaces a writer's trigger either, since the lookup
    // of its sender could drop the check.
    const third = pullRequest();
    await third.send('pull_request_review_thread', third.resolve(), 'd-resolve');
    const contributor = reviewEvent('submitted', { id: 3004, author_association: 'CONTRIBUTOR' }, { number: third.number });
    expect(await third.send('pull_request_review', contributor)).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await workRows(third.stub)).toMatchObject([{ event: 'pull_request_review_thread.resolved', delivery: 'd-resolve', trusted: 1, writer: 1 }]);
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

  it('merges a review command into the queued one, and queues an edited request on its own', async () => {
    const pr = pullRequest();
    const comment = (id: number, body: string, action = 'created', user = { login: 'alice', type: 'User' }) =>
      ({ ...pr.comment(body, action), comment: { id, body, user, author_association: 'MEMBER' } });
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('issue_comment', pr.comment('@manki review'), 'd-request');
    expect(await pr.send('issue_comment', comment(1002, '@manki review again'))).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await pr.send('issue_comment', comment(1004, '@manki review now', 'edited'))).toEqual({ accepted: true, effect: 'queued work 2' });
    // A command after the edit still joins the queued command.
    expect(await pr.send('issue_comment', comment(1005, '@manki review'), 'd-newest')).toEqual({ accepted: true, effect: 'merged into work 1' });
    await pr.send('pull_request', pr.push(SHA_2));
    // The merged item names the newest command, whose comment the run then reads.
    expect(await workRows(pr.stub)).toMatchObject([
      { id: 1, event: 'issue_comment.created', object_id: 1005, sender: 'alice', head_sha: SHA_1, delivery: 'd-newest' },
      { id: 2, event: 'issue_comment.edited', object_id: 1004, head_sha: SHA_2 },
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

    // Nor does it join a queued review command, or take one in.
    expect(await pr.send('issue_comment', pr.comment('@manki review'))).toEqual({ accepted: true, effect: 'merged into work 1' });
    expect(await pr.send('issue_comment', pr.outsiderComment('@manki review'))).toEqual({ accepted: true, effect: 'queued work 3' });

    const other = pullRequest();
    await other.send('issue_comment', other.outsiderComment('@manki review'));
    expect(await other.send('issue_comment', other.outsiderComment('@manki review'))).toEqual({ accepted: true, effect: 'queued work 2' });
    expect(await other.send('pull_request', other.push(SHA_1))).toEqual({ accepted: true, effect: 'queued work 3' });
    expect(await workRows(other.stub)).toMatchObject([
      { id: 1, event: 'issue_comment.created', head_sha: null, trusted: 0 },
      { id: 2, event: 'issue_comment.created', head_sha: null, trusted: 0 },
      { id: 3, event: 'pull_request.synchronize', head_sha: SHA_1, trusted: 1 },
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

    // Closing again after a reopen has nothing to drop, so it stores nothing, not even the delivery.
    const deliveries = () => runInDurableObject(pr.stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM deliveries').one().count);
    const stored = await deliveries();
    expect(await pr.send('pull_request', pr.close(false))).toEqual({ accepted: true, effect: 'closed, nothing queued' });
    expect(await deliveries()).toBe(stored);

    const unseen = pullRequest();
    expect(await unseen.send('pull_request', unseen.close(false))).toEqual({ accepted: true, effect: 'closed, nothing queued' });
    expect(await tableNames(unseen.stub)).toEqual([]);
  });
});

describe('PrCoordinator catch-up state', () => {
  const target = (number: number): Target => ({
    installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, owner: 'manki-review', ownerId: OWNER_ID, repo: 'manki', defaultBranch: 'main', number,
  });

  it('reports a head as needed until a review of it is queued, and again once that review is dropped', async () => {
    const pr = pullRequest();
    expect(await pr.stub.catchUpState(SHA_1)).toBe('needed');
    await pr.send('issue_comment', pr.comment('@manki explain'));
    expect(await pr.stub.catchUpState(SHA_1)).toBe('needed');
    await pr.send('pull_request', pr.push(SHA_1));
    expect(await pr.stub.catchUpState(SHA_1)).toBe('pending');
    expect(await pr.stub.catchUpState(SHA_2)).toBe('needed');
    await pr.send('pull_request', pr.close(false));
    expect(await pr.stub.catchUpState(SHA_1)).toBe('needed');
  });

  it('reports a head as needed again when its review was skipped', async () => {
    stubGitHub(OPTED_IN);
    const pr = pullRequest();
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped' }]);
    expect(await pr.stub.catchUpState(SHA_1)).toBe('needed');
  });

  it('stores a catch-up like a delivery and refuses the same head again', async () => {
    const pr = pullRequest();
    expect(await pr.stub.catchUp(target(pr.number), SHA_1)).toEqual({ accepted: true, effect: 'queued work 1' });
    const deliveries = await runInDurableObject(pr.stub, (_instance, state) =>
      state.storage.sql.exec<{ id: string; received_at: number }>('SELECT id, received_at FROM deliveries').toArray());
    expect(deliveries).toEqual([{ id: `catch-up-${SHA_1.slice(0, 12)}`, received_at: Date.now() }]);
    expect(await pr.stub.catchUp(target(pr.number), SHA_1)).toEqual({ accepted: false, reason: 'head already handled' });
  });

  it('marks a bot head as handled without work, refuses the same delivery twice and sets its cleanup alarm', async () => {
    const pr = pullRequest();
    expect(await pr.stub.markSeen(key('d-bot'), target(pr.number), SHA_1)).toEqual({ accepted: true, effect: 'head marked as seen' });
    expect(await pr.stub.markSeen(key('d-bot'), target(pr.number), SHA_1)).toEqual({ accepted: false, reason: 'duplicate delivery' });
    expect(await workRows(pr.stub)).toEqual([]);
    expect(await pr.stub.catchUpState(SHA_1)).toBe('handled');
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.now() + IDLE_RETENTION_MS);
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
    await pr.send('pull_request_review', pr.review());
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki help'));

    // A help answer is no run, but it writes to the PR, so it is held back too. `stubGitHub` refuses any other call.
    expect(await runDurableObjectAlarm(pr.stub)).toBe(true);
    expect((await workRows(pr.stub)).map((row) => `${row.kind}:${row.status}`)).toEqual(['review:skipped', 'review_state:queued', 'comment:skipped', 'help:skipped']);
    expect(logged(log, 'coordinator_would_dispatch')).toEqual([
      expect.objectContaining({ work_id: 1, lane: 'state', kind: 'review', event: 'pull_request.synchronize', head_sha: SHA_1, delivery: 'd-push', opted_in: true }),
      expect.objectContaining({ work_id: 3, lane: 'chat', kind: 'comment', event: 'issue_comment.created', object_id: 1001, sender: 'alice' }),
      expect.objectContaining({ work_id: 4, lane: 'help', kind: 'help' }),
    ]);

    expect(mints).toEqual([{ permissions: { contents: 'read', metadata: 'read' }, repository_ids: [REPOSITORY_ID] }]);

    expect(await runDurableObjectAlarm(pr.stub)).toBe(true);
    expect((await workRows(pr.stub)).map((row) => row.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
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
    await pr.send('issue_comment', pr.comment('@manki explain'));
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
    await pr.send('pull_request_review', pr.review());
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
    await pr.send('issue_comment', pr.comment('@manki explain'));
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

  it('deletes its storage a week after the PR closed, or after its last delivery when it stays open', async () => {
    stubGitHub(OPTED_IN);
    const alarm = (stub: DurableObjectStub) => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    const open = pullRequest();
    await open.send('pull_request', open.push(SHA_1));
    await runDurableObjectAlarm(open.stub);
    expect(await alarm(open.stub)).toBe(Date.now() + IDLE_RETENTION_MS);

    // A close with nothing queued writes only its time, once.
    const closed = pullRequest();
    await closed.send('pull_request', closed.push(SHA_1));
    await runDurableObjectAlarm(closed.stub);
    advanceClock(DAY);
    expect(await closed.send('pull_request', closed.close(false))).toEqual({ accepted: true, effect: 'closed, nothing queued' });
    const closedAt = Date.now();
    expect(await alarm(closed.stub)).toBe(closedAt + DELIVERY_RETENTION_MS);
    advanceClock(MINUTE);
    await closed.send('pull_request', closed.close(false));
    expect(await alarm(closed.stub)).toBe(closedAt + DELIVERY_RETENTION_MS);

    advanceClock(DELIVERY_RETENTION_MS);
    await runDurableObjectAlarm(closed.stub);
    expect(await tableNames(closed.stub)).toEqual([]);
    expect(await alarm(closed.stub)).toBeNull();
    await runDurableObjectAlarm(open.stub);
    expect(await tableNames(open.stub)).not.toEqual([]);

    advanceClock(IDLE_RETENTION_MS);
    await runDurableObjectAlarm(open.stub);
    expect(await tableNames(open.stub)).toEqual([]);
    expect(logged(log, 'coordinator_deleted')).toHaveLength(2);

    // The same instance keeps working after the cleanup.
    expect(await open.send('pull_request', open.push(SHA_2))).toEqual({ accepted: true, effect: 'queued work 1' });

    // Work queued after the close, as on a reopened PR, counts it as open again.
    const reopened = pullRequest();
    await reopened.send('pull_request', reopened.push(SHA_1));
    await reopened.send('pull_request', reopened.close(false));
    await runDurableObjectAlarm(reopened.stub);
    expect(await alarm(reopened.stub)).toBe(Date.now() + DELIVERY_RETENTION_MS);
    advanceClock(DAY);
    await reopened.send('issue_comment', reopened.comment('@manki explain'));
    expect(await alarm(reopened.stub)).toBe(Date.now());
    await runDurableObjectAlarm(reopened.stub);
    expect(await alarm(reopened.stub)).toBe(Date.now() + IDLE_RETENTION_MS);

    // So does a reopen alone, which queues no work. A redelivered close does not mark the PR closed again.
    const quiet = pullRequest();
    await quiet.send('pull_request', quiet.push(SHA_1), 'd-quiet');
    await quiet.send('pull_request', quiet.close(false), 'd-close');
    await runDurableObjectAlarm(quiet.stub);
    advanceClock(DAY);
    const reopenedAt = Date.now();
    const reopen = (pr: ReturnType<typeof pullRequest>) =>
      postWebhook({ event: 'pull_request', payload: pullRequestEvent('reopened', { number: pr.number, updated_at: new Date().toISOString() }) });
    expect((await reopen(quiet)).status).toBe(202);
    expect(await workRows(quiet.stub)).toMatchObject([{ status: 'dropped' }]);
    expect(logged(log, 'coordinator_reopened')).toHaveLength(1);
    expect(await alarm(quiet.stub)).toBe(reopenedAt + IDLE_RETENTION_MS);
    expect(await quiet.send('pull_request', quiet.close(false), 'd-close')).toEqual({ accepted: false, reason: 'duplicate delivery' });

    // Once the close's delivery id is forgotten, its time still shows it came before the reopen. A merge never does.
    const closeAt = (pr: ReturnType<typeof pullRequest>, at: number, merged = false) =>
      pullRequestEvent('closed', { number: pr.number, merged, closed_at: new Date(at).toISOString() });
    advanceClock(DELIVERY_RETENTION_MS);
    expect(await quiet.send('pull_request', closeAt(quiet, reopenedAt - DAY), 'd-close')).toEqual({ accepted: false, reason: 'close older than the open PR' });
    expect(await alarm(quiet.stub)).toBe(reopenedAt + IDLE_RETENTION_MS);
    expect(await quiet.send('pull_request', closeAt(quiet, reopenedAt - DAY, true))).toMatchObject({ accepted: true, effect: expect.stringContaining('queued') });

    // A close that stored nothing is refused after the reopen too, which records its time on a PR without state.
    const late = pullRequest();
    const lateClose = Date.now() - MINUTE;
    expect(await late.send('pull_request', closeAt(late, lateClose))).toEqual({ accepted: true, effect: 'closed, nothing queued' });
    expect(await tableNames(late.stub)).toEqual([]);
    expect((await reopen(late)).status).toBe(202);
    await late.send('pull_request', late.push(SHA_1));
    expect(await late.send('pull_request', closeAt(late, lateClose))).toEqual({ accepted: false, reason: 'close older than the open PR' });
    // A later close still counts.
    advanceClock(MINUTE);
    expect(await late.send('pull_request', closeAt(late, Date.now()))).toMatchObject({ accepted: true });
  });
});

type Reply = number | { status: number; headers?: Record<string, string>; body?: string };

/** The status, headers and body a `Reply` answers with. */
function replyParts(reply: Reply): { status: number; headers: Record<string, string>; body: string } {
  return typeof reply === 'number'
    ? { status: reply, headers: {}, body: '{"message":"no"}' }
    : { headers: {}, body: '{"message":"no"}', ...reply };
}

const SECONDARY_RATE_LIMIT: Reply = {
  status: 403,
  body: '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}',
};

interface FakeRun {
  status: string;
  conclusion?: string | null;
  run_started_at?: string;
  event?: string;
  display_title?: string;
  actor?: { login: string };
}

/** A GitHub that the dispatch path talks to, with state a test can change between alarms. */
function fakeGitHub(number: number) {
  const repo = `/repos/${OWNER}/${REPO}`;
  const state = {
    head: SHA_1,
    prState: 'open',
    draft: false,
    labels: [] as string[],
    author: 'octocat',
    headRef: 'feature',
    headRepositoryId: REPOSITORY_ID,
    baseRef: 'main',
    /** What GitHub says of the PR's mergeability on each read, the last value repeating. Null while it is not computed. */
    mergeable: [true] as Array<boolean | null>,
    mergeableState: 'clean',
    /** The comments a PATCH finds deleted. */
    deletedComments: new Set<number>(),
    /** The base branch's `.manki.yml`, or null when it has none. */
    config: null as string | null,
    configStatus: 200,
    /** The refs `.manki.yml` was read at, and the check runs created. */
    configReads: [] as string[],
    checkRuns: [] as Array<Record<string, unknown>>,
    /** Replies the next dispatches get, in order. Afterwards 200 with a new run id. */
    dispatchStatuses: [] as Reply[],
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
    /** The repository `GET /repositories/<id>` names, and its status. */
    repository: { name: REPO, owner: { login: OWNER, id: OWNER_ID }, default_branch: 'main' },
    /** Failures the next mints for a permission get, in order: a status, a status with headers, or a network error. */
    mintFailures: [] as Array<{ permission: string; reply: Reply | 'network' }>,
    graphqlVariables: [] as Array<Record<string, string>>,
    repositoryStatus: 200,
    repositoryReads: 0,
    /** The eyes reactions added, as `<issues or pulls>/<comment id>`, and the status each kind gets. */
    reactions: [] as string[],
    reactionStatus: { issues: 201, pulls: 201 } as Record<string, number>,
    /** The thumbs-up reactions added, as for `reactions`, and the comments posted on the PR. */
    thumbsUp: [] as string[],
    comments: [] as string[],
    commentStatus: 201,
    /** Each login's permission on the repository. Anyone else reads as `read`. */
    permissions: {} as Record<string, string>,
    permissionReads: [] as string[],
    /** Manki's comments by id, which a revert reads and edits, the author of any comment not Manki's, and the status of a list. */
    issueComments: new Map<number, string>(),
    commentAuthors: new Map<number, string>(),
    /** When a comment was posted, by default at the request. */
    commentCreated: new Map<number, string>(),
    commentListStatus: 200,
    /** The in-progress `Manki` checks, which the App created unless they name another app, and the edits made to checks. */
    openChecks: [] as Array<{ id: number; head_sha: string; app_id?: number }>,
    checkEdits: [] as Array<{ id: number; body: Record<string, unknown> }>,
    /** The workflow files on the default branch, and the file each dispatch named. */
    workflows: { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML } as Record<string, string>,
    dispatchedWorkflows: [] as string[],
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) {
      const body = await request.json() as (typeof state.mints)[number];
      state.mints.push(body);
      const failure = state.mintFailures.findIndex((entry) => Object.hasOwn(body.permissions, entry.permission));
      if (failure >= 0) {
        const [{ reply }] = state.mintFailures.splice(failure, 1);
        if (reply === 'network') throw new TypeError('Network connection lost');
        const { status, headers, body: text } = replyParts(reply);
        return new Response(text, { status, headers });
      }
      if (state.refuseActionsWrite && body.permissions.actions === 'write') {
        return Response.json({ message: 'The permissions requested are not granted to this installation.' }, { status: 422 });
      }
      return Response.json({ token: 'ghs_repo', expires_at: '2030-01-01T01:00:00Z', permissions: body.permissions }, { status: 201 });
    }
    if (route === `GET ${repo}/installation`) {
      return Response.json({ id: INSTALLATION_ID, permissions: { actions: 'write', contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' } });
    }
    if (route === `GET /repositories/${REPOSITORY_ID}`) {
      state.repositoryReads++;
      return Response.json(state.repository, { status: state.repositoryStatus });
    }
    if (route === 'POST /graphql') {
      state.graphqlCalls++;
      state.graphqlVariables.push(((await request.json()) as { variables: Record<string, string> }).variables);
      return Response.json(workflowsReply(state.workflows).body);
    }
    if (route === `GET ${repo}/pulls/${number}`) {
      return Response.json({
        state: state.prState,
        draft: state.draft,
        labels: state.labels.map((name) => ({ name })),
        user: { login: state.author },
        head: { sha: state.head, ref: state.headRef, repo: { id: state.headRepositoryId } },
        base: { ref: state.baseRef },
        html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
        mergeable: state.mergeable.length > 1 ? state.mergeable.shift() : state.mergeable[0],
        mergeable_state: state.mergeableState,
      });
    }
    if (route === `GET ${repo}/contents/.manki.yml`) {
      state.configReads.push(url.searchParams.get('ref') ?? '');
      if (state.configStatus !== 200) return Response.json({ message: 'no' }, { status: state.configStatus });
      if (state.config === null) return Response.json({ message: 'Not Found' }, { status: 404 });
      const content = btoa(String.fromCharCode(...new TextEncoder().encode(state.config)));
      return Response.json({ type: 'file', encoding: 'base64', size: state.config.length, content });
    }
    if (route === `POST ${repo}/check-runs`) {
      state.checkRuns.push(await request.json() as Record<string, unknown>);
      return Response.json({ id: 1 }, { status: 201 });
    }
    const dispatched = route.match(new RegExp(`^POST ${repo}/actions/workflows/([^/]+)/dispatches$`));
    if (dispatched) {
      state.dispatchedWorkflows.push(dispatched[1]);
      if (!Object.hasOwn(state.workflows, dispatched[1])) return Response.json({ message: 'Not Found' }, { status: 404 });
      state.dispatches.push(await request.json() as (typeof state.dispatches)[number]);
      const next = state.dispatchStatuses.shift() ?? 200;
      const { status, headers, body: text } = replyParts(next);
      if (status === 204) return new Response(null, { status });
      if (status !== 200) return new Response(text, { status, headers });
      const id = state.nextRunId++;
      const { inputs } = state.dispatches.at(-1)!;
      const display_title = `Manki ${inputs.event}.${inputs.action} on #${inputs.pr} (${inputs.delivery_id})`;
      state.runs.set(id, { status: 'queued', event: 'workflow_dispatch', display_title, actor: { login: 'manki-review[bot]' } });
      return Response.json({ workflow_run_id: id, run_url: `https://api.github.com${repo}/actions/runs/${id}`, html_url: 'https://github.com' });
    }
    if (route === `GET ${repo}/actions/workflows/manki-dispatch.yml/runs`) {
      if (state.listRunsStatus !== 200) return Response.json({ message: 'no' }, { status: state.listRunsStatus });
      return Response.json({ total_count: state.listedRuns.length, workflow_runs: state.listedRuns });
    }
    const issueComment = url.pathname.match(new RegExp(`^${repo}/issues/comments/(\\d+)$`));
    if (issueComment && request.method === 'GET') {
      const id = Number(issueComment[1]);
      const created_at = state.commentCreated.get(id) ?? new Date().toISOString();
      return Response.json({ body: state.issueComments.get(id), created_at, user: { login: state.commentAuthors.get(id) ?? 'manki-review[bot]' } });
    }
    if (issueComment && request.method === 'PATCH' && state.deletedComments.has(Number(issueComment[1]))) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (issueComment && request.method === 'PATCH') {
      state.issueComments.set(Number(issueComment[1]), ((await request.json()) as { body: string }).body);
      return Response.json({});
    }
    if (route === `GET ${repo}/issues/${number}/comments`) {
      if (state.commentListStatus !== 200) return Response.json({ message: 'no' }, { status: state.commentListStatus });
      return Response.json([...state.issueComments].sort(([a], [b]) => a - b)
        .map(([id, body]) => ({
          id, body, created_at: state.commentCreated.get(id) ?? new Date().toISOString(), user: { login: state.commentAuthors.get(id) ?? 'manki-review[bot]' },
        })));
    }
    const checksOf = url.pathname.match(new RegExp(`^${repo}/commits/([0-9a-f]+)/check-runs$`));
    if (checksOf && request.method === 'GET' && url.searchParams.get('check_name') === 'Manki' && url.searchParams.get('status') === 'in_progress') {
      const app = url.searchParams.get('app_id');
      return Response.json({ check_runs: state.openChecks.filter((check) => check.head_sha === checksOf[1] && (app === null || String(check.app_id ?? APP_ID) === app)) });
    }
    const check = url.pathname.match(new RegExp(`^${repo}/check-runs/(\\d+)$`));
    if (check && request.method === 'PATCH') {
      state.checkEdits.push({ id: Number(check[1]), body: await request.json() as Record<string, unknown> });
      state.openChecks = state.openChecks.filter((open) => open.id !== Number(check[1]));
      return Response.json({});
    }
    const reaction = url.pathname.match(new RegExp(`^${repo}/(issues|pulls)/comments/(\\d+)/reactions$`));
    if (reaction && request.method === 'POST') {
      const { content } = await request.json() as { content: string };
      (content === 'eyes' ? state.reactions : state.thumbsUp).push(`${reaction[1]}/${reaction[2]}`);
      return Response.json({ content }, { status: state.reactionStatus[reaction[1]] });
    }
    if (route === `POST ${repo}/issues/${number}/comments`) {
      state.comments.push(((await request.json()) as { body: string }).body);
      return Response.json({ id: 5005 }, { status: state.commentStatus });
    }
    const permission = url.pathname.match(new RegExp(`^${repo}/collaborators/([^/]+)/permission$`));
    if (permission && request.method === 'GET') {
      state.permissionReads.push(permission[1]);
      return Response.json({ permission: state.permissions[permission[1]] ?? 'read' });
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
    if (route === `GET ${repo}/installation`) return Response.json({ id: INSTALLATION_ID, permissions: { metadata: 'read' } });
    if (request.url === JWKS_URL) return Response.json(OIDC_JWKS);
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
    await pr.send('pull_request_review', pr.review());
    await pr.send('issue_comment', pr.comment('@manki explain'), 'd-explain');

    await runDurableObjectAlarm(pr.stub);
    // The two lanes dispatch concurrently, so their order is not fixed.
    expect(github.dispatches).toHaveLength(2);
    expect(github.dispatches).toEqual(expect.arrayContaining([
      { ref: 'main', return_run_details: true, inputs: { event: 'pull_request', action: 'synchronize', pr: String(pr.number), head_sha: SHA_1, delivery_id: 'd-push' } },
      { ref: 'main', return_run_details: true, inputs: { event: 'issue_comment', action: 'created', pr: String(pr.number), comment_id: '1001', delivery_id: 'd-explain' } },
    ]));
    expect((await workRows(pr.stub)).map((row) => [row.kind, row.status, row.run_id !== null])).toEqual([
      ['review', 'running', true], ['review_state', 'queued', false], ['comment', 'running', true],
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
    const audit = { msg: 'token_minted', purpose: 'coordinator', repository: `${OWNER}/${REPO}`, repository_id: REPOSITORY_ID, installation_id: INSTALLATION_ID };
    expect(logged(log, 'token_minted')).toEqual(github.mints.map(({ permissions }) => ({ ...audit, permissions })));
    expect(log.mock.calls.flat().join('\n')).not.toContain('ghs_repo');
  });

  it('reacts to a queued command at once, with a token for that kind of comment alone', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    github.mints = [];

    await pr.send('issue_comment', pr.comment('@manki review'));
    await pr.send('issue_comment', pr.comment('@manki review this', 'edited'));
    await pr.send('pull_request_review_comment', reviewCommentEvent('@manki is this safe?', {}, 'created', { number: pr.number }));
    await runDurableObjectAlarm(pr.stub);

    expect(github.reactions).toEqual(['issues/1001', 'pulls/1001']);
    expect(github.mints).toEqual([
      { permissions: { issues: 'write', pull_requests: 'write' }, repository_ids: [REPOSITORY_ID] },
      { permissions: { pull_requests: 'write' }, repository_ids: [REPOSITORY_ID] },
    ]);
    expect(github.dispatches).toHaveLength(1);
    expect((await workRows(pr.stub)).map((row) => row.status)).toEqual(['running', 'queued', 'queued']);

    await runDurableObjectAlarm(pr.stub);
    expect(github.reactions).toHaveLength(2);
  });

  it('reacts to no outsider, to no reply without a mention, and to nothing without dispatch', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.outsiderComment('@manki review'));
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.reactions).toEqual([]);

    setDispatchEnabled(false);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.repositoryStatus = 404;
    advanceClock(OPT_IN_TTL_MS + 1);
    setDispatchEnabled(true);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.reactions).toEqual([]);
  });

  it.each<[string, (github: ReturnType<typeof fakeGitHub>) => void, string]>([
    ['a refused reaction', (github) => { github.reactionStatus.issues = 403; }, 'coordinator_reaction_failed'],
    ['a failed token mint', (github) => { github.mintFailures = [{ permission: 'issues', reply: 500 }]; }, 'coordinator_reaction_error'],
  ])('dispatches the command and still reacts to the others after %s', async (_case, fail, message) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    fail(github);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('pull_request_review_comment', reviewCommentEvent('@manki is this safe?', {}, 'created', { number: pr.number }));
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, message)).toMatchObject([{ comment_id: 1001 }]);
    expect(github.reactions).toContain('pulls/1001');
    expect(github.dispatches).toHaveLength(2);
  });

  it('holds the lane until the workflow_run webhook ends the run, then starts the next item', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('pull_request_review', pr.review());
    await runDurableObjectAlarm(pr.stub);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);

    const runEnd = workflowRunEvent({ id: 9000, display_title: `Manki pull_request.synchronize on #${pr.number} (d-1)`, conclusion: 'success' });
    expect((await postWebhook({ event: 'workflow_run', payload: runEnd })).status).toBe(202);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', conclusion: 'success', note: 'run completed' }, { status: 'queued' }]);
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.now());

    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request', 'pull_request_review']);
  });

  it.each([
    ['a push, then a reply in the same second', ['push', 'reply']],
    ['a reply, then a push in the same second', ['reply', 'push']],
  ])('runs a thread reply before a review for %s, and the review right after it', async (_case, order) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    for (const item of order) {
      await (item === 'push' ? pr.send('pull_request', pr.push(SHA_1)) : pr.send('pull_request_review_comment', pr.reply('Fixed')));
    }
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request_review_comment']);
    await pr.stub.runCompleted(key('d-reply'), 9000, 'success');
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request_review_comment', 'pull_request']);
  });

  it('starts a review at once when no reply is queued', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request']);
  });

  it(`lets a review go before replies once replies went ahead of it for ${REPLY_FIRST_MS / MINUTE} minutes`, async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await runDurableObjectAlarm(pr.stub);
    // The reply runs long, a push lands on the queued review, and another reply is queued meanwhile.
    advanceClock(REPLY_FIRST_MS);
    await pr.send('pull_request', pr.push(SHA_2));
    await pr.send('pull_request_review_comment', { ...pr.reply('Also fixed'), comment: { id: 1002, body: 'Also fixed', in_reply_to_id: 2, user: { login: 'alice', type: 'User' }, author_association: 'COLLABORATOR' } });
    await pr.stub.runCompleted(key('d-reply'), 9000, 'success');
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request_review_comment', 'pull_request']);
  });

  it('runs a reply first although its review waited behind a long run', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    // A push during the review, then a reply to the blocker the review posts once it ends.
    await pr.send('pull_request', pr.push(SHA_2));
    advanceClock(2 * REPLY_FIRST_MS);
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await pr.stub.runCompleted(key('d-review'), 9000, 'success');
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request', 'pull_request_review_comment']);
  });

  it('gives a token only to the run it dispatched, from its workflow on the default branch, while that run is active', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    const workflowRef = (file: string, branch = 'main') => `${OWNER}/${REPO}/.github/workflows/${file}@refs/heads/${branch}`;
    const ask = async (claims: Record<string, string> = {}) => {
      const token = await oidcToken({ claims: { repository_id: String(REPOSITORY_ID), workflow_ref: workflowRef('manki-dispatch.yml'), ...claims } });
      const response = await postToken({ token, body: { owner: OWNER, repo: REPO } });
      return response.status === 200 ? 200 : ((await response.json()) as { error: string }).error;
    };
    expect(await ask()).toBe(200);
    expect(await ask({ workflow_ref: workflowRef('ci.yml') })).toBe('Only the run Manki dispatched gets a token: run 9000 is not of manki-dispatch.yml');
    expect(await ask({ workflow_ref: workflowRef('manki-dispatch.yml', 'feature'), ref: 'refs/heads/feature' }))
      .toBe('Only the run Manki dispatched gets a token: run 9000 is not on main');
    expect(await ask({ run_id: '9999' })).toBe('Only the run Manki dispatched gets a token: run 9999 could not be read: 404');
    await pr.stub.runCompleted(key('d-end'), 9000, 'success');
    expect(await ask()).toBe('Only the run Manki dispatched gets a token: run 9000 is not active on this PR');

    // A dispatch answered without run details is matched by the delivery id in its run title, which then names the run.
    github.dispatchStatuses = [204];
    await pr.send('pull_request', pr.push(SHA_2), 'd-quiet');
    github.head = SHA_2;
    await runDurableObjectAlarm(pr.stub);
    github.runs.set(9500, { status: 'in_progress', event: 'workflow_dispatch', display_title: `Manki pull_request.synchronize on #${pr.number} (d-quiet)`, actor: { login: 'manki-review[bot]' } });
    expect(await ask({ run_id: '9500' })).toBe(200);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'running', run_id: 9500 });
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

  it('keeps the running state and the reports of the active run across a review, a pause, a failure and a cancel', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    const call = async (path: string, body: Record<string, unknown> = {}, runId = '9000') => {
      const token = await oidcToken({ claims: { repository_id: String(REPOSITORY_ID), run_id: runId } });
      const response = await postToken({ path, token, body: { owner: OWNER, repo: REPO, pr: pr.number, ...body } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const state = async () => (await call('/state')).body;
    const reviewed = { reviewed: { commit: SHA_1 }, approval: { commit: SHA_1, held: true }, pause: { reason: 'Round cap reached.' } };

    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    await pr.send('pull_request', pr.push(SHA_2));
    expect(await state()).toEqual({
      active: [{ lane: 'state', run_id: 9000, kind: 'review', event: 'pull_request.synchronize', head_sha: SHA_1, dispatched_at: new Date().toISOString(), modes: [] }],
      queue: [{ lane: 'state', kind: 'review', event: 'pull_request.synchronize', head_sha: SHA_2, enqueued_at: new Date().toISOString(), modes: [] }],
      last_reviewed: null,
      last_approval: null,
      pause: null,
      settings: { paused: false },
    });

    // Only the active run may report, and a replayed report writes nothing.
    expect(await call('/state/report', reviewed, '1234')).toEqual({ status: 403, body: { error: 'run 1234 is not active on this PR' } });
    expect(await call('/state/report', reviewed)).toEqual({ status: 200, body: { changed: ['reviewed', 'approval', 'pause'] } });
    const at = new Date().toISOString();
    advanceClock(MINUTE);
    expect(await call('/state/report', reviewed)).toEqual({ status: 200, body: { changed: [] } });
    expect(logged(log, 'state_report')).toEqual([
      expect.objectContaining({ pr: pr.number, run_id: 1234, accepted: false }),
      expect.objectContaining({ pr: pr.number, run_id: 9000, reviewed: { commit: SHA_1 }, accepted: true, changed: ['reviewed', 'approval', 'pause'] }),
      expect.objectContaining({ pr: pr.number, run_id: 9000, accepted: true, changed: [] }),
    ]);
    expect(log.mock.calls.flat().join('\n')).not.toContain('Bearer');
    const afterReview = {
      last_reviewed: { commit: SHA_1, run_id: 9000, at },
      last_approval: { commit: SHA_1, held: true, run_id: 9000, at },
      pause: { reason: 'Round cap reached.', at },
    };
    expect(await state()).toMatchObject(afterReview);

    // While paused, a push starts nothing. A question, a thread reply and a review request still run, and a failed or
    // cancelled run leaves the reported state as it was.
    expect(await pr.stub.runCompleted(key('d-1'), 9000, 'success')).toMatchObject({ accepted: true });
    expect(await call('/state/report', { pause: null })).toEqual({ status: 403, body: { error: 'run 9000 is not active on this PR' } });
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ head_sha: SHA_2, status: 'skipped', note: 'pull request is paused' });
    const request = async (event: string, payload: WebhookPayload) => {
      await pr.send(event, payload);
      await runDurableObjectAlarm(pr.stub);
    };
    await request('issue_comment', pr.comment('@manki explain the pause'));
    expect(await state()).toMatchObject({ active: [{ run_id: 9001, lane: 'chat', event: 'issue_comment.created' }], queue: [], ...afterReview });
    expect(await pr.stub.runCompleted(key('d-2'), 9001, 'failure')).toMatchObject({ accepted: true });
    await request('pull_request_review_comment', pr.reply('Fixed'));
    expect(await state()).toMatchObject({ active: [{ run_id: 9002, event: 'pull_request_review_comment.created' }] });
    expect(await pr.stub.runCompleted(key('d-3'), 9002, 'cancelled')).toMatchObject({ accepted: true });
    expect(await state()).toMatchObject({ active: [], queue: [], ...afterReview });

    // A later run lifts the pause and records its own review, and pushes start runs again.
    await request('issue_comment', pr.comment('@manki review'));
    expect(await state()).toMatchObject({ active: [{ run_id: 9003, event: 'issue_comment.created' }] });
    expect(await call('/state/report', { reviewed: { commit: SHA_2 }, pause: null }, '9003')).toEqual({ status: 200, body: { changed: ['reviewed', 'pause'] } });
    expect(await state()).toMatchObject({ last_reviewed: { commit: SHA_2, run_id: 9003 }, pause: null, last_approval: afterReview.last_approval });
    expect(await pr.stub.runCompleted(key('d-4'), 9003, 'success')).toMatchObject({ accepted: true });
    github.head = SHA_3;
    await pr.send('pull_request', pr.push(SHA_3));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.at(-1)?.inputs).toMatchObject({ event: 'pull_request', head_sha: SHA_3 });
  });

  it('keeps a closed PR while its run is still running, then deletes it a week after the close', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await pr.send('pull_request', pr.close(false))).toEqual({ accepted: true, effect: 'closed, nothing queued' });
    github.cancelStatuses = [500, 500];
    advanceClock(DELIVERY_RETENTION_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_deleted')).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', run_id: 9000 }]);
    // The past retention date does not wake the alarm at once. The next poll does.
    expect(await runInDurableObject(pr.stub, (_instance, state) => state.storage.getAlarm())).toBeGreaterThan(Date.now());

    // The run's end arrives after the close and does not count the PR as open again.
    expect(await pr.stub.runCompleted(key('d-end'), 9000, 'success')).toMatchObject({ accepted: true });
    await runDurableObjectAlarm(pr.stub);
    expect(await tableNames(pr.stub)).toEqual([]);
  });

  it('returns an empty state for a PR it never saw, without creating storage', async () => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    const token = await oidcToken({ claims: { repository_id: String(REPOSITORY_ID), run_id: '9000' } });
    const response = await postToken({ path: '/state', token, body: { owner: OWNER, repo: REPO, pr: pr.number } });
    expect(await response.json()).toEqual({ active: [], queue: [], last_reviewed: null, last_approval: null, pause: null, settings: { paused: false } });
    const report = await postToken({ path: '/state/report', token, body: { owner: OWNER, repo: REPO, pr: pr.number, pause: null } });
    expect(report.status).toBe(403);
    expect(await tableNames(pr.stub)).toEqual([]);
  });

  it.each([
    ['a missing PR', {}, undefined, 400, 'pr must be a positive integer'],
    ['a PR given as a string', { pr: '7' }, undefined, 400, 'pr must be a positive integer'],
    ['a short commit', { pr: 7, reviewed: { commit: 'abc1234' } }, undefined, 400, 'reviewed must be { commit } with a full commit SHA'],
    ['an approval without held', { pr: 7, approval: { commit: SHA_1 } }, undefined, 400, 'approval must be { commit, held } with a full commit SHA'],
    ['an empty pause reason', { pr: 7, pause: { reason: '' } }, undefined, 400, 'pause must be null or { reason } with a reason of 1 to 1024 characters'],
    ['a pause reason over 1024 characters', { pr: 7, pause: { reason: 'x'.repeat(1025) } }, undefined, 400, 'pause must be null or { reason } with a reason of 1 to 1024 characters'],
    ['a token without a run_id claim', { pr: 7 }, null, 403, 'OIDC verification failed'],
  ])('refuses a report with %s', async (_case, body, runId, status, error) => {
    fakeGitHub(7);
    const token = await oidcToken({ claims: { repository_id: String(REPOSITORY_ID), run_id: runId === null ? undefined : '9000' } });
    const response = await postToken({ path: '/state/report', token, body: { owner: OWNER, repo: REPO, ...body } });
    expect({ status: response.status, error: ((await response.json()) as { error: string }).error }).toEqual({ status, error });
  });

  it('refuses a state request without a valid OIDC token for the repository', async () => {
    fakeGitHub(7);
    expect((await postToken({ path: '/state', token: null, body: { owner: OWNER, repo: REPO, pr: 7 } })).status).toBe(401);
    const other = await oidcToken({ claims: { repository: `${OWNER}/other` } });
    expect((await postToken({ path: '/state', token: other, body: { owner: OWNER, repo: REPO, pr: 7 } })).status).toBe(403);
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

  it('does not review a head again for a late redelivery of its push', async () => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    await pr.stub.catchUp(
      { installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, owner: OWNER, ownerId: OWNER_ID, repo: REPO, defaultBranch: 'main', number: pr.number },
      SHA_1,
    );
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', head_sha: SHA_1 }]);
    expect(await pr.send('pull_request', pr.push(SHA_1))).toEqual({ accepted: true, effect: 'head already reviewed or under review' });

    await pr.stub.runCompleted(key('d-end'), 9000, 'success');
    expect(await pr.stub.catchUpState(SHA_1)).toBe('handled');
    expect(await pr.send('pull_request', pr.push(SHA_1))).toEqual({ accepted: true, effect: 'head already reviewed or under review' });
    expect(await pr.send('pull_request', pr.push(SHA_2))).toEqual({ accepted: true, effect: 'queued work 2' });
  });

  it.each([
    ['failed', 'failure'],
    ['was cancelled', 'cancelled'],
  ])('reviews a head again when its run %s', async (_case, conclusion) => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    await pr.stub.runCompleted(key('d-end'), 9000, conclusion);
    expect(await pr.stub.catchUpState(SHA_1)).toBe('needed');
    expect(await pr.send('pull_request', pr.push(SHA_1))).toEqual({ accepted: true, effect: 'queued work 2' });
  });

  it('reviews a head again when its run was deleted', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    github.runs.delete(9000);
    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', note: 'run deleted' }]);
    expect(await pr.stub.catchUpState(SHA_1)).toBe('needed');
  });

  it('queues a review of a new head pushed while a review runs', async () => {
    const pr = pullRequest();
    fakeGitHub(pr.number);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await pr.send('pull_request', pr.push(SHA_2))).toEqual({ accepted: true, effect: 'queued work 2' });
  });

  it('dispatches one review for two review commands in a row, and queues a command made while it runs', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki review'));
    await pr.send('issue_comment', { ...pr.comment('@manki review'), comment: { id: 1002, body: '@manki review', user: { login: 'bob', type: 'User' }, author_association: 'MEMBER' } }, 'd-second');
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs)).toMatchObject([{ event: 'issue_comment', comment_id: '1002', delivery_id: 'd-second' }]);

    // The head can move before the next run starts, so a command during the run gets its own.
    expect(await pr.send('issue_comment', { ...pr.comment('@manki review'), comment: { id: 1003, body: '@manki review', user: { login: 'bob', type: 'User' }, author_association: 'MEMBER' } }))
      .toEqual({ accepted: true, effect: 'queued work 2' });
    expect((await workRows(pr.stub)).map((row) => [row.object_id, row.status])).toEqual([[1002, 'running'], [1003, 'queued']]);
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
    ['a draft', { draft: true }, 'pull request is a draft'],
    ['a draft whose base config skips drafts', { draft: true, config: 'drafts: skip' }, 'pull request is a draft'],
    ['a draft whose base config sets an unknown drafts value', { draft: true, config: 'drafts: always' }, 'pull request is a draft'],
  ])('drops a review when the PR is %s', async (_case, change, note) => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), change);
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dropped', note }]);
  });

  it('reviews a draft automatically when the base config sets `drafts: review`, and still answers comments on a draft', async () => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), { draft: true, baseRef: 'develop' });
    await pr.send('pull_request', pr.push(SHA_1, 'opened'));
    await pr.send('pull_request_review_comment', pr.reply('Fixed'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.event)).toEqual(['pull_request_review_comment']);
    await pr.stub.runCompleted(key('d-reply'), 9000, 'success');
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect((await workRows(pr.stub))[0]).toMatchObject({ status: 'dropped', note: 'pull request is a draft' });

    github.config = 'drafts: review';
    await pr.send('pull_request', pr.push(SHA_2));
    github.head = SHA_2;
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches.at(-1)?.inputs).toMatchObject({ event: 'pull_request', head_sha: SHA_2 });
    expect(github.configReads).toEqual(['develop', 'develop']);
    await pr.stub.runCompleted(key('d-draft'), 9001, 'success');

    // A retry after a dispatch attempt keeps the first attempt's decision, since that attempt's run may have started.
    github.dispatchStatuses = [502];
    await pr.send('pull_request', pr.push(SHA_3));
    github.head = SHA_3;
    await runDurableObjectAlarm(pr.stub);
    github.config = null;
    advanceClock(DISPATCH_BACKOFF_MS[0]);
    await runDurableObjectAlarm(pr.stub);
    expect(github.configReads).toHaveLength(3);
    expect(github.dispatches.at(-1)?.inputs).toMatchObject({ event: 'pull_request', head_sha: SHA_3 });
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'running' });
  });

  it('skips a review of a PR that conflicts with its base, with one note it replaces and a rebase check', async () => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), { mergeable: [false] as Array<boolean | null>, mergeableState: 'dirty', baseRef: 'develop' });
    const note = 'This PR conflicts with `develop`. Rebase it, and Manki reviews it then.';
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(github.comments).toEqual([`${note}\n\n${CONFLICT_NOTE_MARKER}`]);
    expect(github.checkRuns).toEqual([{
      name: 'Manki', head_sha: SHA_1, status: 'completed', conclusion: 'action_required',
      details_url: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}`, output: { title: 'Rebase needed', summary: note },
    }]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', conclusion: 'conflict', note: 'conflicts with develop' }]);
    expect(logged(log, 'coordinator_finished')).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'skipped', conclusion: 'conflict' })]));
    // The cron leaves the skipped head alone, so it posts the note again only on a new push or a review request.
    expect(await pr.stub.catchUpState(SHA_1)).toBe('handled');

    // A review request on the still conflicting PR replaces the note instead of adding one.
    github.mergeable = [null, false];
    github.mergeableState = 'unknown';
    await pr.send('issue_comment', pr.comment('@manki review'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(5_000);
    github.mergeableState = 'dirty';
    await runDurableObjectAlarm(pr.stub);
    expect(github.comments).toHaveLength(1);
    expect(github.issueComments.get(5005)).toBe(`${note}\n\n${CONFLICT_NOTE_MARKER}`);
    expect(github.dispatches).toEqual([]);

    // Once Manki deleted the note after a review, the next skip posts it again.
    github.deletedComments.add(5005);
    await pr.send('pull_request', pr.push(SHA_2));
    github.head = SHA_2;
    github.mergeable = [false];
    await runDurableObjectAlarm(pr.stub);
    expect(github.comments).toHaveLength(2);
    expect(github.checkRuns.map((check) => check.head_sha)).toEqual([SHA_1, SHA_1, SHA_2]);
  });

  it('still skips a conflicting PR when posting the note failed once, since no dispatch was tried', async () => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), { mergeable: [false] as Array<boolean | null>, mergeableState: 'dirty', commentStatus: 502 });
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', attempts: 0, errors: 1 }]);
    github.commentStatus = 201;
    advanceClock(backoff(0));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', conclusion: 'conflict' }]);
    expect(github.mints).toContainEqual({ permissions: { issues: 'write' }, repository_ids: [REPOSITORY_ID] });
  });

  it('reviews a PR GitHub has not computed mergeability for after reading it twice more, and a clean one at once', async () => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), { mergeable: [null], mergeableState: 'unknown' });
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'queued', merge_checks: 1 }]);
    advanceClock(5_000);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'queued', merge_checks: 2 }]);
    advanceClock(15_000);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(logged(log, 'coordinator_mergeability_pending')).toHaveLength(2);
    expect(github.comments).toEqual([]);

    const clean = pullRequest();
    const cleanGitHub = fakeGitHub(clean.number);
    await clean.send('pull_request', clean.push(SHA_1));
    await runDurableObjectAlarm(clean.stub);
    expect(cleanGitHub.dispatches).toHaveLength(1);
    expect(cleanGitHub.checkRuns).toEqual([]);
  });

  it.each([
    ['a label, in any case', { config: 'skip_labels: [dependencies]', labels: ['Dependencies'] }, 'label "Dependencies"'],
    ['an author who also pushed', { config: 'skip_authors: [renovate-bot]', author: 'Renovate-Bot', sender: 'renovate-bot' }, 'author Renovate-Bot'],
    ['a branch glob', { config: 'skip_branches: ["release/**"]', headRef: 'release/1.2/fix' }, 'branch release/1.2/fix'],
  ])('skips a push review matching %s on the base branch with a skipped check and no run', async (_case, change, rule) => {
    const pr = pullRequest();
    const { sender, ...pull } = { sender: 'octocat', ...change };
    const github = Object.assign(fakeGitHub(pr.number), pull, { baseRef: 'develop' });
    const push = pr.push(SHA_1);
    await pr.send('pull_request', { ...push, sender: { ...push.sender, login: sender } });
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(github.configReads).toEqual(['develop']);
    expect(github.checkRuns).toEqual([{
      name: 'Manki', head_sha: SHA_1, status: 'completed', conclusion: 'skipped',
      output: { title: 'Review skipped', summary: `This PR matches the skip rule for ${rule} in \`.manki.yml\` on the base branch.` },
    }]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', conclusion: 'skipped', note: `matches the skip rule for ${rule}` }]);
    // The cron and a late redelivery of the push leave a skipped head alone.
    expect(await pr.stub.catchUpState(SHA_1)).toBe('handled');
    expect(await pr.send('pull_request', pr.push(SHA_1))).toEqual({ accepted: true, effect: 'head already reviewed or under review' });
  });

  it.each([
    ['a listed author when someone else pushed', { config: 'skip_authors: [renovate-bot]', author: 'renovate-bot' }],
    ['a listed author whose push is no longer the head', { config: 'skip_authors: [renovate-bot]', author: 'renovate-bot', sender: 'renovate-bot', head: SHA_2 }],
    ['a label on a fork head', { config: 'skip_labels: [dependencies]', labels: ['dependencies'], headRepositoryId: 1 }],
    ['a branch on a fork head', { config: 'skip_branches: ["release/*"]', headRef: 'release/1', headRepositoryId: 1 }],
    ['rules that are not lists of non-empty strings', { config: 'skip_labels: dependencies\nskip_branches: ["feature"]' }],
    ['a config that does not parse', { config: 'skip_branches: [feature' }],
    ['no config', {}],
  ])('reviews a push matching %s', async (_case, change) => {
    const pr = pullRequest();
    const { sender, ...pull } = { sender: 'alice', ...change };
    const github = Object.assign(fakeGitHub(pr.number), pull);
    const push = pr.push(SHA_1);
    await pr.send('pull_request', { ...push, sender: { ...push.sender, login: sender } });
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(github.checkRuns).toEqual([]);
  });

  it('keeps judging a retried skip by the queued push, and applies skip rules only before the first dispatch attempt', async () => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), { config: 'skip_authors: [renovate-bot]\nskip_labels: [dependencies]', author: 'renovate-bot' });
    const push = pr.push(SHA_1);
    await pr.send('pull_request', { ...push, sender: { ...push.sender, login: 'renovate-bot' } });
    // The config read fails while a writer's push moves the head on, so the retry no longer credits the bot with it.
    github.configStatus = 502;
    github.head = SHA_2;
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', head_sha: SHA_1, errors: 1 }]);
    // The next try stores the newer head and fails to mint its dispatch token, so a retry must not see the bot's push.
    github.configStatus = 200;
    github.mintFailures = [{ permission: 'actions', reply: 502 }];
    advanceClock(backoff(0));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', head_sha: SHA_2, sender: '', attempts: 0 }]);
    github.dispatchStatuses = [502];
    advanceClock(backoff(1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.checkRuns).toEqual([]);
    // A label added after a dispatch attempt skips nothing, since that attempt's run may have started.
    github.labels = ['dependencies'];
    advanceClock(DISPATCH_BACKOFF_MS[0]);
    await runDurableObjectAlarm(pr.stub);
    expect(github.configReads).toHaveLength(3);
    expect(github.checkRuns).toEqual([]);
    expect(github.dispatches).toHaveLength(2);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', head_sha: SHA_2 }]);
  });

  it('applies no skip rule to a review request, which only a push review reads', async () => {
    const pr = pullRequest();
    const github = Object.assign(fakeGitHub(pr.number), { config: 'skip_labels: [dependencies]', labels: ['dependencies'] });
    await pr.send('issue_comment', pr.comment('@manki review'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(github.configReads).toEqual([]);
  });

  it('answers a help command at once with Manki\'s command table and a thumbs-up, with no run, while a run holds the chat lane', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    await pr.send('issue_comment', pr.comment('@manki help'));
    await pr.send('pull_request_review_comment', pr.reply('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(github.comments).toEqual([`${HELP_REPLY}\n<!-- manki-answered:1001 -->`, HELP_REPLY]);
    expect(github.thumbsUp).toEqual(['issues/1001', 'pulls/1001']);
    // The eyes reaction on the explain minted the token the replies reuse, which holds nothing else.
    expect(github.mints.filter((mint) => mint.permissions.issues)).toEqual([{ permissions: { issues: 'write', pull_requests: 'write' }, repository_ids: [REPOSITORY_ID] }]);
    expect((await workRows(pr.stub)).map((row) => [row.lane, row.status, row.note])).toEqual([
      ['chat', 'running', 'dispatched'], ['help', 'done', 'answered help'], ['help', 'done', 'answered help'],
    ]);
  });

  it('retries a help reply that failed to post', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.commentStatus = 502;
    await pr.send('issue_comment', pr.comment('@manki help'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', errors: 1 }]);
    github.commentStatus = 201;
    advanceClock(backoff(0));
    await runDurableObjectAlarm(pr.stub);
    expect(github.comments).toHaveLength(2);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', note: 'answered help' }]);
  });

  it('looks up a commenter the payload does not show as a writer, and skips their comment without write access', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.permissions = { bob: 'write', mallory: 'triage' };
    const by = (login: string, association: string, body: string, action = 'created', author = login) => ({
      ...issueCommentEvent(body, { number: pr.number, action, association, sender: { login, type: 'User' }, author: { login: author, type: 'User' } }),
    });
    const run = async (event: string, payload: WebhookPayload) => {
      await pr.send(event, payload);
      await runDurableObjectAlarm(pr.stub);
    };
    await run('issue_comment', by('alice', 'NONE', '@manki explain'));
    await run('issue_comment', by('alice', 'NONE', '@manki help'));
    await run('pull_request_review_comment', reviewCommentEvent('Fixed', { in_reply_to_id: 1, author_association: 'NONE' }, 'created', { number: pr.number }));
    await run('issue_comment', by('mallory', 'COLLABORATOR', '@manki explain more', 'edited', 'carol'));
    await run('pull_request_review', reviewEvent('submitted', { author_association: 'NONE' }, { number: pr.number }));
    // Ticking the issue box in Manki's finding is an edit by someone else, so the editor is looked up too.
    const finding = '- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:3:3:Off-by-one -->';
    await run('pull_request_review_comment', {
      ...reviewCommentEvent(finding.replace('[ ]', '[x]'), { user: MANKI_AUTHOR }, 'edited', { number: pr.number }),
      sender: { login: 'mallory', type: 'User' },
      changes: { body: { from: finding } },
    });
    expect(github.dispatches).toEqual([]);
    expect(github.comments).toEqual([]);
    expect((await workRows(pr.stub)).map((row) => [row.kind, row.status, row.note])).toEqual([
      ['comment', 'skipped', 'commenter has no write access'],
      ['help', 'skipped', 'commenter has no write access'],
      ['thread', 'skipped', 'commenter has no write access'],
      ['comment', 'skipped', 'commenter has no write access'],
      ['review_state', 'skipped', 'commenter has no write access'],
      ['thread', 'skipped', 'commenter has no write access'],
    ]);

    // An org member GitHub shows as a contributor has write access by the lookup. A collaborator needs no lookup.
    await run('issue_comment', by('bob', 'CONTRIBUTOR', '@manki explain'));
    await pr.stub.runCompleted(key('d-bob'), 9000, 'success');
    await run('issue_comment', by('dave', 'COLLABORATOR', '@manki explain again'));
    expect(github.dispatches).toHaveLength(2);
    // A writer's tick of the issue box is dispatched as the edit of Manki's comment.
    await run('pull_request_review_comment', {
      ...reviewCommentEvent(finding.replace('[ ]', '[x]'), { user: MANKI_AUTHOR }, 'edited', { number: pr.number }),
      sender: { login: 'bob', type: 'User' },
      changes: { body: { from: finding } },
    });
    expect(github.dispatches.map((dispatch) => [dispatch.inputs.event, dispatch.inputs.action])).toEqual([
      ['issue_comment', 'created'], ['issue_comment', 'created'], ['pull_request_review_comment', 'edited'],
    ]);
    // Each login is looked up once and reused for a few minutes.
    expect(github.permissionReads).toEqual(['alice', 'mallory', 'bob']);
    expect(github.mints).toContainEqual({ permissions: { metadata: 'read' }, repository_ids: [REPOSITORY_ID] });
  });

  describe('settings boxes', () => {
    const SETTINGS = 1500;
    const boxes = (ticked: string[] = []) => ['Last reviewed `1111111` · head `1111111` · up to date', '',
      ...(['pause', 'again', 'deeper', 'cancel', 'draft'] as const).map((box) => `- [${ticked.includes(box) ? 'x' : ' '}] ${box} <!-- manki-box:${box} -->`),
      '<!-- manki-settings -->', '<!-- manki-bot -->'].join('\n');
    /** A running review's progress comment as Manki writes it, with a hidden marker another writer appended. */
    const LABELS = { pause: 'Pause automatic reviews', deeper: 'Deeper review', cancel: 'Cancel this review', draft: 'Review this draft' };
    const boxLines = (ticked: string[], shown = Object.keys(LABELS) as Array<keyof typeof LABELS>) =>
      shown.map((box) => `- [${ticked.includes(box) ? 'x' : ' '}] ${LABELS[box]} <!-- manki-box:${box} -->`);
    const progress = (ticked: string[] = [], status = 'review running') => ['**Review in progress**', '', '**Planner**', '<!-- manki-bot -->', '', '---',
      `Last reviewed \`1111111\` · head \`1111111\` · ${status}`, ...boxLines(ticked), '<!-- manki-settings -->', '<!-- manki-answered:7 -->'].join('\n');
    /** `progress` once `login` cancelled the review: the progress folded away and the block kept without its Cancel box. */
    const cancelled = (login: string) => [`**Review cancelled by @${login}.**`, '', '<details><summary>Original progress</summary>', '',
      '**Review in progress**', '', '**Planner**', '<!-- manki-bot -->', '', '</details>', '', '<!-- manki-review-cancelled -->', '', '---',
      'Last reviewed `1111111` · head `1111111` · review cancelled', ...boxLines([], ['pause', 'deeper', 'draft']),
      '<!-- manki-settings -->', '<!-- manki-answered:7 -->'].join('\n');
    const cancelledCheck = (id: number, login: string) => ({
      id, body: { status: 'completed', conclusion: 'cancelled', output: { title: 'Review cancelled', summary: `Review cancelled by @${login}.` } },
    });
    const setup = () => {
      const pr = pullRequest();
      const github = fakeGitHub(pr.number);
      github.permissions = { alice: 'write' };
      const state = async () => {
        const token = await oidcToken({ claims: { repository_id: String(REPOSITORY_ID), run_id: '9000' } });
        return (await postToken({ path: '/state', token, body: { owner: OWNER, repo: REPO, pr: pr.number } })).json() as Promise<Record<string, unknown>>;
      };
      /** Has `sender` change the boxes from `before` to `after`, and runs the alarm twice, so a review it queues starts. */
      const edit = async (before: string[], after: string[], sender = 'alice', at = new Date().toISOString(), render = boxes) => {
        const payload = issueCommentEvent(render(after), {
          number: pr.number, action: 'edited', author: MANKI_AUTHOR, sender: { login: sender, type: 'User' }, previousBody: render(before),
        });
        github.issueComments.set(SETTINGS, render(after));
        const result = await pr.send('issue_comment', { ...payload, comment: { ...payload.comment!, id: SETTINGS, updated_at: at } });
        await runDurableObjectAlarm(pr.stub);
        await runDurableObjectAlarm(pr.stub);
        return result;
      };
      return { pr, github, state, edit };
    };

    it('pauses automatic reviews until a writer unticks Pause, and keeps reviewing on request meanwhile', async () => {
      const { pr, github, state, edit } = setup();
      await edit([], ['pause']);
      expect(await state()).toMatchObject({ settings: { paused: true } });
      await pr.send('pull_request', pr.push(SHA_1));
      await runDurableObjectAlarm(pr.stub);
      expect(github.dispatches).toEqual([]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'skipped', note: 'pull request is paused' });
      await edit(['pause'], ['pause', 'again']);
      expect(github.dispatches.at(-1)?.inputs).toMatchObject({ event: 'issue_comment', action: 'edited', comment_id: String(SETTINGS) });
      expect(await state()).toMatchObject({ active: [{ kind: 'review', run_id: 9000, modes: ['again'] }], settings: { paused: true } });
      await pr.stub.runCompleted(key('d-again'), 9000, 'success');

      await edit(['pause'], []);
      expect(await state()).toMatchObject({ settings: { paused: false } });
      github.head = SHA_2;
      await pr.send('pull_request', pr.push(SHA_2));
      await runDurableObjectAlarm(pr.stub);
      expect(github.dispatches.at(-1)?.inputs).toMatchObject({ event: 'pull_request', head_sha: SHA_2 });
      expect((await workRows(pr.stub)).filter((row) => row.kind === 'settings').map((row) => row.note)).toEqual(['paused', 'again review work 4', 'resumed']);
    });

    it('turns a queued push review into one review with every mode ticked, which a pause cannot drop', async () => {
      const { pr, github, state } = setup();
      await pr.send('pull_request', pr.push(SHA_1));
      const tick = async (before: string[], after: string[]) => {
        const payload = issueCommentEvent(boxes(after), {
          number: pr.number, action: 'edited', author: MANKI_AUTHOR, previousBody: boxes(before),
        });
        await pr.send('issue_comment', { ...payload, comment: { ...payload.comment!, id: SETTINGS } });
      };
      await tick([], ['again']);
      await tick(['again'], ['again', 'deeper']);
      await tick(['again', 'deeper'], ['again', 'deeper', 'pause']);
      // The settings lane takes one edit per alarm while the state lane waits for the box review.
      await runInDurableObject(pr.stub, async (_instance, ctx) => {
        ctx.storage.sql.exec(`UPDATE work SET check_at = ? WHERE kind = 'review'`, Date.now() + MINUTE);
      });
      for (let i = 0; i < 3; i++) await runDurableObjectAlarm(pr.stub);
      expect(await state()).toMatchObject({
        queue: [{ kind: 'review', event: 'issue_comment.edited', head_sha: SHA_1, modes: ['again', 'deeper'] }],
        settings: { paused: true },
      });
      advanceClock(MINUTE);
      await runDurableObjectAlarm(pr.stub);
      expect(github.dispatches).toHaveLength(1);
      expect(github.dispatches[0].inputs).toMatchObject({ event: 'issue_comment', action: 'edited', comment_id: String(SETTINGS) });
      expect(await state()).toMatchObject({ active: [{ kind: 'review', run_id: 9000, modes: ['again', 'deeper'] }] });
    });

    it('reviews a draft once on a Review this draft tick, while its pushes start nothing', async () => {
      const { pr, github, state, edit } = setup();
      github.draft = true;
      await pr.send('pull_request', pr.push(SHA_1));
      await runDurableObjectAlarm(pr.stub);
      expect(github.dispatches).toEqual([]);
      await edit([], ['draft']);
      expect(github.dispatches).toHaveLength(1);
      expect(await state()).toMatchObject({ active: [{ kind: 'review', event: 'issue_comment.edited', modes: ['draft'] }] });
    });

    it('cancels the running review on a Cancel tick, which the cron then leaves alone', async () => {
      const { pr, github, state, edit } = setup();
      await pr.send('pull_request', pr.push(SHA_1));
      await runDurableObjectAlarm(pr.stub);
      // Only the App's own check on the review's head is Manki's. Another app's check of the same name stays.
      github.openChecks = [{ id: 69, head_sha: SHA_1, app_id: 15368 }, { id: 70, head_sha: SHA_1 }, { id: 71, head_sha: SHA_2 }];
      await edit([], ['cancel'], 'alice', new Date().toISOString(), progress);
      expect(github.cancels).toEqual([9000]);
      expect((await workRows(pr.stub))[0]).toMatchObject({ status: 'skipped', conclusion: 'cancelled', note: 'cancelled by alice, cancel requested' });
      expect(await pr.stub.catchUpState(SHA_1)).toBe('handled');
      expect(await state()).toMatchObject({ active: [] });
      // The run's post step cannot end its progress comment and check any more, so the Worker does.
      expect(github.issueComments.get(SETTINGS)).toBe(cancelled('alice'));
      expect(github.checkEdits).toEqual([cancelledCheck(70, 'alice')]);
      // A cancel GitHub fails is tried again, so the tick is not lost. A review with no queued head finds its check on the PR's head.
      await pr.send('issue_comment', pr.comment('@manki review'));
      await runDurableObjectAlarm(pr.stub);
      github.openChecks = [{ id: 72, head_sha: SHA_1 }];
      github.cancelStatuses = [500];
      await edit([], ['cancel'], 'alice', new Date().toISOString(), progress);
      expect(github.cancels).toEqual([9000, 9001]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'dispatching', errors: 1 });
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['cancel']));
      advanceClock(backoff(0));
      await runDurableObjectAlarm(pr.stub);
      expect(github.cancels).toEqual([9000, 9001, 9001]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'done', note: 'cancel of work 3 requested' });
      expect(github.issueComments.get(SETTINGS)).toBe(cancelled('alice'));
      expect(github.checkEdits.slice(1)).toEqual([cancelledCheck(72, 'alice')]);

      // A Cancel made before the running review started leaves it alone.
      await pr.send('issue_comment', pr.comment('@manki review again'));
      await runDurableObjectAlarm(pr.stub);
      await edit([], ['cancel'], 'alice', new Date(Date.now() - MINUTE).toISOString());
      expect(github.cancels).toEqual([9000, 9001, 9001]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'done', note: 'no review to cancel' });
      await pr.stub.runCompleted(key('d-again'), 9002, 'success');

      // With nothing running, a Cancel tick changes nothing.
      await edit([], ['cancel']);
      expect(github.cancels).toEqual([9000, 9001, 9001]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'done', note: 'no review to cancel' });
    });

    it('replaces a running review on Deeper review, and on Review again only once the head moved', async () => {
      const { pr, github, state, edit } = setup();
      /** A running review's progress comment with the review boxes, and the status line `status`. */
      const running = (status: string) => (ticked: string[] = []) => ['**Review in progress**', '<!-- manki-bot -->', '', '---',
        `Last reviewed \`1111111\` · head \`1111111\` · ${status}`,
        ...(['pause', 'again', 'deeper', 'cancel'] as const).map((box) => `- [${ticked.includes(box) ? 'x' : ' '}] ${box} <!-- manki-box:${box} -->`),
        '<!-- manki-settings -->'].join('\n');
      /**
       * `running` once the review was replaced, as `headline` says: the progress folded away, the block kept without Cancel.
       * The status says the box's review is starting once its run is dispatched.
       */
      const replaced = (headline: string, ticked: string) => [`**${headline}**`, '', '<details><summary>Original progress</summary>', '',
        '**Review in progress**', '<!-- manki-bot -->', '', '</details>', '', '<!-- manki-review-cancelled -->', '', '---',
        `Last reviewed \`1111111\` · head \`1111111\` · ${ticked} requested by @alice, starting…`,
        ...(['pause', 'again', 'deeper'] as const).map((box) => `- [${box === ticked ? 'x' : ' '}] ${box} <!-- manki-box:${box} -->`),
        '<!-- manki-settings -->'].join('\n');
      const reviewing = running('review running');
      await pr.send('pull_request', pr.push(SHA_1));
      await runDurableObjectAlarm(pr.stub);

      // On the head it is already reviewing, Review again leaves the review running and says so.
      await edit([], ['again'], 'alice', new Date().toISOString(), reviewing);
      expect(github.cancels).toEqual([]);
      expect(github.issueComments.get(SETTINGS)).toBe(running('already reviewing `1111111`')());
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'done', note: 'already reviewing 1111111' });
      expect(await state()).toMatchObject({ active: [{ kind: 'review', run_id: 9000 }], queue: [] });
      // A box ticked on an ended review's comment is unticked there too, next to the running review's comment.
      const ended = (status: string) => (ticked: string[] = []) => running(status)(ticked).replace('**Review in progress**', '**Review complete**\n<!-- manki-review-complete -->');
      github.issueComments.set(1400, reviewing());
      await edit([], ['again'], 'alice', new Date().toISOString(), ended('up to date'));
      expect(github.issueComments.get(SETTINGS)).toBe(ended('already reviewing `1111111`')());
      expect(github.issueComments.get(1400)).toBe(running('already reviewing `1111111`')());
      github.issueComments.delete(1400);

      // Once the head moved, Review again replaces the review with one of the new head.
      github.head = SHA_2;
      github.openChecks = [{ id: 70, head_sha: SHA_1 }];
      await edit([], ['again'], 'alice', new Date().toISOString(), reviewing);
      expect(github.cancels).toEqual([9000]);
      const newCommits = 'Review replaced by a review of the new commits requested by @alice.';
      expect(github.issueComments.get(SETTINGS)).toBe(replaced(newCommits, 'again'));
      expect(github.checkEdits).toEqual([{ id: 70, body: { status: 'completed', conclusion: 'cancelled', output: { title: 'Review cancelled', summary: newCommits } } }]);
      expect(await state()).toMatchObject({ active: [{ kind: 'review', run_id: 9001, modes: ['again'] }] });

      // Deeper review replaces the running review right away, on any head. The replaced review came from a box, and its
      // check on the head it reviews is completed even after the PR moved on.
      github.head = SHA_3;
      github.openChecks = [{ id: 71, head_sha: SHA_2 }];
      await edit([], ['deeper'], 'alice', new Date().toISOString(), reviewing);
      expect(github.cancels).toEqual([9000, 9001]);
      const deeper = 'Review replaced by a deeper review requested by @alice.';
      expect(github.issueComments.get(SETTINGS)).toBe(replaced(deeper, 'deeper'));
      expect(github.checkEdits.at(-1)).toEqual({ id: 71, body: { status: 'completed', conclusion: 'cancelled', output: { title: 'Review cancelled', summary: deeper } } });
      expect(await state()).toMatchObject({ active: [{ kind: 'review', run_id: 9002, modes: ['deeper'] }] });
      expect((await workRows(pr.stub)).filter((row) => row.kind === 'settings').map((row) => row.note).slice(-2))
        .toEqual(['replacing work 1 requested, again review work 5', 'replacing work 5 requested, deeper review work 7']);
    });

    it('shows a review asked for by a box as starting once its run is dispatched, on Manki\'s settings comment only', async () => {
      const { pr, github, edit } = setup();
      // Both boxes ticked in one edit ask for one review, named by their labels.
      await edit([], ['deeper', 'draft'], 'alice', new Date().toISOString(), progress);
      expect(github.dispatches).toHaveLength(1);
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['deeper', 'draft'], 'Deeper review and Review this draft requested by @alice, starting…'));
      await pr.stub.runCompleted(key('d-deeper'), 9000, 'success');

      // A dispatch GitHub fails shows nothing until the retry starts the run.
      github.dispatchStatuses = [500];
      await edit([], ['deeper'], 'alice', new Date().toISOString(), progress);
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['deeper']));
      advanceClock(DISPATCH_BACKOFF_MS[0]);
      await runDurableObjectAlarm(pr.stub);
      expect(github.dispatches).toHaveLength(3);
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['deeper'], 'Deeper review requested by @alice, starting…'));
      await pr.stub.runCompleted(key('d-retry'), 9001, 'success');

      // Someone else's comment, or a status edit GitHub fails, changes nothing, and the review still runs.
      github.commentAuthors.set(SETTINGS, 'mallory');
      await edit([], ['deeper'], 'alice', new Date().toISOString(), progress);
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['deeper']));
      github.commentAuthors.delete(SETTINGS);
      await pr.stub.runCompleted(key('d-other'), 9002, 'success');
      github.deletedComments.add(SETTINGS);
      await edit([], ['deeper'], 'alice', new Date().toISOString(), progress);
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['deeper']));
      expect((await workRows(pr.stub)).filter((row) => row.kind === 'review').map((row) => row.status)).toEqual(['done', 'done', 'done', 'running']);
    });

    it('falls back to Manki\'s newest running progress comment on a cancel, and skips the comment cleanly when there is none', async () => {
      const { pr, github, edit } = setup();
      await pr.send('pull_request', pr.push(SHA_1));
      await runDurableObjectAlarm(pr.stub);
      // The ticked comment is an ended review's, so the running review's comment is looked up. A look-alike from someone else is not Manki's.
      github.issueComments.set(1400, progress());
      github.issueComments.set(1401, progress());
      github.commentAuthors.set(1401, 'mallory');
      github.openChecks = [{ id: 70, head_sha: SHA_1 }];
      await edit([], ['cancel']);
      expect(github.issueComments.get(1400)).toBe(cancelled('alice'));
      expect(github.issueComments.get(1401)).toBe(progress());
      expect(github.issueComments.get(SETTINGS)).toBe(boxes(['cancel']));
      expect(github.checkEdits).toEqual([cancelledCheck(70, 'alice')]);

      // With no running progress comment, only the check is completed, and the cancel is not tried again.
      await pr.send('issue_comment', pr.comment('@manki review'));
      await runDurableObjectAlarm(pr.stub);
      github.openChecks = [{ id: 71, head_sha: SHA_1 }];
      await edit([], ['cancel']);
      expect(github.issueComments.get(1401)).toBe(progress());
      expect(github.checkEdits.slice(1)).toEqual([cancelledCheck(71, 'alice')]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'done', note: 'cancel of work 3 requested' });

      // A comment list GitHub fails still completes the check, and the cancel stands.
      await pr.send('issue_comment', pr.comment('@manki review again'));
      await runDurableObjectAlarm(pr.stub);
      github.openChecks = [{ id: 72, head_sha: SHA_1 }];
      github.commentListStatus = 500;
      await edit([], ['cancel']);
      expect(github.cancels).toEqual([9000, 9001, 9002]);
      expect(github.checkEdits.slice(2)).toEqual([cancelledCheck(72, 'alice')]);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ kind: 'settings', status: 'done', note: 'cancel of work 5 requested' });

      // A comment still in progress from before the run is a dead run's, so the running review's comment is marked instead.
      github.commentListStatus = 200;
      await pr.send('issue_comment', pr.comment('@manki review once more'));
      await runDurableObjectAlarm(pr.stub);
      github.issueComments.set(1402, progress());
      github.commentCreated.set(SETTINGS, new Date(Date.now() - 60 * MINUTE).toISOString());
      await edit([], ['cancel'], 'alice', new Date().toISOString(), progress);
      expect(github.issueComments.get(SETTINGS)).toBe(progress(['cancel']));
      expect(github.issueComments.get(1402)).toBe(cancelled('alice'));

      // A run adopted minutes after its dispatch response was lost started at the first attempt, so its comment is still its own.
      github.head = SHA_2;
      github.dispatchStatuses = [502, 502];
      await pr.send('pull_request', pr.push(SHA_2), 'd-lost');
      await runDurableObjectAlarm(pr.stub);
      github.issueComments.set(1403, progress());
      github.commentCreated.set(1403, new Date().toISOString());
      advanceClock(DISPATCH_BACKOFF_MS[0]);
      await runDurableObjectAlarm(pr.stub);
      const title = `Manki pull_request.synchronize on #${pr.number} (d-lost)`;
      github.listedRuns = [{ id: 7003, display_title: title, created_at: new Date().toISOString(), actor: { login: 'manki-review[bot]' } }];
      github.runs.set(7003, { status: 'in_progress', event: 'workflow_dispatch', display_title: title, actor: { login: 'manki-review[bot]' } });
      advanceClock(DISPATCH_BACKOFF_MS[1]);
      await runDurableObjectAlarm(pr.stub);
      expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'running', run_id: 7003, note: 'recovered the run of an earlier attempt' });
      await edit([], ['cancel'], 'alice', new Date().toISOString(), progress);
      expect(github.cancels.at(-1)).toBe(7003);
      expect(github.issueComments.get(1403)).toBe(cancelled('alice'));
    });

    it('puts back the boxes as they apply after someone without write access changed them, looking them up once', async () => {
      const { pr, github, state, edit } = setup();
      await edit([], ['pause', 'again'], 'mallory');
      expect(github.issueComments.get(SETTINGS)).toBe(boxes([]));
      expect(await state()).toMatchObject({ queue: [], active: [], settings: { paused: false } });
      expect((await workRows(pr.stub)).map((row) => [row.kind, row.status, row.note])).toEqual([['settings', 'skipped', 'commenter has no write access']]);
      // A tick and an untick in a row leave Pause as it applies, not as the first revert left it.
      await edit([], ['pause'], 'mallory');
      await edit(['pause'], [], 'mallory');
      expect(github.issueComments.get(SETTINGS)).toBe(boxes([]));
      // An untick of a writer's Pause is put back ticked.
      await edit([], ['pause']);
      await edit(['pause'], [], 'mallory');
      expect(github.issueComments.get(SETTINGS)).toBe(boxes(['pause']));
      expect(await state()).toMatchObject({ settings: { paused: true } });
      expect(github.permissionReads).toEqual(['mallory', 'alice']);
      expect(github.dispatches).toEqual([]);
    });

    it('ignores a Pause change older than the last one applied, such as a late redelivery, and still applies its other boxes', async () => {
      const { pr, github, state, edit } = setup();
      await edit(['pause'], [], 'alice', '2030-01-01T00:00:02Z');
      await edit([], ['pause', 'again'], 'alice', '2030-01-01T00:00:01Z');
      expect(await state()).toMatchObject({ settings: { paused: false } });
      expect(github.dispatches).toHaveLength(1);
      expect((await workRows(pr.stub)).filter((row) => row.kind === 'settings').map((row) => row.note))
        .toEqual(['nothing changed', 'pause older than the last pause change, again review work 3']);
    });
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

  it('cancels a run that never started, dispatches it once more, then moves the lane on', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'), 'd-explain');
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(QUEUED_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(github.dispatches.map((dispatch) => dispatch.inputs.delivery_id)).toEqual(['d-explain', 'd-explain']);
    expect(logged(log, 'coordinator_requeued')).toMatchObject([{ run_id: 9000, reason: 'run never started' }]);
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'running', run_id: 9001, requeues: 1, attempts: 1 },
      { status: 'queued' },
    ]);

    advanceClock(QUEUED_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000, 9001]);
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'timed_out', note: 'run never started, cancel requested', run_id: 9001 },
      { status: 'running', run_id: 9002 },
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
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toEqual([]);
    expect(logged(log, 'coordinator_lacks_actions_write')).toHaveLength(1);
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'skipped', note: 'installation lacks actions: write' },
      { status: 'skipped', note: 'not opted in: installation lacks actions: write' },
    ]);
  });

  it('reads the opt-in again and dispatches once more when the cached workflow file is gone', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.workflows = { 'manki.yml': DISPATCH_WORKFLOW_YAML };
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatchedWorkflows).toEqual(['manki-dispatch.yml', 'manki-dispatch.yml']);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'queued', note: 'manki-dispatch.yml not found, queued again' });
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatchedWorkflows).toEqual(['manki-dispatch.yml', 'manki-dispatch.yml', 'manki.yml']);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'running', workflow: 'manki.yml' });

    // A file that is still gone after the fresh read fails the item.
    const other = pullRequest();
    const otherGitHub = fakeGitHub(other.number);
    otherGitHub.workflows = { 'manki.yml': DISPATCH_WORKFLOW_YAML };
    otherGitHub.dispatchStatuses = [404, 404];
    await other.send('pull_request', other.push(SHA_1));
    await runDurableObjectAlarm(other.stub);
    await runDurableObjectAlarm(other.stub);
    expect(await workRows(other.stub)).toMatchObject([{ status: 'failed', note: 'dispatch refused with 404: {"message":"no"}' }]);
  });

  it('fails a refused dispatch and reads the opt-in again', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.dispatchStatuses = [422];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'failed', note: 'dispatch refused with 422: {"message":"no"}' }]);
    await pr.send('issue_comment', pr.comment('@manki explain'));
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
    // The reviews show no association, as for a member with private membership whose lookup failed in the webhook.
    github.permissions = { alice: 'write' };
    for (let i = 0; i <= UNTRUSTED_DISPATCHES_PER_HOUR; i++) {
      await pr.send('pull_request_review', pr.outsiderReview(3000 + i));
      await runDurableObjectAlarm(pr.stub);
      await pr.stub.runCompleted(key(`d-end-${i}`), 9000 + i, 'success');
    }
    expect(github.dispatches).toHaveLength(UNTRUSTED_DISPATCHES_PER_HOUR);
    expect((await workRows(pr.stub)).at(-1)).toMatchObject({ status: 'dropped', note: `over ${UNTRUSTED_DISPATCHES_PER_HOUR} dispatches in the last hour` });

    for (let i = 0; i < DISPATCHES_PER_HOUR; i++) {
      await pr.send('pull_request_review', pr.review());
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
    await pr.send('issue_comment', pr.comment('@manki explain'));
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
    expect(logged(log, 'token_minted')).toHaveLength(github.mints.length);
  });

  it.each<[string, Reply]>([
    ['a 429', 429],
    ['a 403 with retry-after', { status: 403, headers: { 'retry-after': '30' } }],
    ['a 403 with no rate limit left', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
    ['a 403 that names a secondary rate limit', SECONDARY_RATE_LIMIT],
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

  it('cancels a run at the deadline whatever its polls return, and holds the lane until the cancel succeeds', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.runReadStatus = 500;
    github.cancelStatuses = [500];
    advanceClock(RUN_DEADLINE_MS - MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([]);
    advanceClock(2 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }, { status: 'queued' }]);
    advanceClock(4 * MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000, 9000]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'timed_out', note: 'no end of the run seen in time, cancel requested' }, { status: 'running' }]);
  });

  it('ends a run past the deadline once it is seen completed', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.runs.set(9000, { status: 'completed', conclusion: 'success' });
    advanceClock(RUN_DEADLINE_MS + MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'done', conclusion: 'success' }]);
  });

  it('ends a run past the deadline without a cancel once the installation lacks actions: write', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.runs.set(9000, { status: 'in_progress', run_started_at: new Date().toISOString() });
    github.refuseActionsWrite = true;
    advanceClock(RUN_DEADLINE_MS + MINUTE);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'timed_out', note: 'no end of the run seen in time, cannot cancel without actions: write' }]);
  });

  it('keeps the lane busy and retries a cancel that failed', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.cancelStatuses = [500];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    advanceClock(QUEUED_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(logged(log, 'coordinator_cancel_failed')).toMatchObject([{ run_id: 9000, status: 500 }]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }, { status: 'queued' }]);

    advanceClock(POLL_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000, 9000]);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running', run_id: 9001, requeues: 1 }, { status: 'queued' }]);
  });

  const TRANSIENT: Array<[string, Reply | 'network']> = [
    ['a 500', 500],
    ['a 502', 502],
    ['a 429', 429],
    ['a 403 with retry-after', { status: 403, headers: { 'retry-after': '30' } }],
    ['a 403 with no rate limit left', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
    ['a 403 that names a secondary rate limit', SECONDARY_RATE_LIMIT],
    ['a network error', 'network'],
  ];

  it.each(TRANSIENT)('retries the opt-in after %s from the token mint instead of caching it as not opted in', async (_case, reply) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.mintFailures = [{ permission: 'contents', reply }];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', errors: 1 }]);
    expect(logged(log, 'coordinator_opt_in')).toEqual([]);
    advanceClock(backoff(0));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }]);
  });

  it.each(TRANSIENT)('retries the dispatch after %s from the actions: write mint', async (_case, reply) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.mintFailures = [{ permission: 'actions', reply }];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'dispatching', errors: 1 }]);
    expect(logged(log, 'coordinator_lacks_actions_write')).toEqual([]);
    advanceClock(backoff(0));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatches).toHaveLength(1);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }]);
  });

  it.each<[string, Reply]>([
    ['a plain 403', 403],
    ['a 404', 404],
    ['a 422', 422],
  ])('counts %s from the token mint as a refusal', async (_case, reply) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.mintFailures = [{ permission: 'actions', reply }];
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', note: 'installation lacks actions: write' }]);

    const other = pullRequest();
    const otherGitHub = fakeGitHub(other.number);
    otherGitHub.mintFailures = [{ permission: 'contents', reply }];
    await other.send('issue_comment', other.comment('@manki explain'));
    await runDurableObjectAlarm(other.stub);
    expect(await workRows(other.stub)).toMatchObject([{ status: 'skipped', note: `not opted in: token mint refused with ${typeof reply === 'number' ? reply : reply.status}` }]);
  });

  it.each([
    ['manki.yml', { 'manki.yml': DISPATCH_WORKFLOW_YAML }],
    ['manki-dispatch.yml', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }],
    ['manki.yml next to manki-dispatch.yml', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML, 'manki.yml': DISPATCH_WORKFLOW_YAML }],
  ])('dispatches the workflow the opt-in found, for %s', async (_case, workflows) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.workflows = workflows;
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(github.dispatchedWorkflows).toEqual([Object.hasOwn(workflows, 'manki.yml') ? 'manki.yml' : 'manki-dispatch.yml']);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }]);
    const both = Object.keys(workflows).length > 1;
    expect(logged(log, 'coordinator_opt_in_warning')).toEqual(both ? [expect.objectContaining({ workflow: 'manki.yml', ignored: ['manki-dispatch.yml'] })] : []);
  });

  it('takes the owner, name and default branch from the repository id, never from the payload', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.repository = { ...github.repository, default_branch: 'trunk' };
    const forged = pr.push(SHA_1);
    forged.repository = { ...forged.repository, name: 'forged', owner: { login: 'mallory', id: OWNER_ID }, default_branch: 'attacker-branch' };
    await pr.send('pull_request', forged);
    await runDurableObjectAlarm(pr.stub);
    // The fake serves `manki-review/manki` only, so a call under the forged names would throw.
    expect(github.graphqlVariables).toEqual([{ owner: OWNER, name: REPO, expression: 'trunk:.github/workflows' }]);
    expect(github.dispatches.map((dispatch) => dispatch.ref)).toEqual(['trunk']);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }]);

    // A poll and a cancel use the same names.
    advanceClock(QUEUED_RUN_TIMEOUT_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(github.repositoryReads).toBe(2);
  });

  it('reads the repository again with the opt-in once the TTL runs out', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    await pr.stub.runCompleted(key('d-end'), 9000, 'success');
    advanceClock(OPT_IN_TTL_MS + 1);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(github.repositoryReads).toBe(2);
    expect(github.dispatches).toHaveLength(2);
  });

  it('counts a repository GitHub does not show as not opted in, and retries one it fails to read', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    github.repositoryStatus = 404;
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', note: 'not opted in: repository not found' }]);

    const other = pullRequest();
    const otherGitHub = fakeGitHub(other.number);
    otherGitHub.repositoryStatus = 502;
    await other.send('issue_comment', other.comment('@manki explain'));
    await runDurableObjectAlarm(other.stub);
    expect(await workRows(other.stub)).toMatchObject([{ status: 'dispatching', errors: 1 }]);
    otherGitHub.repositoryStatus = 200;
    advanceClock(backoff(0));
    await runDurableObjectAlarm(other.stub);
    expect(await workRows(other.stub)).toMatchObject([{ status: 'running' }]);
  });

  it.each([
    ['the repository', { optedIn: true, reason: 'cached before the repository was read' }],
    ['the workflow', { optedIn: true, reason: 'cached before the workflow was kept', repository: { owner: OWNER, ownerId: OWNER_ID, repo: REPO, defaultBranch: 'main' } }],
  ])('reads the opt-in again when it was cached without %s', async (_case, cached) => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runInDurableObject(pr.stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
        'opt_in', JSON.stringify({ ...cached, expires: Date.now() + OPT_IN_TTL_MS }),
      );
    });
    await runDurableObjectAlarm(pr.stub);
    expect(github.repositoryReads).toBe(1);
    expect(github.dispatchedWorkflows).toEqual(['manki-dispatch.yml']);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }]);
  });

  it('keeps a running item while GitHub does not show its repository, and ends it at the deadline', async () => {
    const pr = pullRequest();
    const github = fakeGitHub(pr.number);
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await pr.send('issue_comment', pr.comment('@manki explain'));
    await runDurableObjectAlarm(pr.stub);
    github.repositoryStatus = 404;
    advanceClock(OPT_IN_TTL_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'running' }, { status: 'queued' }]);

    // Once the repository shows again, the poll can cancel the run that never started.
    github.repositoryStatus = 200;
    advanceClock(QUEUED_RUN_TIMEOUT_MS);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(github.dispatches).toHaveLength(2);

    github.repositoryStatus = 404;
    advanceClock(RUN_DEADLINE_MS + 1);
    await runDurableObjectAlarm(pr.stub);
    expect(github.cancels).toEqual([9000]);
    expect(await workRows(pr.stub)).toMatchObject([
      { status: 'timed_out', note: 'the repository can no longer be read', run_id: 9001 },
      { status: 'skipped', note: 'not opted in: repository not found' },
    ]);
    expect(github.dispatches).toHaveLength(2);
  });

  it('does not dispatch for a repository that has not opted in', async () => {
    const pr = pullRequest();
    stubGitHub({ api: { 'POST /graphql': workflowsReply({ 'manki.yml': EVENT_WORKFLOW_YAML }) } });
    await pr.send('pull_request', pr.push(SHA_1));
    await runDurableObjectAlarm(pr.stub);
    expect(await workRows(pr.stub)).toMatchObject([{ status: 'skipped', note: 'not opted in: no Manki workflow runs on workflow_dispatch' }]);
  });
});
