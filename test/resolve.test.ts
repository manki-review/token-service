import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequests,
  dispatchedEnv,
  type GitHubStub,
  INSTALLATION_ID,
  logged,
  OWNER,
  passInstallationCache,
  postToken,
  REPO,
  REPOSITORY_ID,
  stubGitHub,
} from './helpers';

const THREAD = 'PRRT_kwDOManki1';
const MINT = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;

/** A thread as the GraphQL query reads it: on PR 7 of the repository, opened by Manki. */
const MANKI_THREAD = { pullRequest: { number: 7, repository: { databaseId: REPOSITORY_ID } }, comments: { nodes: [{ author: { login: 'manki-review' } }] } };

interface GraphqlCall {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Stubs GitHub so the thread query answers `node`, or `errors` instead, and each mutation leaves the thread as it asks.
 * `api` adds replies as for `stubGitHub`.
 */
function stubThread(node: unknown = MANKI_THREAD, errors?: unknown[], api: GitHubStub['api'] = {}): { requests: Request[]; calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  const requests = stubGitHub({
    api: {
      ...api,
      'POST /graphql': async (request) => {
        const call = await request.json() as GraphqlCall;
        calls.push(call);
        if (call.query.includes('node(id:')) return Response.json(errors ? { data: { node: null }, errors } : { data: { node } });
        return Response.json({ data: { result: { thread: { isResolved: call.query.includes('unresolveReviewThread') === false } } } });
      },
    },
  });
  return { requests, calls };
}

const mints = async (requests: Request[]) => Promise.all(apiRequests(requests)
  .filter((request) => `${request.method} ${new URL(request.url).pathname}` === MINT)
  .map((request) => request.json()));

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  passInstallationCache();
});

afterEach(() => {
  vi.useRealTimers();
  expect(log.mock.calls.flat().join('\n')).not.toContain('ghs_');
});

