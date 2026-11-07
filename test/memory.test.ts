import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequests,
  dispatchedEnv,
  DISPATCHED_RUN_ID,
  logged,
  oidcToken,
  OWNER,
  postToken,
  REPO,
  REPOSITORY_ID,
  stubGitHub,
  type GitHubStub,
} from './helpers';

const MEMORY = 'manki-review/review-memory';
const MEMORY_INSTALLATION = 555;
const FOLDER = `${OWNER}/${REPO}`;
const sha = (n: number) => String(n).padStart(40, '0');

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  expect(log.mock.calls.flat().join('\n')).not.toContain('ghs_');
});

/**
 * A fake central memory repository holding `files` by path. Each write must name the stored sha, as GitHub requires,
 * and `conflicts` makes the next writes fail as if another run wrote first.
 */
function fakeMemory(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files).map(([path, text], i) => [path, { text, sha: sha(i + 1) }]));
  const state = { store, writes: [] as Array<{ path: string; message: string; sha?: string }>, conflicts: 0, mints: [] as unknown[], next: 100 };
  const paths = [
    ...['learnings.yml', 'suppressions.yml', 'patterns.yml', 'metrics/fix-rate.jsonl'].map((file) => `${FOLDER}/${file}`),
    '_global/learnings.yml', '_global/conventions.md',
  ];
  const api: GitHubStub['api'] = {
    [`GET /repos/${MEMORY}/installation`]: { body: { id: MEMORY_INSTALLATION, permissions: { contents: 'write', metadata: 'read' } } },
    [`POST /app/installations/${MEMORY_INSTALLATION}/access_tokens`]: async (request) => {
      state.mints.push(await request.json());
      return Response.json({ token: 'ghs_memory', expires_at: '2030-01-01T01:00:00Z', permissions: { contents: 'write', metadata: 'read' } }, { status: 201 });
    },
  };
  for (const file of store.values()) {
    api[`GET /repos/${MEMORY}/git/blobs/${file.sha}`] = () => Response.json({ sha: file.sha, encoding: 'base64', content: base64(file.text) });
  }
  for (const path of paths) {
    api[`GET /repos/${MEMORY}/contents/${path}`] = () => {
      const file = store.get(path);
      if (!file) return Response.json({ message: 'Not Found' }, { status: 404 });
      // GitHub leaves the content of a file over 1 MB out of the contents API.
      const large = file.text.length > 1024 * 1024;
      return Response.json({ type: 'file', sha: file.sha, encoding: large ? 'none' : 'base64', content: large ? '' : base64(file.text) });
    };
    api[`PUT /repos/${MEMORY}/contents/${path}`] = async (request) => {
      const body = await request.json() as { message: string; content: string; sha?: string };
      state.writes.push({ path, message: body.message, sha: body.sha });
      const current = store.get(path);
      if (state.conflicts > 0 || current?.sha !== body.sha) {
        state.conflicts = Math.max(0, state.conflicts - 1);
        return Response.json({ message: 'conflict' }, { status: current && !body.sha ? 422 : 409 });
      }
      const next = { text: new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))), sha: sha(state.next++) };
      store.set(path, next);
      return Response.json({ content: { sha: next.sha } }, { status: current ? 200 : 201 });
    };
  }
  return { state, requests: stubGitHub({ api }) };
}

const { env } = dispatchedEnv();

