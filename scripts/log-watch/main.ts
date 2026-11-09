import { findings, ISSUE_MARKER, issueBody, type LogEvent, QUEUE_MESSAGES, SIGNAL_MESSAGES } from './findings.ts';

// Each run reads a bit more than the hour since the last, so a late scheduled run leaves no gap.
const WINDOW_MS = 75 * 60_000;
// Stuck work is looked for over a longer span, so work queued before the window still shows while it waits.
const QUEUE_SPAN_MS = 6 * 60 * 60_000;
const PAGE = 2000;
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
    const page = (await response.json() as { result: { events?: { events?: Array<LogEvent & { $metadata: { id: string } }> } } }).result.events?.events ?? [];
    events.push(...page);
    if (page.length < PAGE) return events;
    offset = page[page.length - 1].$metadata.id;
  }
}

async function github(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${env('GITHUB_REPOSITORY')}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}`);
  return response.json();
}

const to = Date.now();
const from = to - WINDOW_MS;
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
const queue = await query([{ key: 'msg', operation: 'in', type: 'string', value: QUEUE_MESSAGES.join(',') }], to - QUEUE_SPAN_MS, to);
const found = findings(signals, queue, to);

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