describe('/resolve', () => {
  const { env, checks } = dispatchedEnv();
  const post = (body: Record<string, unknown>, options: Parameters<typeof postToken>[0] = {}) =>
    postToken({ env, path: '/resolve', body: { owner: OWNER, repo: REPO, ...body }, ...options });

  it('resolves and reopens a Manki thread on the PR of the run Manki dispatched', async () => {
    const { requests, calls } = stubThread();
    const resolve = await post({ thread_id: THREAD, resolved: true, reason: 'ADDRESSED' });
    expect({ status: resolve.status, body: await resolve.json() }).toEqual({ status: 200, body: { resolved: true } });
    const reopen = await post({ thread_id: THREAD, resolved: false });
    expect({ status: reopen.status, body: await reopen.json() }).toEqual({ status: 200, body: { resolved: false } });

    expect(checks.map((check) => check[0])).toEqual([`${REPOSITORY_ID}:7`, `${REPOSITORY_ID}:7`]);
    // Each call mints the run check's token and one that holds `contents: write` only for the resolve.
    const resolveMints = (await mints(requests)).filter((body) => (body as { permissions: Record<string, string> }).permissions.contents);
    expect(resolveMints).toEqual(Array(2).fill({ permissions: { contents: 'write', pull_requests: 'write' }, repository_ids: [REPOSITORY_ID] }));
    expect(calls.map((call) => [call.query.match(/(node|resolveReviewThread|unresolveReviewThread)\(/)?.[1], call.variables])).toEqual([
      ['node', { id: THREAD }],
      ['resolveReviewThread', { id: THREAD, reason: 'ADDRESSED' }],
      ['node', { id: THREAD }],
      ['unresolveReviewThread', { id: THREAD }],
    ]);
    expect(logged(log, 'thread_resolved')).toEqual([
      { msg: 'thread_resolved', repository: `${OWNER}/${REPO}`, run_id: '9000', thread_id: THREAD, resolved: true, pr: 7, resolution_reason: 'ADDRESSED' },
      { msg: 'thread_resolved', repository: `${OWNER}/${REPO}`, run_id: '9000', thread_id: THREAD, resolved: false, pr: 7 },
    ]);
  });

  it.each([
    ['a thread on another PR', { ...MANKI_THREAD, pullRequest: { ...MANKI_THREAD.pullRequest, number: 8 } }, undefined],
    ['a thread of another repository', { ...MANKI_THREAD, pullRequest: { number: 7, repository: { databaseId: REPOSITORY_ID + 1 } } }, undefined],
    ['a thread someone else opened', { ...MANKI_THREAD, comments: { nodes: [{ author: { login: 'mallory' } }] } }, undefined],
    ['a thread whose first comment has no author', { ...MANKI_THREAD, comments: { nodes: [{ author: null }] } }, undefined],
    ['a node that is no thread', {}, undefined],
    ['an unknown node', null, [{ type: 'NOT_FOUND', message: 'Could not resolve to a node with the global id' }]],
  ])('refuses %s without changing it', async (_case, node, errors) => {
    const { calls } = stubThread(node, errors);
    const response = await post({ thread_id: THREAD, resolved: true });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404, body: { error: 'No Manki review thread with that id on the run\'s pull request' },
    });
    expect(calls).toHaveLength(1);
    expect(logged(log, 'resolve_refused')).toMatchObject([{ pr: 7, reason: 'not a Manki thread on the run\'s pull request' }]);
  });

  it('refuses a workflow that is not the run Manki dispatched before it mints the resolve token', async () => {
    const { requests, calls } = stubThread();
    const { env: refusing } = dispatchedEnv('run 9000 is not active on this PR');
    const response = await post({ thread_id: THREAD, resolved: true }, { env: refusing });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403, body: { error: 'Only the run Manki dispatched may resolve threads: run 9000 is not active on this PR' },
    });
    expect(await mints(requests)).toEqual([{ permissions: { actions: 'read' }, repository_ids: [REPOSITORY_ID] }]);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no thread id', { resolved: true }],
    ['a thread id that is no node id', { thread_id: 'PRRT_1 } }', resolved: true }],
    ['no resolved flag', { thread_id: THREAD }],
    ['a resolved flag given as a string', { thread_id: THREAD, resolved: 'true' }],
    ['an unknown reason', { thread_id: THREAD, resolved: true, reason: 'DUPLICATE' }],
    ['a reason for a reopen', { thread_id: THREAD, resolved: false, reason: 'ADDRESSED' }],
  ])('rejects a body with %s', async (_case, body) => {
    const { requests, calls } = stubThread();
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await mints(requests)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers 500 with a request id when the thread query fails', async () => {
    stubThread(null, [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }]);
    const response = await post({ thread_id: THREAD, resolved: true });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string; request_id: string };
    expect(body).toEqual({ error: 'Resolving the thread failed', request_id: expect.any(String) });
    expect(logged(log, 'request_failed')).toMatchObject([{ request_id: body.request_id, detail: expect.stringContaining('Resource not accessible') }]);
  });

  it.each([
    ['403 when the installation grants no `contents: write`', 422, 403],
    ['500 when GitHub fails the mint', 502, 500],
  ])('answers %s, without GitHub\'s message', async (_case, mintStatus, status) => {
    const { calls } = stubThread(MANKI_THREAD, undefined, {
      [MINT]: async (request) => {
        const { permissions } = await request.json() as { permissions: Record<string, string> };
        if (permissions.contents) return Response.json({ message: 'The permissions requested are not granted to this installation.' }, { status: mintStatus });
        return Response.json({ token: 'ghs_check', expires_at: '2030-01-01T01:00:00Z', permissions }, { status: 201 });
      },
    });
    const response = await post({ thread_id: THREAD, resolved: true });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Token mint failed', request_id: expect.any(String) });
    expect(calls).toEqual([]);
  });
});
