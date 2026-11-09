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

export const ISSUE_MARKER = '<!-- log-watch -->';

const FAILED_WRITES = new Set([
  'coordinator_conflict_note_failed',
  'coordinator_starting_status_failed',
  'coordinator_cancel_report_failed',
  'coordinator_reaction_failed',
  'coordinator_reaction_error',
]);

/** The messages the window query reads, besides timed out items and any line with a 5xx status or error. */
export const SIGNAL_MESSAGES = ['coordinator_start_error', ...FAILED_WRITES, 'coordinator_requeued', 'coordinator_cancel_failed'];

/** The messages that queue, hold, start or end work, which the stuck work check reads over a longer span. */
export const QUEUE_MESSAGES = [
  'coordinator_receive', 'reconciler_caught_up', 'coordinator_held', 'coordinator_dispatched', 'coordinator_requeued', 'coordinator_finished',
];

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
 * Writes one issue line. The issue is public, so a line about a repository not known to be public names no repository,
 * PR or work, and leaves out the detail, which can quote it.
 */
function line({ event, detail }: Match, publicRepos: ReadonlySet<string>): string {
  const at = new Date(event.timestamp).toISOString().slice(11, 19);
  const head = `${at} \`${text(event.source.msg)}\``;
  const repo = repositoryOf(event.source);
  if (repo !== '' && !publicRepos.has(repo)) return `${head} in a private repository`;
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
  const writes = signals.filter((event) => FAILED_WRITES.has(text(event.source.msg)))
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

/**
 * Returns the work queued over `STUCK_AFTER_MS` that no dispatch, end or close of its PR followed. Work waiting while its
 * PR has a run going waits by design, and a review held by the hourly cap waits until the cap releases it.
 */
function stuck(queue: LogEvent[], now: number): Match[] {
  const waiting = new Map<string, { event: LogEvent; since: number }>();
  const running = new Set<string>();
  for (const event of [...queue].sort((a, b) => a.timestamp - b.timestamp)) {
    const { source } = event;
    const pr = `${repositoryOf(source)}#${text(source.pr)}`;
    const effect = text(source.effect);
    // A close drops the PR's queued work and can queue the work of a merge in the same line.
    if (source.msg === 'coordinator_receive' && effect.startsWith('closed')) {
      for (const key of waiting.keys()) if (key.startsWith(`${pr} `)) waiting.delete(key);
    }
    const queued = effect.match(/queued work (\d+)/);
    if (queued) waiting.set(`${pr} ${queued[1]}`, { event, since: event.timestamp });
    if (source.work_id === undefined) continue;
    const key = `${pr} ${text(source.work_id)}`;
    if (source.msg === 'coordinator_dispatched') {
      waiting.delete(key);
      running.add(key);
    } else if (source.msg === 'coordinator_finished') {
      waiting.delete(key);
      running.delete(key);
    } else if (source.msg === 'coordinator_requeued') {
      running.delete(key);
      waiting.set(key, { event, since: event.timestamp });
    } else if (source.msg === 'coordinator_held') {
      const entry = waiting.get(key) ?? { event, since: event.timestamp };
      waiting.set(key, { ...entry, since: Math.max(entry.since, Number(source.until) || 0) });
    }
  }
  const busy = new Set([...running].map((key) => key.slice(0, key.lastIndexOf(' '))));
  return [...waiting.entries()]
    .filter(([key, { since }]) => now - since > STUCK_AFTER_MS && !busy.has(key.slice(0, key.lastIndexOf(' '))))
    .map(([key, { event }]) => {
      const minutes = `waiting ${Math.round((now - event.timestamp) / 60_000)} minutes`;
      // A line that queued the work names it only in its effect.
      return { event, detail: event.source.work_id === undefined ? `work ${key.slice(key.lastIndexOf(' ') + 1)} ${minutes}` : minutes };
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
