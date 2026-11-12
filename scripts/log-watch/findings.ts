/** One Workers Logs line, as the telemetry query returns it. */
export interface LogEvent {
  timestamp: number;
  source: Record<string, unknown>;
  $metadata: { requestId?: string };
}

/** A warning sign seen in the window: what it is, one line per occurrence, and the requests that logged it. */
export interface Finding {
  title: string;
  lines: string[];
  requestIds: string[];
  moreRequestIds: number;
}

/** Work queued longer than this without a dispatch or an end counts as stuck. */
export const STUCK_AFTER_MS = 20 * 60_000;

// A run reads back to the start of the last successful run, less this much for lines that reached the logs late. So the
// hourly run reads 75 minutes, and a late or dropped run leaves no gap.
const OVERLAP_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
/** The furthest back any query reads, also for stuck work. */
export const LOOKBACK_MS = 6 * HOUR_MS;

/** Returns where the window ending at `to` starts, given the start of the last successful run, if any. */
export function windowStart(to: number, lastRunStart: number | null): number {
  const usual = to - HOUR_MS - OVERLAP_MS;
  return Math.max(to - LOOKBACK_MS, lastRunStart === null ? usual : Math.min(usual, lastRunStart - OVERLAP_MS));
}

export const ISSUE_MARKER = '<!-- log-watch -->';

const FAILED_WRITES = new Set([
  'coordinator_conflict_note_failed',
  'coordinator_yielded_report_failed',
  'coordinator_starting_status_failed',
  'coordinator_cancel_report_failed',
  'coordinator_waiting_check_failed',
  'coordinator_reaction_failed',
  'coordinator_reaction_error',
]);

/** The messages the window query reads, besides timed out items and any line with a 5xx status or error. */
export const SIGNAL_MESSAGES = [
  'coordinator_start_error', ...FAILED_WRITES, 'coordinator_waiting_check_refused', 'coordinator_requeued', 'coordinator_cancel_failed',
];

/** The messages that queue, hold, start or end work, which the stuck work check reads over a longer span. */
export const QUEUE_MESSAGES = [
  'coordinator_receive', 'reconciler_caught_up', 'coordinator_held', 'coordinator_dispatched', 'coordinator_requeued', 'coordinator_finished',
];

/** The coordinator's lanes, each of which runs one item at a time. A routed `webhook` line names its lane as `route`. */
export const LANES = ['state', 'chat', 'help', 'settings'];

const MAX_LINES = 10;
const MAX_REQUEST_IDS = 50;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

function repositoryOf(source: Record<string, unknown>): string {
  return text(source.repo ?? source.repository);
}

/** Returns the repositories `events` name, whose visibility decides what the issue may show of them. */
export function repositories(events: LogEvent[]): string[] {
  return [...new Set(events.map((event) => repositoryOf(event.source)).filter((repo) => repo !== ''))];
}

interface Match {
  event: LogEvent;
  detail: string;
}

/**
 * Returns the names in `names` that GitHub shows as public, reading each with `read`. A name that is malformed, cannot
 * be read, or reads as anything but public counts as private.
 */
export async function publicRepositories(names: string[], read: (repo: string) => Promise<Response>): Promise<Set<string>> {
  const visible = await Promise.all(names.map(async (repo) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
    try {
      const response = await read(repo);
      return response.ok && (await response.json() as { private?: unknown }).private === false;
    } catch {
      return false;
    }
  }));
  return new Set(names.filter((_, index) => visible[index]));
}

/**
 * Writes one issue line. The issue is public, so only a line naming a repository known to be public shows the
 * repository, PR, work and detail. Any other line, also one naming no repository, whose detail can still quote one,
 * shows only its time and message.
 */