async function call(operation: string, body: Record<string, unknown> = {}, options: { env?: typeof env; claims?: Record<string, unknown> } = {}) {
  const token = await oidcToken({ claims: options.claims });
  const response = await postToken({ env: options.env ?? env, path: `/memory/${operation}`, token, body: { owner: OWNER, repo: REPO, pr: 7, ...body } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('/memory', () => {
  it('reads the repository\'s own memory files and `_global`, with a token for the memory repository alone', async () => {
    const { state } = fakeMemory({
      [`${FOLDER}/learnings.yml`]: '- id: l1\n  content: Use tabs\n',
      '_global/conventions.md': 'Write short commits.\n',
      'xdustinface/rust-dashcore/learnings.yml': '- id: other\n',
    });
    expect(await call('read')).toEqual({
      status: 200,
      body: {
        repo: { 'learnings.yml': { text: '- id: l1\n  content: Use tabs\n', sha: sha(1) }, 'suppressions.yml': null, 'patterns.yml': null },
        global: { 'learnings.yml': null, 'conventions.md': { text: 'Write short commits.\n', sha: sha(2) } },
      },
    });
    expect(state.mints).toEqual([{ permissions: { contents: 'write' }, repositories: ['review-memory'] }]);
    expect(logged(log, 'token_minted')).toMatchObject([{ purpose: 'memory', repository: FOLDER, run_id: String(DISPATCHED_RUN_ID), installation_id: MEMORY_INSTALLATION }]);
  });

  it('replaces a file of the repository\'s own folder only while it still has the sha the run read', async () => {
    const { state } = fakeMemory({ [`${FOLDER}/suppressions.yml`]: '[]\n' });
    const write = (sha: string | null, message = 'Add suppression: noisy\nlint') =>
      call('write', { file: 'suppressions.yml', content: '- pattern: noisy\n', sha, message });
    expect(await write(sha(1))).toEqual({ status: 200, body: { sha: sha(100) } });
    expect(state.store.get(`${FOLDER}/suppressions.yml`)?.text).toBe('- pattern: noisy\n');
    expect(state.writes.at(-1)).toEqual({ path: `${FOLDER}/suppressions.yml`, message: `Add suppression: noisy lint (${FOLDER} run ${DISPATCHED_RUN_ID})`, sha: sha(1) });
    // The run read an older version, or thought the file was new.
    expect(await write(sha(1))).toEqual({ status: 409, body: { error: 'the file changed since it was read' } });
    expect(await write(null)).toEqual({ status: 409, body: { error: 'the file changed since it was read' } });
    // A new file takes a null sha.
    expect((await call('write', { file: 'patterns.yml', content: '[]\n', sha: null, message: 'Add patterns' })).status).toBe(200);
  });

  it.each([
    ['a file of `_global`', { file: '_global/learnings.yml' }, 400, 'file must be one of learnings.yml, suppressions.yml, patterns.yml'],
    ['a path into another folder', { file: '../../xdustinface/rust-dashcore/learnings.yml' }, 400, 'file must be one of learnings.yml, suppressions.yml, patterns.yml'],
    ['the append-only file', { file: 'metrics/fix-rate.jsonl' }, 400, 'file must be one of learnings.yml, suppressions.yml, patterns.yml'],
    ['content over 512 KB', { content: 'x'.repeat(512 * 1024 + 1) }, 413, 'content is over 524288 bytes'],
    ['a sha that is no blob sha', { sha: 'main' }, 400, 'sha must be the file\'s blob sha, or null for a new file'],
    ['no message', { message: '\n' }, 400, 'message must be a non-empty string'],
    ['no pr', { pr: undefined }, 400, 'pr must be a positive integer'],
  ])('refuses a write of %s', async (_case, change, status, error) => {
    const { state } = fakeMemory();
    expect(await call('write', { file: 'learnings.yml', content: '[]\n', sha: null, message: 'Add learning', ...change })).toEqual({ status, body: { error } });
    expect(state.writes).toEqual([]);
  });

  it('refuses a write that names another repository than the run\'s token', async () => {
    const { state } = fakeMemory();
    const response = await call('write', { repo: 'other', file: 'learnings.yml', content: '[]\n', sha: null, message: 'Add learning' });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain(`token is for ${OWNER}/${REPO}, requested ${OWNER}/other`);
    expect(state.writes).toEqual([]);
  });

  it('appends JSON lines, trying again when another run appended first', async () => {
    const { state } = fakeMemory({ [`${FOLDER}/metrics/fix-rate.jsonl`]: '{"pr":1}' });
    state.conflicts = 1;
    expect(await call('append', { file: 'metrics/fix-rate.jsonl', lines: ['{"pr":7}', '{"pr":8}'], message: 'Record fix rate' })).toEqual({ status: 200, body: { sha: sha(100) } });
    expect(state.store.get(`${FOLDER}/metrics/fix-rate.jsonl`)?.text).toBe('{"pr":1}\n{"pr":7}\n{"pr":8}\n');
    expect(state.writes).toHaveLength(2);
    // A missing file is created.
    expect((await call('append', { file: 'metrics/fix-rate.jsonl', lines: ['{"pr":9}'], message: 'Record fix rate' })).status).toBe(200);

    state.conflicts = 3;
    expect(await call('append', { file: 'metrics/fix-rate.jsonl', lines: ['{"pr":10}'], message: 'Record fix rate' }))
      .toEqual({ status: 409, body: { error: 'metrics/fix-rate.jsonl kept changing, try again' } });
  });

  it.each([
    ['no lines', [], 'lines must hold 1 to 10 lines'],
    ['11 lines', Array(11).fill('{}'), 'lines must hold 1 to 10 lines'],
    ['a line with a line break', ['{}\n{}'], 'each line must be a string of at most 16384 bytes without a line break'],
    ['a line over 16 KB', [`{"a":"${'x'.repeat(16 * 1024)}"}`], 'each line must be a string of at most 16384 bytes without a line break'],
    ['a line that is no JSON', ['pr 7'], 'each line must be JSON'],
    ['a line that is a JSON array', ['[7]'], 'each line must be a JSON object'],
  ])('refuses an append of %s', async (_case, lines, error) => {
    const { state } = fakeMemory();
    expect(await call('append', { file: 'metrics/fix-rate.jsonl', lines, message: 'Record fix rate' })).toEqual({ status: 400, body: { error } });
    expect(state.writes).toEqual([]);
  });

  it('appends to a file over 1 MB, which it reads as a blob', async () => {
    const big = `${'{"pr":1}\n'.repeat(150_000)}`;
    const { state } = fakeMemory({ [`${FOLDER}/metrics/fix-rate.jsonl`]: big });
    expect((await call('append', { file: 'metrics/fix-rate.jsonl', lines: ['{"pr":7}'], message: 'Record fix rate' })).status).toBe(200);
    expect(state.store.get(`${FOLDER}/metrics/fix-rate.jsonl`)?.text).toBe(`${big}{"pr":7}\n`);
  });

  it('refuses an append that would grow the file over 5 MB', async () => {
    const { state } = fakeMemory({ [`${FOLDER}/metrics/fix-rate.jsonl`]: `${'x'.repeat(5 * 1024 * 1024 - 5)}\n` });
    expect(await call('append', { file: 'metrics/fix-rate.jsonl', lines: ['{"pr":7}'], message: 'Record fix rate' }))
      .toEqual({ status: 413, body: { error: `metrics/fix-rate.jsonl would grow over ${5 * 1024 * 1024} bytes` } });
    expect(state.writes).toEqual([]);
  });

  it.each([
    ['a pull_request workflow', { event_name: 'pull_request' }, null, 'event pull_request is not workflow_dispatch'],
    ['a run its coordinator does not hold', {}, 'run 9000 is not active on this PR', 'run 9000 is not active on this PR'],
  ])('refuses %s before it touches the memory repository', async (_case, claims, refusal, reason) => {
    const { requests } = fakeMemory();
    const { env: refusing, checks } = dispatchedEnv(refusal);
    expect(await call('read', {}, { env: refusing, claims })).toEqual({ status: 403, body: { error: `Only the run Manki dispatched may use memory: ${reason}` } });
    expect(apiRequests(requests)).toEqual([]);
    expect(checks).toEqual(refusal === null ? [] : [[`${REPOSITORY_ID}:7`, DISPATCHED_RUN_ID, null, 'manki.yml', 'refs/heads/main']]);
    expect(logged(log, 'memory_refused')).toMatchObject([{ repository: FOLDER, pr: 7, operation: 'read', reason }]);
  });

  it('answers 503 without a memory repository, and 502 when GitHub fails', async () => {
    fakeMemory();
    expect(await call('read', {}, { env: { ...env, MEMORY_REPO: '' } })).toEqual({ status: 503, body: { error: 'no memory repository is configured' } });
    stubGitHub({ api: { [`GET /repos/${MEMORY}/installation`]: { status: 404 } } });
    expect(await call('read')).toEqual({ status: 503, body: { error: `the App is not installed on ${MEMORY}` } });
    stubGitHub({
      api: {
        [`GET /repos/${MEMORY}/installation`]: { body: { id: MEMORY_INSTALLATION, permissions: {} } },
        [`POST /app/installations/${MEMORY_INSTALLATION}/access_tokens`]: { status: 500 },
      },
    });
    expect((await call('read')).status).toBe(502);
    expect(logged(log, 'memory_error')).toHaveLength(1);
  });
});
