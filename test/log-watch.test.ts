import { describe, expect, it, vi } from 'vitest';
import { findings, ISSUE_MARKER, issueBody, type LogEvent, LOOKBACK_MS, publicRepositories, repositories, STUCK_AFTER_MS, windowStart } from '../scripts/log-watch/findings';

const NOW = Date.parse('2026-11-09T09:00:00Z');
const MINUTE = 60_000;
const PR = { repo: 'manki-review/manki', pr: 1289 };
const PUBLIC = new Set(['manki-review/manki']);

let nextId = 0;
function event(minutesAgo: number, source: Record<string, unknown>): LogEvent {
  return { timestamp: NOW - minutesAgo * MINUTE, source: { ...PR, ...source }, $metadata: { requestId: `req-${nextId++}` } };
}

describe('findings', () => {
  it('sorts each warning sign under its title with its lines and request ids, and finds nothing in a clean window', () => {
    const signals = [
      event(30, { msg: 'coordinator_start_error', work_id: 2, error: 'Error: posting the conflict note failed with 403' }),
      event(20, { msg: 'coordinator_start_error', work_id: 2, error: 'Error: posting the conflict note failed with 403' }),
      event(25, { msg: 'coordinator_conflict_note_failed', error: 'Error: posting the conflict note failed with 403' }),
      event(24, { msg: 'coordinator_reaction_failed', comment_id: 7, status: 403 }),
      event(23, { msg: 'coordinator_finished', work_id: 3, status: 'timed_out', note: 'run went past its timeout, cancel requested' }),
      event(22, { msg: 'coordinator_finished', work_id: 4, status: 'done', note: 'run completed' }),
      event(21, { msg: 'coordinator_requeued', work_id: 5, reason: 'run never started' }),
      event(10, { msg: 'request_failed', status: 502, error: 'Memory append failed' }),
      event(9, { msg: 'coordinator_dispatch_error', work_id: 6, error: 'Error: dispatch failed with 503' }),
    ];
    expect(findings(signals, [], NOW, PUBLIC)).toEqual([
      {
        title: 'Start errors (2)',
        lines: [
          '08:30:00 `coordinator_start_error` manki-review/manki#1289 work 2: Error: posting the conflict note failed with 403',
          '08:40:00 `coordinator_start_error` manki-review/manki#1289 work 2: Error: posting the conflict note failed with 403',
        ],
        requestIds: ['req-0', 'req-1'],
        moreRequestIds: 0,
      },
      {
        title: 'Failed note and comment writes (2)',
        lines: [
          '08:35:00 `coordinator_conflict_note_failed` manki-review/manki#1289: Error: posting the conflict note failed with 403',
          '08:36:00 `coordinator_reaction_failed` manki-review/manki#1289: status 403',
        ],
        requestIds: ['req-2', 'req-3'],
        moreRequestIds: 0,
      },
      {
        title: 'Runs the safety poll cancelled or queued again (2)',
        lines: [
          '08:37:00 `coordinator_finished` manki-review/manki#1289 work 3: run went past its timeout, cancel requested',
          '08:39:00 `coordinator_requeued` manki-review/manki#1289 work 5: run never started',
        ],
        requestIds: ['req-4', 'req-6'],
        moreRequestIds: 0,
      },
      {
        title: '5xx statuses (2)',
        lines: [
          '08:50:00 `request_failed` manki-review/manki#1289: Memory append failed',
          '08:51:00 `coordinator_dispatch_error` manki-review/manki#1289 work 6: Error: dispatch failed with 503',
        ],
        requestIds: ['req-7', 'req-8'],
        moreRequestIds: 0,
      },
    ]);
    expect(findings([event(5, { msg: 'coordinator_finished', work_id: 4, status: 'done' })], [], NOW, PUBLIC)).toEqual([]);

    const many = Array.from({ length: 52 }, (_, index) => event(55 - index, { msg: 'coordinator_start_error', work_id: 9, error: 'Error: x' }));
    const [crowded] = findings(many, [], NOW, PUBLIC);
    expect(crowded.title).toBe('Start errors (52)');
    expect(crowded.lines).toHaveLength(11);
    expect(crowded.lines.at(-1)).toBe('and 42 more');
    expect(crowded.requestIds).toHaveLength(50);
    expect(crowded.moreRequestIds).toBe(2);
  });

  it('shows the repository, PR, work and detail of a line only for a repository known to be public', () => {
    const noRepo = { repo: undefined, pr: undefined };
    const signals = [
      event(10, { msg: 'coordinator_start_error', repo: 'acme/secret', pr: 7, work_id: 2, error: 'Error: reading acme/secret failed with 403' }),
      event(9, { msg: 'request_failed', repo: undefined, repository: 'acme/secret', status: 502, error: 'Memory append failed' }),
      // A line naming no repository can still quote one, as the cron's own catch-up error does.
      event(8, { msg: 'reconciler_catch_up_error', ...noRepo, error: 'Error: listing pull requests of acme/secret failed with 502' }),
      event(7, { msg: 'coordinator_start_error', ...noRepo, pr: 7, work_id: 4, error: 'Error: acme/secret' }),
      event(6, { msg: 'coordinator_start_error', work_id: 3, error: 'Error: x' }),
    ];
    const queue = [
      event(40, { msg: 'coordinator_receive', repo: 'acme/secret', pr: 7, effect: 'queued work 5' }),
      event(30, { msg: 'coordinator_receive', ...noRepo, pr: 7, effect: 'queued work 6' }),
    ];
    expect(repositories([...signals, ...queue])).toEqual(['acme/secret', 'manki-review/manki']);
    const found = findings(signals, queue, NOW, PUBLIC);
    expect(found.map((entry) => [entry.title, entry.lines])).toEqual([
      ['Start errors (3)', [
        '08:50:00 `coordinator_start_error` in a private repository',
        '08:53:00 `coordinator_start_error`',
        '08:54:00 `coordinator_start_error` manki-review/manki#1289 work 3: Error: x',
      ]],
      ['5xx statuses (2)', ['08:51:00 `request_failed` in a private repository', '08:52:00 `reconciler_catch_up_error`']],
      ['Work queued over 20 minutes without a dispatch (2)', ['08:20:00 `coordinator_receive` in a private repository', '08:30:00 `coordinator_receive`']],
    ]);
    // The request ids, which name nothing, are kept for every line.
    expect(found.flatMap((entry) => entry.requestIds)).toHaveLength(7);
    const body = issueBody(found, NOW - 75 * MINUTE, NOW);
    for (const leak of ['acme', 'secret', '#7', 'work 2', 'work 4', 'work 5', 'work 6', 'listing']) expect(body).not.toContain(leak);
  });

  it('counts a repository as public only when GitHub reads it as public', async () => {
    const read = vi.fn(async (repo: string): Promise<Response> => {
      if (repo === 'acme/open') return Response.json({ private: false });
      if (repo === 'acme/closed') return Response.json({ private: true });
      if (repo === 'acme/odd') return Response.json({});
      if (repo === 'acme/flaky') throw new TypeError('Network connection lost');
      if (repo === 'acme/broken') return new Response('{', { status: 200 });
      if (repo === 'acme/down') return Response.json({ private: false }, { status: 502 });
      return Response.json({ message: 'Not Found' }, { status: 404 });
    });
    const names = ['acme/open', 'acme/closed', 'acme/odd', 'acme/flaky', 'acme/broken', 'acme/down', 'acme/gone', 'acme/../x y'];
    expect(await publicRepositories(names, read)).toEqual(new Set(['acme/open']));
    expect(read).not.toHaveBeenCalledWith('acme/../x y');
  });

  it('reports work queued longer than 20 minutes that no dispatch, end or close followed', () => {
    const stuckMinutes = STUCK_AFTER_MS / MINUTE + 1;
    const queue = [
      event(60, { msg: 'coordinator_receive', effect: 'queued work 1' }),
      event(55, { msg: 'coordinator_dispatched', work_id: 1 }),
      event(52, { msg: 'coordinator_finished', work_id: 1, status: 'done' }),
      event(50, { msg: 'coordinator_receive', effect: 'queued work 2' }),
      event(45, { msg: 'coordinator_finished', work_id: 2, status: 'skipped' }),
      event(40, { msg: 'coordinator_receive', effect: 'queued work 3' }),
      event(39, { msg: 'coordinator_receive', effect: 'merged into work 3' }),
      event(stuckMinutes, { msg: 'reconciler_caught_up', effect: 'queued work 4' }),
      event(10, { msg: 'coordinator_receive', effect: 'queued work 5' }),
      // The same work id on another PR is other work.
      event(30, { msg: 'coordinator_receive', effect: 'queued work 1', pr: 1290 }),
      // A close drops the queued work and queues the merge's.
      event(35, { msg: 'coordinator_receive', effect: 'queued work 7', pr: 1291 }),
      event(34, { msg: 'coordinator_receive', effect: 'closed, dropped 1, queued work 8', pr: 1291 }),
      // Work behind a run of its PR waits by design, until the run ends.
      event(50, { msg: 'coordinator_dispatched', work_id: 1, pr: 1292 }),
      event(45, { msg: 'coordinator_receive', effect: 'queued work 2', pr: 1292 }),
      event(50, { msg: 'coordinator_dispatched', work_id: 1, pr: 1293 }),
      event(45, { msg: 'coordinator_receive', effect: 'queued work 2', pr: 1293 }),
      event(30, { msg: 'coordinator_finished', work_id: 1, pr: 1293, status: 'done' }),
      // A review held by the hourly cap waits until the cap releases it.
      event(50, { msg: 'coordinator_receive', effect: 'queued work 1', pr: 1294 }),
      event(49, { msg: 'coordinator_held', work_id: 1, pr: 1294, until: NOW - 10 * MINUTE }),
      // A run that never started is queued again and waits anew.
      event(30, { msg: 'coordinator_requeued', work_id: 1, pr: 1295, reason: 'run never started' }),
      // A run in one lane holds only that lane. The routed `webhook` line names the lane of a delivery, and work in a lane
      // no line names waits while any lane of its PR runs.
      event(50, { msg: 'coordinator_dispatched', work_id: 1, pr: 1296, lane: 'state' }),
      event(45, { msg: 'webhook', route: 'chat', delivery: 'd-chat', pr: 1296, repo: undefined }),
      event(45, { msg: 'coordinator_receive', effect: 'queued work 2', delivery: 'd-chat', pr: 1296 }),
      event(44, { msg: 'webhook', route: 'state', delivery: 'd-reply', pr: 1296, repo: undefined }),
      event(44, { msg: 'coordinator_receive', effect: 'queued work 3', delivery: 'd-reply', pr: 1296 }),
      event(43, { msg: 'coordinator_receive', effect: 'queued work 4', delivery: 'd-unknown', pr: 1296 }),
      // A settings box queues its review in the state lane, named only in the settings item's note.
      event(40, { msg: 'coordinator_finished', work_id: 1, pr: 1297, status: 'done', note: 'paused, again review work 2' }),
      event(38, { msg: 'coordinator_finished', work_id: 3, pr: 1297, status: 'done', note: 'deeper review work 4' }),
      event(37, { msg: 'coordinator_dispatched', work_id: 4, pr: 1297, lane: 'state' }),
      event(36, { msg: 'coordinator_finished', work_id: 4, pr: 1297, status: 'done' }),
    ];
    const [stuck] = findings([], queue, NOW, PUBLIC);
    expect(stuck.title).toBe('Work queued over 20 minutes without a dispatch (8)');
    expect(stuck.lines).toEqual([
      '08:15:00 `coordinator_receive` manki-review/manki#1293: work 2 waiting 45 minutes',
      '08:15:00 `coordinator_receive` manki-review/manki#1296: work 2 waiting 45 minutes',
      '08:20:00 `coordinator_receive` manki-review/manki#1289: work 3 waiting 40 minutes',
      '08:20:00 `coordinator_finished` manki-review/manki#1297 work 1: work 2 waiting 40 minutes',
      '08:26:00 `coordinator_receive` manki-review/manki#1291: work 8 waiting 34 minutes',
      '08:30:00 `coordinator_receive` manki-review/manki#1290: work 1 waiting 30 minutes',
      '08:30:00 `coordinator_requeued` manki-review/manki#1295 work 1: waiting 30 minutes',
      '08:39:00 `reconciler_caught_up` manki-review/manki#1289: work 4 waiting 21 minutes',
    ]);
  });

  it('reads back to the last successful run, at least 75 minutes and at most the lookback', () => {
    expect(windowStart(NOW, null)).toBe(NOW - 75 * MINUTE);
    expect(windowStart(NOW, NOW - 60 * MINUTE)).toBe(NOW - 75 * MINUTE);
    expect(windowStart(NOW, NOW - 10 * MINUTE)).toBe(NOW - 75 * MINUTE);
    // After a late or dropped run, the window reaches back to the run before it, so no line goes unread.
    expect(windowStart(NOW, NOW - 3 * 60 * MINUTE)).toBe(NOW - 195 * MINUTE);
    expect(windowStart(NOW, NOW - 10 * 60 * MINUTE)).toBe(NOW - LOOKBACK_MS);
  });

  it('writes an issue body with the window, each sign and the marker the watcher finds the issue by', () => {
    const found = findings([event(5, { msg: 'coordinator_start_error', work_id: 2, error: 'Error: boom' })], [], NOW, PUBLIC);
    const body = issueBody(found, NOW - 75 * MINUTE, NOW);
    expect(body).toBe([
      'The Worker logged warning signs from 2026-11-09T07:45:00.000Z to 2026-11-09T09:00:00.000Z. Filter Workers Logs on `$metadata.requestId` to read a request in full.',
      '',
      '### Start errors (1)',
      '',
      '- 08:55:00 `coordinator_start_error` manki-review/manki#1289 work 2: Error: boom',
      '',
      `Request ids: \`${found[0].requestIds[0]}\``,
      '',
      ISSUE_MARKER,
    ].join('\n'));
  });
});