function line({ event, detail }: Match, publicRepos: ReadonlySet<string>): string {
  const at = new Date(event.timestamp).toISOString().slice(11, 19);
  const head = `${at} \`${text(event.source.msg)}\``;
  const repo = repositoryOf(event.source);
  if (!publicRepos.has(repo)) return repo === '' ? head : `${head} in a private repository`;
  const pr = event.source.pr === undefined ? '' : `#${text(event.source.pr)}`;
  const work = event.source.work_id === undefined ? '' : ` work ${text(event.source.work_id)}`;
  const place = `${repo}${pr}${work}`.trim();
  return `${head}${place ? ` ${place}` : ''}${detail ? `: ${detail}` : ''}`;
}

function isServerError(source: Record<string, unknown>): boolean {
  const status = typeof source.status === 'number' ? source.status : Number.NaN;
  return (status >= 500 && status < 600) || /\bwith 5\d\d\b/.test(text(source.error));
}

function finding(title: string, matches: Match[], publicRepos: ReadonlySet<string>): Finding | null {
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => a.event.timestamp - b.event.timestamp);
  const lines = sorted.slice(0, MAX_LINES).map((match) => line(match, publicRepos));
  if (sorted.length > MAX_LINES) lines.push(`and ${sorted.length - MAX_LINES} more`);
  const ids = [...new Set(sorted.map(({ event }) => event.$metadata.requestId).filter((id): id is string => !!id))];
  return { title: `${title} (${matches.length})`, lines, requestIds: ids.slice(0, MAX_REQUEST_IDS), moreRequestIds: Math.max(0, ids.length - MAX_REQUEST_IDS) };
}

/**
 * Returns the warning signs in `signals`, the lines of the window, and the work in `queue` still waiting at `now`
 * after `STUCK_AFTER_MS`. `publicRepos` are the repositories the issue may name.
 */
export function findings(signals: LogEvent[], queue: LogEvent[], now: number, publicRepos: ReadonlySet<string>): Finding[] {
  const starts = signals.filter((event) => event.source.msg === 'coordinator_start_error')
    .map((event) => ({ event, detail: text(event.source.error) }));
  // A waiting check GitHub forbids to end stays queued on its commit. One that is gone (404) leaves nothing behind.
  const forbidden = (source: Record<string, unknown>) => source.msg === 'coordinator_waiting_check_refused' && source.status === 403;
  const writes = signals.filter((event) => FAILED_WRITES.has(text(event.source.msg)) || forbidden(event.source))
    .map((event) => ({ event, detail: text(event.source.error ?? (event.source.status === undefined ? '' : `status ${text(event.source.status)}`)) }));
  const cancels = signals.filter((event) => event.source.msg === 'coordinator_requeued'
    || event.source.msg === 'coordinator_cancel_failed'
    || (event.source.msg === 'coordinator_finished' && event.source.status === 'timed_out'))
    .map((event) => ({ event, detail: text(event.source.note ?? event.source.reason) }));
  const serverErrors = signals.filter((event) => isServerError(event.source))
    .map((event) => ({ event, detail: text(event.source.error ?? `status ${text(event.source.status)}`) }));
  return [
    finding('Start errors', starts, publicRepos),
    finding('Failed note and comment writes', writes, publicRepos),
    finding('Runs the safety poll cancelled or queued again', cancels, publicRepos),
    finding('5xx statuses', serverErrors, publicRepos),
    finding('Work queued over 20 minutes without a dispatch', stuck(queue, now), publicRepos),
  ].filter((entry): entry is Finding => entry !== null);
}

interface Waiting {
  event: LogEvent;
  since: number;
  lane: string | null;
}

/**
 * Returns the work queued over `STUCK_AFTER_MS` that no dispatch, end or close of its PR followed. Work waiting while its
 * lane on the PR has a run going waits by design, and a review held by the hourly cap waits until the cap releases it.
 * `queue` holds the routed `webhook` lines too, which name the lane of each delivery. Work whose lane is unknown waits
 * by design while any lane of its PR has a run going.
 */
