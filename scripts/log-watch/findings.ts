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

/** The messages that queue work, start it or end it, which the stuck work check reads over a longer span. */
export const QUEUE_MESSAGES = ['coordinator_receive', 'reconciler_caught_up', 'coordinator_dispatched', 'coordinator_finished'];

const MAX_LINES = 10;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
}

function where(source: Record<string, unknown>): string {
  const repo = text(source.repo ?? source.repository);
  const pr = source.pr === undefined ? '' : `#${text(source.pr)}`;
  const work = source.work_id === undefined ? '' : ` work ${text(source.work_id)}`;
  return `${repo}${pr}${work}`.trim();
}

function line(event: LogEvent, detail: string): string {
  const at = new Date(event.timestamp).toISOString().slice(11, 19);
  const place = where(event.source);
  return `${at} \`${text(event.source.msg)}\`${place ? ` ${place}` : ''}${detail ? `: ${detail}` : ''}`;
}

function isServerError(source: Record<string, unknown>): boolean {
  const status = typeof source.status === 'number' ? source.status : Number.NaN;
  return (status >= 500 && status < 600) || /\bwith 5\d\d\b/.test(text(source.error));
}

function finding(title: string, matches: Array<{ event: LogEvent; detail: string }>): Finding | null {
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => a.event.timestamp - b.event.timestamp);
  const lines = sorted.slice(0, MAX_LINES).map(({ event, detail }) => line(event, detail));
  if (sorted.length > MAX_LINES) lines.push(`and ${sorted.length - MAX_LINES} more`);
  const requestIds = [...new Set(sorted.map(({ event }) => event.$metadata.requestId).filter((id): id is string => !!id))];
  return { title: `${title} (${matches.length})`, lines, requestIds };
}

/**
 * Returns the warning signs in `signals`, the lines of the window, and the work in `queue` still waiting at `now`
 * after `STUCK_AFTER_MS`. Work ends when it is dispatched or finished, or when its PR closes, which drops it.
 */
export function findings(signals: LogEvent[], queue: LogEvent[], now: number): Finding[] {
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
    finding('Start errors', starts),
    finding('Failed note and comment writes', writes),
    finding('Runs the safety poll cancelled or queued again', cancels),
    finding('5xx statuses', serverErrors),
    finding('Work queued over 20 minutes without a dispatch', stuck(queue, now)),
  ].filter((entry): entry is Finding => entry !== null);
}

function stuck(queue: LogEvent[], now: number): Array<{ event: LogEvent; detail: string }> {
  const waiting = new Map<string, LogEvent>();
  for (const event of [...queue].sort((a, b) => a.timestamp - b.timestamp)) {
    const { source } = event;
    const pr = `${text(source.repo)}#${text(source.pr)}`;
    // A close drops the PR's queued work and can queue the work of a merge in the same line.
    if (source.msg === 'coordinator_receive' && text(source.effect).startsWith('closed')) {
      for (const key of waiting.keys()) if (key.startsWith(`${pr} `)) waiting.delete(key);
    }
    const queued = text(source.effect).match(/queued work (\d+)/);
    if (queued) waiting.set(`${pr} ${queued[1]}`, event);
    if ((source.msg === 'coordinator_dispatched' || source.msg === 'coordinator_finished') && source.work_id !== undefined) {
      waiting.delete(`${pr} ${text(source.work_id)}`);
    }
  }
  return [...waiting.entries()]
    .filter(([, event]) => now - event.timestamp > STUCK_AFTER_MS)
    .map(([key, event]) => ({
      event,
      detail: `work ${key.split(' ')[1]} waiting ${Math.round((now - event.timestamp) / 60_000)} minutes`,
    }));
}

/** The issue body for `found` in the window from `from` to `to`. */
export function issueBody(found: Finding[], from: number, to: number): string {
  const sections = found.map((entry) => [
    `### ${entry.title}`,
    '',
    ...entry.lines.map((entryLine) => `- ${entryLine}`),
    '',
    `Request ids: ${entry.requestIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
  ].join('\n'));
  return [
    `The Worker logged warning signs from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}. Filter Workers Logs on \`$metadata.requestId\` to read a request in full.`,
    '',
    ...sections.flatMap((section) => [section, '']),
    ISSUE_MARKER,
  ].join('\n');
}
