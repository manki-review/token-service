import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '../src/signature';
import worker from '../src/index';
import { DEFAULT_EVENTS_PER_HOUR, eventsPerHour, InstallationLimiter } from '../src/limiter';
import { coordinator, DELIVERY_ID, freezeClock, logged, OIDC_AUDIENCE, OWNER, OWNER_ID, postWebhook, REPO, signWebhook, stubGitHub, TEST_ENV, workRows } from './helpers';
import { HEAD_SHA, issueCommentEvent, MANKI_AUTHOR, PR_NUMBER, pullRequestEvent, REPOSITORY_ID, reviewEvent, reviewThreadEvent, workflowRunEvent } from './payloads';

const encoder = new TextEncoder();

describe('verifyWebhookSignature', () => {
  // The example from GitHub's "Validating webhook deliveries" guide.
  const secret = "It's a Secret to Everybody";
  const body = encoder.encode('Hello, World!').buffer as ArrayBuffer;
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  it('accepts GitHub\'s test vector', async () => {
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it.each([
    ['a missing header', null],
    ['an empty header', ''],
    ['one changed digit', signature.replace(/7$/, '8')],
    ['a truncated digest', signature.slice(0, -2)],
    ['a digest without the prefix', signature.slice('sha256='.length)],
    ['an upper case digest', `sha256=${signature.slice('sha256='.length).toUpperCase()}`],
    ['a SHA-1 header', 'sha1=01dc10d0c83e72ed246219cdd91669667fe2ca59'],
  ])('rejects %s', async (_case, header) => {
    expect(await verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it('rejects the right digest under another secret', async () => {
    expect(await verifyWebhookSignature('another secret', body, signature)).toBe(false);
  });

  it('rejects every signature when the secret is empty', async () => {
    expect(await verifyWebhookSignature('', body, signature)).toBe(false);
  });
});

describe('/webhook', () => {
  let advanceClock: (ms: number) => number;

  beforeEach(() => {
    advanceClock = freezeClock();
    stubGitHub();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs the route, queues the work and answers 202 without calling GitHub', async () => {
    const requests = stubGitHub();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await postWebhook({ event: 'pull_request', payload: pullRequestEvent('synchronize'), delivery: DELIVERY_ID });
    expect(response.status).toBe(202);
    expect(logged(log)).toEqual([{
      msg: 'webhook',
      delivery: DELIVERY_ID,
      event: 'pull_request',
      action: 'synchronize',
      route: 'state',
      pr: PR_NUMBER,
      repository_id: REPOSITORY_ID,
      kind: 'review',
      dispatch_event: 'pull_request.synchronize',
      head_sha: HEAD_SHA,
      object_id: null,
      sender: 'alice',
    }, {
      msg: 'coordinator_receive',
      repo: 'manki-review/manki',
      pr: PR_NUMBER,
      delivery: DELIVERY_ID,
      accepted: true,
      effect: 'queued work 1',
    }]);
    expect(requests).toEqual([]);
    expect(await workRows(coordinator(REPOSITORY_ID, PR_NUMBER))).toMatchObject([
      { lane: 'state', kind: 'review', event: 'pull_request.synchronize', head_sha: HEAD_SHA, delivery: DELIVERY_ID, status: 'queued' },
    ]);
  });

  it('refuses a replayed delivery without queuing it again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const delivery = { event: 'issue_comment', payload: issueCommentEvent('@manki explain', { number: 31 }), delivery: crypto.randomUUID() };
    expect((await postWebhook(delivery)).status).toBe(202);
    expect((await postWebhook(delivery)).status).toBe(202);
    expect(logged(log, 'coordinator_receive')).toMatchObject([
      { accepted: true },
      { accepted: false, reason: 'duplicate delivery' },
    ]);
    expect(await workRows(coordinator(REPOSITORY_ID, 31))).toHaveLength(1);
  });

  it('refuses a body it has seen under a new delivery id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const payload = issueCommentEvent('@manki explain', { number: 34 });
    expect((await postWebhook({ event: 'issue_comment', payload })).status).toBe(202);
    expect((await postWebhook({ event: 'issue_comment', payload })).status).toBe(202);
    expect(logged(log, 'coordinator_receive')).toMatchObject([
      { accepted: true },
      { accepted: false, reason: 'duplicate delivery' },
    ]);
    expect(await workRows(coordinator(REPOSITORY_ID, 34))).toHaveLength(1);
  });

  it('accepts a thread event whose body repeats under a new delivery id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const resolved = reviewThreadEvent('resolved', { number: 35 });
    for (const payload of [resolved, reviewThreadEvent('unresolved', { number: 35 }), resolved]) {
      expect((await postWebhook({ event: 'pull_request_review_thread', payload })).status).toBe(202);
    }
    expect(logged(log, 'coordinator_receive').map((line) => line.accepted)).toEqual([true, true, true]);
  });

  it('answers 500 when the coordinator cannot store the delivery, so GitHub records a failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const failing = { getByName: () => ({ receive: async () => { throw new Error('storage unavailable'); } }) };
    const env = { ...TEST_ENV, PR_COORDINATOR: failing as unknown as typeof TEST_ENV.PR_COORDINATOR };
    const response = await postWebhook({ event: 'pull_request', payload: pullRequestEvent('synchronize'), env });
    expect(response.status).toBe(500);
  });

  it.each([
    ['an account missing from WEBHOOK_ACCOUNTS', '1,2'],
    ['the repository id in place of its account', String(REPOSITORY_ID)],
    ['an empty WEBHOOK_ACCOUNTS', ''],
    ['an unset WEBHOOK_ACCOUNTS', undefined],
  ])('answers 202 without touching a coordinator for %s', async (_case, accounts) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const untouched = { getByName: () => { throw new Error('no coordinator may be called'); } };
    const env = { ...TEST_ENV, WEBHOOK_ACCOUNTS: accounts, PR_COORDINATOR: untouched as unknown as typeof TEST_ENV.PR_COORDINATOR };
    for (const [event, payload] of [['pull_request', pullRequestEvent('synchronize')], ['workflow_run', workflowRunEvent()]] as const) {
      expect((await postWebhook({ event, payload, env })).status).toBe(202);
    }
    const reason = `account ${OWNER_ID} is not in WEBHOOK_ACCOUNTS`;
    expect(logged(log)).toMatchObject([{ route: 'ignore', reason }, { route: 'ignore', reason }]);
  });

  it('accepts any repository of an account anywhere in WEBHOOK_ACCOUNTS', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { ...TEST_ENV, WEBHOOK_ACCOUNTS: ` 1, ${OWNER_ID} ,3` };
    expect((await postWebhook({ event: 'issue_comment', payload: issueCommentEvent('@manki explain', { number: 33 }), env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 33))).toHaveLength(1);
  });

  /** A login of its own for each test, so no test reuses another's cached lookup. */
  const newLogin = () => `user-${crypto.randomUUID().slice(0, 8)}`;
  let lookupPr = 80;
  const permissionReads = (requests: Request[]) => requests
    .map((request) => /\/collaborators\/([^/]+)\/permission$/.exec(new URL(request.url).pathname)?.[1])
    .filter((login) => login !== undefined);

  it.each<[string, string, string, string, number, number]>([
    ['a read-only member', 'issue_comment', 'MEMBER', 'read', 0, 1],
    ['a read-only collaborator', 'issue_comment', 'COLLABORATOR', 'read', 0, 1],
    ['a triage collaborator', 'issue_comment', 'COLLABORATOR', 'triage', 0, 1],
    ['an outside reviewer', 'pull_request_review', 'NONE', 'read', 0, 0],
    ['an outsider', 'issue_comment', 'NONE', 'read', 0, 0],
    ['a private member shown with no association', 'issue_comment', 'NONE', 'write', 1, 1],
    ['a private member shown as a contributor', 'issue_comment', 'CONTRIBUTOR', 'admin', 1, 1],
    ['a private member shown as a first-time contributor', 'issue_comment', 'FIRST_TIME_CONTRIBUTOR', 'write', 1, 1],
    ['a first-timer', 'issue_comment', 'FIRST_TIMER', 'read', 0, 0],
    ['a writing collaborator', 'pull_request_review', 'COLLABORATOR', 'write', 1, 1],
  ])('looks up the write access of %s before the work is queued', async (_case, event, association, permission, writer, trusted) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const login = newLogin();
    const requests = stubGitHub({ permissions: { [login]: permission } });
    const user = { login, type: 'User' };
    const number = lookupPr++;
    const payload = event === 'issue_comment'
      ? issueCommentEvent('@manki review', { number, association, author: user, sender: user })
      : { ...reviewEvent('submitted', { author_association: association, user }, { number }), sender: user };
    expect((await postWebhook({ event, payload })).status).toBe(202);
    expect(permissionReads(requests)).toEqual([login]);
    expect(await workRows(coordinator(REPOSITORY_ID, number))).toMatchObject([{ sender: login, writer, trusted }]);
  });

  it('looks up no owner, reuses an answer, and reads a failed lookup as no write access', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const login = newLogin();
    const failing = newLogin();
    const requests = stubGitHub({
      permissions: { [login]: 'write' },
      api: { [`GET /repos/${OWNER}/${REPO}/collaborators/${failing}/permission`]: { status: 502, body: { message: 'Bad gateway' } } },
    });
    const send = async (number: number, association: string, sender = login) => {
      const user = { login: sender, type: 'User' };
      expect((await postWebhook({ event: 'issue_comment', payload: issueCommentEvent('@manki review', { number, association, author: user, sender: user }) })).status).toBe(202);
      return (await workRows(coordinator(REPOSITORY_ID, number)))[0].writer;
    };
    expect(await send(91, 'OWNER')).toBe(1);
    expect(permissionReads(requests)).toEqual([]);
    expect([await send(94, 'MEMBER'), await send(95, 'NONE')]).toEqual([1, 1]);
    expect(permissionReads(requests)).toEqual([login]);
    // A failed lookup is not reused, so the coordinator looks the sender up again before it starts the work.
    expect([await send(96, 'MEMBER', failing), await send(97, 'MEMBER', failing)]).toEqual([0, 0]);
    expect(permissionReads(requests)).toEqual([login, failing, failing]);
    expect(logged(log, 'webhook_writer_check_failed')).toHaveLength(2);
  });

  it('ignores outsiders\' comments over the installation cap until the next hour, without touching their coordinators', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const installation = 5151;
    const env = { ...TEST_ENV, INSTALLATION_EVENTS_PER_HOUR: '2' };
    const mint = { body: { token: 'ghs_check', expires_at: '2030-01-01T01:00:00Z', permissions: { metadata: 'read' } }, status: 201 };
    stubGitHub({ permissions: { alice: 'write' }, api: { [`POST /app/installations/${installation}/access_tokens`]: mint } });
    const send = (number: number, installationId = installation, body = '@manki explain', delivery?: string, association = 'NONE') => {
      // An outsider writes as `mallory`, who has read access, and a writer as `alice`.
      const user = { login: association === 'NONE' ? 'mallory' : 'alice', type: 'User' };
      return postWebhook({
        event: 'issue_comment',
        payload: { ...issueCommentEvent(body, { number, association, author: user, sender: user }), installation: { id: installationId } },
        env,
        delivery,
      });
    };
    // Only stored work counts: neither a delivery the router ignores nor a replay the coordinator refuses.
    const replayed = crypto.randomUUID();
    for (const delivery of [replayed, replayed]) expect((await send(61, installation, '@manki explain', delivery)).status).toBe(202);
    expect((await send(61, installation, 'LGTM')).status).toBe(202);
    for (const number of [62, 63]) expect((await send(number)).status).toBe(202);
    expect(logged(log, 'webhook').map((line) => line.reason ?? line.route)).toEqual([
      'chat', 'chat', 'comment does not mention Manki', 'chat', `installation ${installation} is over 2 events this hour`,
    ]);
    expect(logged(log, 'coordinator_receive')).toMatchObject([{ accepted: true }, { accepted: false, reason: 'duplicate delivery' }, { accepted: true }]);
    expect(await workRows(coordinator(REPOSITORY_ID, 62))).toHaveLength(1);
    expect(await workRows(coordinator(REPOSITORY_ID, 63))).toEqual([]);
    // A writer's comment, a settings edit, a dismissed review, a resolved thread, a push to a branch of the
    // repository, a close and a run's end still get through.
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect((await send(66, installation, `@manki explain ${association}`, undefined, association)).status).toBe(202);
    }
    expect(await workRows(coordinator(REPOSITORY_ID, 66))).toHaveLength(3);
    const settings = '- [x] Pause <!-- manki-box:pause -->\n<!-- manki-settings -->';
    const settingsEdit = issueCommentEvent(settings, {
      number: 70, action: 'edited', author: MANKI_AUTHOR, association: 'NONE', previousBody: settings.replace('[x]', '[ ]'),
    });
    expect((await postWebhook({ event: 'issue_comment', payload: { ...settingsEdit, installation: { id: installation } }, env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 70))).toMatchObject([{ kind: 'settings' }]);
    const dismissed = { ...reviewEvent('dismissed', { author_association: 'NONE' }, { number: 69 }), installation: { id: installation } };
    expect((await postWebhook({ event: 'pull_request_review', payload: dismissed, env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 69))).toMatchObject([{ kind: 'review_state' }]);
    const resolved = { ...reviewThreadEvent('resolved', { number: 68 }), installation: { id: installation } };
    expect((await postWebhook({ event: 'pull_request_review_thread', payload: resolved, env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 68))).toMatchObject([{ kind: 'review_state' }]);
    const push = { ...pullRequestEvent('synchronize', { number: 63 }), installation: { id: installation } };
    expect((await postWebhook({ event: 'pull_request', payload: push, env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 63))).toMatchObject([{ kind: 'review', status: 'queued' }]);
    const close = { ...pullRequestEvent('closed', { number: 62 }), installation: { id: installation } };
    expect((await postWebhook({ event: 'pull_request', payload: close, env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 62))).toMatchObject([{ status: 'dropped', note: 'pull request closed' }]);
    const runEnd = { ...workflowRunEvent(), installation: { id: installation } };
    expect((await postWebhook({ event: 'workflow_run', payload: runEnd, env })).status).toBe(202);
    expect(logged(log, 'webhook').slice(-9).map((line) => line.route))
      .toEqual(['chat', 'chat', 'chat', 'settings', 'state', 'state', 'state', 'close', 'run_completed']);
    // Another installation has its own count.
    expect((await send(64, installation + 1)).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 64))).toHaveLength(1);
    // The count is stored, so an instance that starts after an eviction keeps refusing.
    const limiter = TEST_ENV.INSTALLATION_LIMITER.getByName(String(installation));
    expect(await runInDurableObject(limiter, (_instance, state) => new InstallationLimiter(state, TEST_ENV).hasRoom(2))).toBe(false);

    advanceClock(60 * 60_000);
    expect((await send(65)).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 65))).toHaveLength(1);
  });

  it.each([
    ['unset', undefined, DEFAULT_EVENTS_PER_HOUR],
    ['empty', '', DEFAULT_EVENTS_PER_HOUR],
    ['zero', '0', DEFAULT_EVENTS_PER_HOUR],
    ['not a number', 'many', DEFAULT_EVENTS_PER_HOUR],
    ['a fraction', '1.5', DEFAULT_EVENTS_PER_HOUR],
    ['a whole number', ' 20 ', 20],
  ])('reads the installation cap when it is %s', (_case, value, expected) => {
    expect(eventsPerHour({ ...TEST_ENV, INSTALLATION_EVENTS_PER_HOUR: value })).toBe(expected);
  });

  it('leaves the coordinator alone for an ignored delivery', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await postWebhook({ event: 'issue_comment', payload: issueCommentEvent('LGTM', { number: 32 }) })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 32))).toEqual([]);
  });

  it.each([
    ['an ignored comment', 'issue_comment', issueCommentEvent('LGTM'), { route: 'ignore', reason: 'comment does not mention Manki' }],
    ['a close', 'pull_request', pullRequestEvent('closed', { merged: true }), { route: 'close', merged: true }],
    ['a ping', 'ping', { zen: 'Speak like a human.', hook_id: 1 }, { route: 'ignore', reason: 'unhandled event ping' }],
  ])('answers 202 for %s and logs why', async (_case, event, payload, expected) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await postWebhook({ event, payload })).status).toBe(202);
    expect(logged(log)[0]).toMatchObject(expected);
  });

  it.each([
    ['a missing signature', { signature: null }],
    ['a signature under another secret', { signature: 'sha256=' + '0'.repeat(64) }],
  ])('refuses %s with 401', async (_case, options) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await postWebhook({ event: 'pull_request', payload: pullRequestEvent('synchronize'), ...options });
    expect(response.status).toBe(401);
    expect(log).not.toHaveBeenCalled();
  });

  it('accepts a delivery signed with WEBHOOK_SECRET_PREVIOUS while it is set', async () => {
    const payload = { zen: 'Mind your words, they are important.' };
    const signature = await signWebhook(JSON.stringify(payload), 'old-secret');
    expect((await postWebhook({ payload, signature, env: { ...TEST_ENV, WEBHOOK_SECRET_PREVIOUS: 'old-secret' } })).status).toBe(202);
    expect((await postWebhook({ payload, signature })).status).toBe(401);
    expect((await postWebhook({ payload, signature, env: { ...TEST_ENV, WEBHOOK_SECRET_PREVIOUS: 'another-secret' } })).status).toBe(401);
  });

  it('refuses a body changed after signing', async () => {
    const signature = await signWebhook(JSON.stringify(pullRequestEvent('synchronize')));
    const response = await postWebhook({ event: 'pull_request', payload: pullRequestEvent('opened'), signature });
    expect(response.status).toBe(401);
  });

  it('refuses a delivery for another App with 403', async () => {
    const response = await postWebhook({ targetId: '999' });
    expect(response.status).toBe(403);
    expect((await postWebhook({ targetId: null })).status).toBe(403);
  });

  it.each([
    ['no event header', { event: null }],
    ['no delivery header', { delivery: null }],
    ['a delivery id that is not a GUID', { delivery: '../../etc' }],
    ['a body that is not JSON', { body: 'not json' }],
  ])('refuses %s with 400', async (_case, options) => {
    expect((await postWebhook(options)).status).toBe(400);
  });

  it('refuses a body over 25 MiB with 413 before reading it', async () => {
    const response = await worker.fetch(new Request(`https://${OIDC_AUDIENCE}/webhook`, {
      method: 'POST',
      headers: { 'Content-Length': String(25 * 1024 * 1024 + 1) },
      body: new ReadableStream({ pull: () => { throw new Error('the body must not be read'); } }),
    }), TEST_ENV);
    expect(response.status).toBe(413);
  });

  it('refuses a streamed body over 25 MiB with 413 once it passes the limit', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    const response = await worker.fetch(new Request(`https://${OIDC_AUDIENCE}/webhook`, {
      method: 'POST',
      body: new ReadableStream({
        pull: (controller) => {
          pulls++;
          controller.enqueue(chunk);
          if (pulls === 30) controller.close();
        },
      }),
    }), TEST_ENV);
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThan(30);
  });

  it('accepts a streamed body under 25 MiB', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = JSON.stringify({ zen: 'Half measures are as bad as nothing at all.' });
    const bytes = new TextEncoder().encode(body);
    const response = await worker.fetch(new Request(`https://${OIDC_AUDIENCE}/webhook`, {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': crypto.randomUUID(),
        'X-GitHub-Hook-Installation-Target-ID': TEST_ENV.APP_ID,
        'X-Hub-Signature-256': await signWebhook(body),
      },
      body: new ReadableStream({
        start: (controller) => {
          controller.enqueue(bytes.slice(0, 10));
          controller.enqueue(bytes.slice(10));
          controller.close();
        },
      }),
    }), TEST_ENV);
    expect(response.status).toBe(202);
  });

  it('answers 500 while no webhook secret is set', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await postWebhook({ env: { ...TEST_ENV, WEBHOOK_SECRET: undefined } });
    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledWith('WEBHOOK_SECRET is not set, refusing webhook deliveries');
  });

  it('accepts only POST', async () => {
    const response = await worker.fetch(new Request(`https://${OIDC_AUDIENCE}/webhook`), TEST_ENV);
    expect(response.status).toBe(405);
  });
});
