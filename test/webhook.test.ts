import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '../src/signature';
import worker from '../src/index';
import { coordinator, DELIVERY_ID, freezeClock, logged, OIDC_AUDIENCE, postWebhook, signWebhook, stubGitHub, TEST_ENV, workRows } from './helpers';
import { HEAD_SHA, issueCommentEvent, PR_NUMBER, pullRequestEvent, REPOSITORY_ID, reviewThreadEvent, workflowRunEvent } from './payloads';

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
  beforeEach(() => {
    freezeClock();
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
    ['a repository missing from WEBHOOK_REPOS', '1,2'],
    ['an empty WEBHOOK_REPOS', ''],
    ['an unset WEBHOOK_REPOS', undefined],
  ])('answers 202 without touching a coordinator for %s', async (_case, repos) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const untouched = { getByName: () => { throw new Error('no coordinator may be called'); } };
    const env = { ...TEST_ENV, WEBHOOK_REPOS: repos, PR_COORDINATOR: untouched as unknown as typeof TEST_ENV.PR_COORDINATOR };
    for (const [event, payload] of [['pull_request', pullRequestEvent('synchronize')], ['workflow_run', workflowRunEvent()]] as const) {
      expect((await postWebhook({ event, payload, env })).status).toBe(202);
    }
    const reason = `repository ${REPOSITORY_ID} is not in WEBHOOK_REPOS`;
    expect(logged(log)).toMatchObject([{ route: 'ignore', reason }, { route: 'ignore', reason }]);
  });

  it('accepts a repository anywhere in WEBHOOK_REPOS', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { ...TEST_ENV, WEBHOOK_REPOS: ` 1, ${REPOSITORY_ID} ,3` };
    expect((await postWebhook({ event: 'issue_comment', payload: issueCommentEvent('@manki explain', { number: 33 }), env })).status).toBe(202);
    expect(await workRows(coordinator(REPOSITORY_ID, 33))).toHaveLength(1);
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
