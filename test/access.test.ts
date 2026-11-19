import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { RECONCILER_NAME } from '../src/reconciler';
import { dispatchedEnv, logged, OWNER, passInstallationCache, postToken, REPO, REPOSITORY_ID, RUNTIME_ENV, stubGitHub } from './helpers';

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  passInstallationCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/access', () => {
  const { env, checks } = dispatchedEnv();
  const ask = (body: Record<string, unknown>, options: Parameters<typeof postToken>[0] = {}) =>
    postToken({ env, path: '/access', body: { owner: OWNER, repo: REPO, ...body }, ...options });
  const answer = async (response: Response) => ({ status: response.status, body: await response.json() });

  it('tells the dispatched run whether an account is on the allow list of the repository in its token', async () => {
    stubGitHub();
    const registry = RUNTIME_ENV.RECONCILER.getByName(RECONCILER_NAME);
    await registry.allowAccount(REPOSITORY_ID, { id: 77, login: 'otto' }, 'maya');
    await registry.allowAccount(REPOSITORY_ID + 1, { id: 78, login: 'pia' }, 'maya');
    expect(await answer(await ask({ user_id: 77 }))).toEqual({ status: 200, body: { allowed: true } });
    // An account allowed only in another repository, and one allowed nowhere, are not allowed here.
    expect(await answer(await ask({ user_id: 78 }))).toEqual({ status: 200, body: { allowed: false } });
    expect(await answer(await ask({ user_id: 79 }))).toEqual({ status: 200, body: { allowed: false } });
    expect(checks.at(-1)?.[0]).toBe(`${REPOSITORY_ID}:7`);
    expect(logged(log, 'access_answered').map((line) => [line.user_id, line.pr, line.allowed])).toEqual([[77, 7, true], [78, 7, false], [79, 7, false]]);
    // Asking renames nothing, so the list keeps the account's login.
    expect((await registry.allowList(REPOSITORY_ID)).map((entry) => entry.login)).toContain('otto');
  });

  it('refuses a workflow that is not the run Manki dispatched, and a request without an OIDC token', async () => {
    stubGitHub();
    const { env: refusing } = dispatchedEnv('run 9000 is not active on this PR');
    expect(await answer(await ask({ user_id: 77 }, { env: refusing }))).toEqual({
      status: 403, body: { error: 'Only the run Manki dispatched may ask about access: run 9000 is not active on this PR' },
    });
    expect(logged(log, 'access_refused')).toMatchObject([{ user_id: 77, reason: 'run 9000 is not active on this PR' }]);
    expect((await ask({ user_id: 77 }, { token: null })).status).toBe(401);
  });

  it.each([
    ['no user id', {}],
    ['a user id given as a string', { user_id: '77' }],
    ['a user id that is no positive integer', { user_id: 1.5 }],
    ['a negative user id', { user_id: -77 }],
  ])('rejects a body with %s', async (_case, body) => {
    stubGitHub();
    expect((await ask(body)).status).toBe(400);
  });

  it('answers that the account is not allowed when the run or the allow list cannot be read', async () => {
    stubGitHub({ run: { status: 502 } });
    expect(await answer(await ask({ user_id: 77 }))).toEqual({ status: 200, body: { allowed: false } });
    stubGitHub();
    const broken = { getByName: () => ({ isAllowedAccount: async () => { throw new Error('storage is gone'); } }) } as unknown as Env['RECONCILER'];
    expect(await answer(await ask({ user_id: 77 }, { env: { ...env, RECONCILER: broken } }))).toEqual({ status: 200, body: { allowed: false } });
    expect(logged(log, 'access_failed').map((line) => line.error)).toEqual([
      expect.stringContaining('reading run 9000 failed with 502'), 'Error: storage is gone',
    ]);
  });
});