function stuck(queue: LogEvent[], now: number): Match[] {
  const lanes = new Map(queue.filter((event) => event.source.msg === 'webhook' && LANES.includes(text(event.source.route)))
    .map((event) => [text(event.source.delivery), text(event.source.route)]));
  const waiting = new Map<string, Waiting>();
  const running = new Map<string, string | null>();
  for (const event of [...queue].sort((a, b) => a.timestamp - b.timestamp)) {
    const { source } = event;
    if (source.msg === 'webhook') continue;
    const pr = `${repositoryOf(source)}#${text(source.pr)}`;
    const effect = text(source.effect);
    // A close drops the PR's queued work and can queue the work of a merge in the same line.
    if (source.msg === 'coordinator_receive' && effect.startsWith('closed')) {
      for (const key of waiting.keys()) if (key.startsWith(`${pr} `)) waiting.delete(key);
    }
    const queued = effect.match(/queued work (\d+)/);
    if (queued) {
      const lane = source.msg === 'reconciler_caught_up' ? 'state' : lanes.get(text(source.delivery)) ?? null;
      waiting.set(`${pr} ${queued[1]}`, { event, since: event.timestamp, lane });
    }
    if (source.work_id === undefined) continue;
    const key = `${pr} ${text(source.work_id)}`;
    if (source.msg === 'coordinator_dispatched') {
      waiting.delete(key);
      running.set(key, LANES.includes(text(source.lane)) ? text(source.lane) : null);
    } else if (source.msg === 'coordinator_finished') {
      waiting.delete(key);
      running.delete(key);
      // A settings box queues its review in the state lane, which only the settings item's note names.
      for (const [, id] of text(source.note).matchAll(/\b(?:again|deeper|draft) review work (\d+)/g)) {
        waiting.set(`${pr} ${id}`, { event, since: event.timestamp, lane: 'state' });
      }
    } else if (source.msg === 'coordinator_requeued') {
      waiting.set(key, { event, since: event.timestamp, lane: running.get(key) ?? null });
      running.delete(key);
    } else if (source.msg === 'coordinator_held') {
      const entry = waiting.get(key) ?? { event, since: event.timestamp, lane: null };
      waiting.set(key, { ...entry, since: Math.max(entry.since, Number(source.until) || 0) });
    }
  }
  const prOf = (key: string) => key.slice(0, key.lastIndexOf(' '));
  const busy = (key: string, lane: string | null) => [...running.entries()]
    .some(([runningKey, runningLane]) => prOf(runningKey) === prOf(key) && (lane === null || runningLane === null || runningLane === lane));
  return [...waiting.entries()]
    .filter(([key, { since, lane }]) => now - since > STUCK_AFTER_MS && !busy(key, lane))
    .map(([key, { event }]) => {
      const id = key.slice(key.lastIndexOf(' ') + 1);
      const minutes = `waiting ${Math.round((now - event.timestamp) / 60_000)} minutes`;
      // The line that queued the work names it only in its effect or note, unless it is the work's own line.
      return { event, detail: text(event.source.work_id) === id ? minutes : `work ${id} ${minutes}` };
    });
}

/** The issue body for `found` in the window from `from` to `to`. */
export function issueBody(found: Finding[], from: number, to: number): string {
  const sections = found.map((entry) => {
    const ids = entry.requestIds.map((id) => `\`${id}\``).join(', ') || 'none';
    return [
      `### ${entry.title}`,
      '',
      ...entry.lines.map((entryLine) => `- ${entryLine}`),
      '',
      `Request ids: ${ids}${entry.moreRequestIds > 0 ? `, and ${entry.moreRequestIds} more` : ''}`,
    ].join('\n');
  });
  return [
    `The Worker logged warning signs from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}. Filter Workers Logs on \`$metadata.requestId\` to read a request in full.`,
    '',
    ...sections.flatMap((section) => [section, '']),
    ISSUE_MARKER,
  ].join('\n');
}
