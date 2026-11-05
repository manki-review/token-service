import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '../src/signature';
import worker from '../src/index';
import { coordinator, DELIVERY_ID, freezeClock, OIDC_AUDIENCE, postWebhook, signWebhook, stubGitHub, TEST_ENV, workRows } from './helpers';
import { HEAD_SHA, issueCommentEvent, PR_NUMBER, pullRequestEvent, REPOSITORY_ID } from './payloads';

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

function logged(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
}

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
    expect(logged(log).filter((line) => line.msg === 'coordinator_receive')).toMatchObject([
      { accepted: true },
      { accepted: false, reason: 'duplicate delivery' },
    ]);
    expect(await workRows(coordinator(REPOSITORY_ID, 31))).toHaveLength(1);
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
