import {
  findings, ISSUE_MARKER, issueBody, LANES, type LogEvent, LOOKBACK_MS, publicRepositories, QUEUE_MESSAGES, repositories, SIGNAL_MESSAGES, windowStart,
} from './findings.ts';

declare const process: { env: Record<string, string | undefined> };

const PAGE = 2000;
const WORKFLOW = 'log-watch.yml';
const SERVICE = 'manki-token-service';
const TITLE = 'Worker logs show warning signs';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Reads every event matching `filters` from `from` to `to`, a page at a time. */
async function query(filters: unknown[], from: number, to: number): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  let offset: string | undefined;
  for (;;) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env('CF_ACCOUNT_ID')}/workers/observability/telemetry/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env('CF_LOGS_READ_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        queryId: 'log-watch',
        view: 'events',
        limit: PAGE,
        ...(offset && { offset }),
        timeframe: { from, to },
        parameters: {
          filterCombination: 'and',
          filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SERVICE }, ...filters],
        },
      }),
    });
    if (!response.ok) throw new Error(`the log query failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
    // A reply of another shape would read as a clean window and close the issue, so it fails the run.
    const reply = await response.json() as { success?: boolean; result?: { events?: { events?: unknown } } };
    const page = reply.result?.events?.events;
    if (reply.success !== true || !Array.isArray(page)) throw new Error('the log query returned no list of events');
    events.push(...page as LogEvent[]);
    if (page.length < PAGE) return events;
    const last = (page.at(-1) as { $metadata?: { id?: unknown } }).$metadata?.id;
    if (typeof last !== 'string' || last === '') throw new Error('a full page of log events has no id to read on from');
    offset = last;
  }
}

function githubFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

/** Calls the GitHub API on this repository. */
async function github(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await githubFetch(`/repos/${env('GITHUB_REPOSITORY')}${path}`, init);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}`);
  return response.json();
}


/** Returns when the last successful run of this workflow started, or null when it has none. */
async function lastRunStart(): Promise<number | null> {
  const { workflow_runs: runs } = await github(`/actions/workflows/${WORKFLOW}/runs?status=success&per_page=1`) as { workflow_runs?: Array<{ run_started_at?: string }> };
  if (!Array.isArray(runs)) throw new Error('the list of earlier runs has no runs');
  const started = Date.parse(runs[0]?.run_started_at ?? '');
  return Number.isNaN(started) ? null : started;
}

const to = Date.now();
const from = windowStart(to, await lastRunStart());
const signals = await query([{
  kind: 'group',
  filterCombination: 'or',
  filters: [
    { key: 'msg', operation: 'in', type: 'string', value: SIGNAL_MESSAGES.join(',') },
    {
      kind: 'group',
      filterCombination: 'and',
      filters: [
        { key: 'msg', operation: 'eq', type: 'string', value: 'coordinator_finished' },
        { key: 'status', operation: 'eq', type: 'string', value: 'timed_out' },
      ],
    },
    { key: 'status', operation: 'gte', type: 'number', value: 500 },
    { key: 'error', operation: 'regex', type: 'string', value: 'with 5[0-9][0-9]' },
  ],
}], from, to);
const queue = await query([{
  kind: 'group',
  filterCombination: 'or',
  filters: [
    { key: 'msg', operation: 'in', type: 'string', value: QUEUE_MESSAGES.join(',') },
    {
      kind: 'group',
      filterCombination: 'and',
      filters: [
        { key: 'msg', operation: 'eq', type: 'string', value: 'webhook' },
        { key: 'route', operation: 'in', type: 'string', value: LANES.join(',') },
      ],
    },
  ],
}], to - LOOKBACK_MS, to);
const publicRepos = await publicRepositories(repositories([...signals, ...queue]), (repo) => githubFetch(`/repos/${repo}`));
const found = findings(signals, queue, to, publicRepos);

const issues = await github(`/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}&per_page=100`) as Array<{ number: number; body: string | null }>;
const open = issues.find((issue) => issue.body?.includes(ISSUE_MARKER));
if (found.length > 0) {
  const body = issueBody(found, from, to);
  if (open) {
    await github(`/issues/${open.number}`, { method: 'PATCH', body: { body } });
    console.log(`Updated issue #${open.number}: ${found.map((entry) => entry.title).join(', ')}`);
  } else {
    const created = await github('/issues', { method: 'POST', body: { title: TITLE, body } }) as { number: number };
    console.log(`Opened issue #${created.number}: ${found.map((entry) => entry.title).join(', ')}`);
  }
} else if (open) {
  await github(`/issues/${open.number}/comments`, {
    method: 'POST',
    body: { body: `The window from ${new Date(from).toISOString()} to ${new Date(to).toISOString()} was clean.` },
  });
  await github(`/issues/${open.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  console.log(`Closed issue #${open.number}, the window was clean`);
} else {
  console.log('The window was clean');
}
