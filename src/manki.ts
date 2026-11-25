import { minimatch } from 'minimatch';
import { parse } from 'yaml';

// Ports of the pure checks Manki runs on an event before it does any work. Each mirrors the function of the same
// name in manki `src/interaction.ts`, `src/index.ts`, `src/config.ts`, `src/github.ts` or `src/review-record.ts`. A
// change there must be made here too, or the Worker drops an event the action would have handled.

export const BOT_LOGIN = 'manki-review[bot]';

/** The logins Manki's own comments carry: the App, or `github-actions[bot]` when a run had no App token. */
export const MANKI_LOGINS: readonly string[] = [BOT_LOGIN, 'github-actions[bot]'];

/** Whether a GraphQL login is one of Manki's. GraphQL names a bot `<slug>`, while REST and webhooks use `<slug>[bot]`. */
export function isMankiGraphqlLogin(login: string | undefined): boolean {
  return login !== undefined && MANKI_LOGINS.includes(`${login}[bot]`);
}

/** The marker every comment and review comment Manki writes carries. */
export const MANKI_COMMENT_MARKER = '<!-- manki';

/** The marker of Manki's progress comment. */
export const BOT_MARKER = '<!-- manki-bot -->';

/** Opens the round record of a review body. Manki writes it below all text that quotes code and model text. */
const RECORD_OPENER = '<!-- manki-context';

/**
 * The lines of the review `body` that Manki itself wrote: those below the last round record, or all of them when the body
 * holds no record. A line above the record can quote code and model text.
 */
function ownLines(body: string): string[] {
  const lines = body.split('\n');
  const record = lines.map((line) => line.startsWith(RECORD_OPENER) && line.includes('-->')).lastIndexOf(true);
  return lines.slice(record + 1);
}

/** Whether Manki itself wrote the flag `marker` in the review `body`, on a line of its own. */
export function hasOwnMarker(body: string, marker: string): boolean {
  return ownLines(body).some((line) => line.trimEnd() === marker);
}

/** The footer line of a Manki review that links the commit it reviewed. */
const REVIEWED_COMMIT_LINE = /^- Reviewed \[`[0-9a-f]{7}`\]\(\S+\/commit\/([0-9a-f]{40})\)/;
/** Opens the marker that names the head an approval without a round approves. */
const HEAD_MARKER_OPENER = '<!-- manki-auto-approve-head: ';
/** Opens the record of an approval decision. Its `head` is the approved commit. */
const APPROVAL_RECORD_OPENER = '<!-- manki-approval-record: ';

/** Returns what the hidden marker with `opener` holds when `line` starts with it and closes it. */
function markerText(line: string, opener: string): string | undefined {
  if (!line.startsWith(opener) || !line.includes('-->', opener.length)) return undefined;
  return line.slice(opener.length, line.indexOf('-->', opener.length)).trimEnd();
}

/** Returns the full commit hash that `line` of a Manki review body names: in the footer, the head marker or the approval record. */
function commitNamedBy(line: string): string | undefined {
  const record = markerText(line, APPROVAL_RECORD_OPENER);
  let named: unknown = line.match(REVIEWED_COMMIT_LINE)?.[1] ?? markerText(line, HEAD_MARKER_OPENER);
  try {
    if (record) named = (JSON.parse(record) as { head?: unknown }).head;
  } catch {
    // A record that does not parse names no commit.
  }
  return typeof named === 'string' && /^[0-9a-f]{40}$/.test(named) ? named : undefined;
}

/**
 * Returns the commit a Manki review gave its verdict on, or `undefined` when its `body` names no full commit hash. The
 * last line that names a commit decides, which Manki writes below all text it quotes. GitHub's commit of a review never
 * counts, since GitHub moves it to the new head when a push leaves the PR's change as it was.
 */
export function reviewedCommit(body: string): string | undefined {
  const lines = body.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const named = commitNamedBy(lines[i]);
    if (named) return named;
  }
  return undefined;
}

/** Opens the marker of a Manki review without a verdict that limits stopped. It holds the time at which they lift. */
const RETRY_AFTER_OPENER = '<!-- manki-retry-after: ';
/** The time in the marker, as JavaScript's `toISOString` writes it. */
const RETRY_AFTER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Returns when the limits that stopped the Manki review `body` lift, in milliseconds since the epoch, or `undefined` when
 * Manki itself named no such time. Manki's `postReview` writes the marker on a review without a verdict.
 */
export function retryAfter(body: string): number | undefined {
  const time = ownLines(body).map((line) => markerText(line, RETRY_AFTER_OPENER)).filter((text) => text !== undefined).at(-1);
  return time && RETRY_AFTER_TIME.test(time) ? Date.parse(time) : undefined;
}

/** The answer to a help command, as Manki's `handleHelp` posts it. */
export const HELP_REPLY = [
  '| Command | What it does |',
  '|---|---|',
  '| `/manki review` | Reviews the head commit unless Manki\'s newest review of it is complete. Tick the review box in the settings block to review it again |',
  '| `/manki explain [topic]` | Explains something about this PR |',
  '| `/manki check` | Checks for open blocking threads and approves when there are none |',
  '| `/manki dismiss [finding]` | Dismisses a finding |',
  '| `/manki remember <instruction>` | Stores an instruction for future reviews |',
  '| `/manki forget <text>` | Removes a learning or suppression |',
  '| `/manki allow @<login>` | Lets an account without write access use Manki in this repository. Needs the `maintain` or `admin` role |',
  '| `/manki disallow @<login>` | Takes that back. Needs the `maintain` or `admin` role |',
  '| `/manki allowed` | Lists the accounts allowed to use Manki here, for anyone with write access or on that list |',
  '| `/manki help` | Shows this message |',
  '',
  '`@manki-review` works as the prefix too. A reply to a Manki review comment gets an answer in its thread.',
  '',
  '<!-- manki -->',
].join('\n');

const BOT_MENTION_PATTERN = /(?:@manki-review|@manki|\/manki)\b/;
const BOT_PREFIX_PATTERN = /(?:@manki-review|@manki|\/manki)\s+(explain|dismiss|help|remember|forget|check)(?:\s+(.*))?/;

export type CommandType = 'explain' | 'dismiss' | 'help' | 'remember' | 'forget' | 'check' | 'generic';

export function hasBotMention(body: string): boolean {
  return BOT_MENTION_PATTERN.test(body.toLowerCase());
}

function textAfterMentions(body: string): string | null {
  const lower = body.toLowerCase();
  if (!BOT_MENTION_PATTERN.test(lower)) return null;
  return lower.replace(new RegExp(BOT_MENTION_PATTERN.source, 'g'), '');
}

export function isReviewRequest(body: string): boolean {
  const rest = textAfterMentions(body);
  return rest !== null && /\breview\b/.test(rest);
}

export function isBotMentionNonReview(body: string): boolean {
  const rest = textAfterMentions(body);
  return rest !== null && !/\breview\b/.test(rest);
}

/** Returns the type of the first command in `body`. A command quoted in inline code or a code block is text. */
export function parseCommandType(body: string): CommandType {
  const lower = body.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, ' ').toLowerCase();
  const match = lower.match(BOT_PREFIX_PATTERN);
  return match ? (match[1] as CommandType) : 'generic';
}

/** A command that changes or lists the accounts a maintainer allowed to use Manki. The Worker answers it with no run. */
export type AccessCommand = { command: 'allow' | 'disallow'; login: string | null } | { command: 'allowed' };

// The Worker's own commands, which Manki does not know. A GitHub login holds letters, digits and single hyphens.
const ACCESS_PATTERN = /(?:@manki-review|@manki|\/manki)\s+(allowed|allow|disallow)(?![\w-])(?:[ \t]+@?([a-z\d](?:[a-z\d-]{0,38}))(?![\w-]))?/;

/** Returns the access command of `body`, or null when it holds none. A command quoted in inline code or a code block is text. */
export function parseAccessCommand(body: string): AccessCommand | null {
  const match = body.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, ' ').toLowerCase().match(ACCESS_PATTERN);
  if (!match) return null;
  return match[1] === 'allowed' ? { command: 'allowed' } : { command: match[1] as 'allow' | 'disallow', login: match[2] ?? null };
}

/** The skip rules of a base branch's `.manki.yml`. */
export interface SkipRules {
  skip_labels: string[];
  skip_authors: string[];
  skip_branches: string[];
}

const SKIP_KEYS = ['skip_labels', 'skip_authors', 'skip_branches'] as const;

/** A `.manki.yml` as parsed, or null when it does not parse to a mapping. */
export type BaseConfig = Record<string, unknown> | null;

/** Parses a `.manki.yml`. A file that does not parse, or not to a mapping, gives null, which sets nothing. */
export function parseConfig(text: string): BaseConfig {
  let root: unknown;
  try {
    root = parse(text);
  } catch {
    return null;
  }
  return root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : null;
}

/**
 * Returns the skip rules `config` sets, as Manki's `loadSkipRules` reads them. Null when it sets none or sets one that
 * is not a list of non-empty strings.
 */
export function skipRulesOf(config: BaseConfig): SkipRules | null {
  if (config === null) return null;
  const given = SKIP_KEYS.filter((key) => Object.hasOwn(config, key));
  if (given.length === 0) return null;
  const valid = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
  if (!given.every((key) => valid(config[key]))) return null;
  return { skip_labels: [], skip_authors: [], skip_branches: [], ...Object.fromEntries(given.map((key) => [key, config[key]])) };
}

/** Whether `config` asks for automatic reviews of drafts with `drafts: review`. Any other value skips them, as in Manki. */
export function reviewsDrafts(config: BaseConfig): boolean {
  return config?.drafts === 'review';
}

/**
 * Whether `config` is known to leave automatic reviews of a push on. A config that could not be read (null) is not, and
 * neither is an `auto_review` that is not `true`.
 */
export function autoReviewIsOn(config: BaseConfig): boolean {
  return config !== null && (config.auto_review === undefined || config.auto_review === true);
}

export interface SkipFacts {
  labels: string[];
  author?: string;
  /** Who caused the event, such as who pushed. */
  sender?: string;
  branch: string;
  /** Whether the head branch lives in a fork, where anyone can pick its name. */
  fromFork: boolean;
}

/** Returns which skip rule the PR matches, such as `label "dependencies"`, or null when none does. */
export function matchSkipRule(rules: SkipRules, facts: SkipFacts): string | null {
  const lower = (values: string[]) => values.map((value) => value.toLowerCase());
  // A fork's author can push after a skip label is added, so only labels on the repo's own branches count.
  const label = !facts.fromFork && facts.labels.find((name) => lower(rules.skip_labels).includes(name.toLowerCase()));
  if (label) return `label "${label}"`;
  // A writer can push to a bot's PR, so the event's sender must match too.
  const skippedAuthor = (login: string | undefined) => !!login && lower(rules.skip_authors).includes(login.toLowerCase());
  if (skippedAuthor(facts.author) && (facts.sender === undefined || skippedAuthor(facts.sender))) return `author ${facts.author}`;
  // Only writers can push a branch to the repo itself, while a fork's author names its branch freely.
  const branch = !facts.fromFork && rules.skip_branches.find((pattern) => minimatch(facts.branch, pattern));
  if (branch) return `branch ${facts.branch}`;
  return null;
}

/** Marks the progress comment that carries the settings boxes. */
export const SETTINGS_MARKER = '<!-- manki-settings -->';
/** Marks a progress comment whose review finished, and one whose run was cancelled, as Manki writes them. */
export const REVIEW_COMPLETE_MARKER = '<!-- manki-review-complete -->';
export const CANCELLED_MARKER = '<!-- manki-review-cancelled -->';

// Manki's settings block: a rule, the status line, one line per box, the marker, and hidden markers others appended.
const SETTINGS_BLOCK = /(?:^|\n+)---\n((?:Last reviewed `[0-9a-f]+`|Not reviewed yet) · head `[0-9a-f]+` · )[^\n]*\n((?:- \[[ xX]\] [^\n]*\n)*)<!-- manki-settings -->((?:\n<!-- [^\n]* -->)*)\s*$/;

/** Whether `body` is Manki's progress comment of a review that has not ended. */
export function isRunningProgress(body: string): boolean {
  return body.includes(BOT_MARKER) && /\*\*Review (?:started|in progress)\*\*/.test(body)
    && !body.includes(REVIEW_COMPLETE_MARKER) && !body.includes(CANCELLED_MARKER);
}

/**
 * Returns the progress comment `body` marked as cancelled with `headline`, such as "Review cancelled by `@alice`.", as
 * Manki's `markProgressCommentCancelled` writes it: the original progress folded away, and the settings block kept with
 * the status "review cancelled" and no Cancel box.
 */
export function cancelledProgress(body: string, headline: string): string {
  const block = SETTINGS_BLOCK.exec(body);
  const progress = (block ? body.slice(0, block.index) : body).trim();
  const text = [`**${headline}**`, '', '<details><summary>Original progress</summary>', '', progress, '', '</details>'].join('\n');
  const cancelled = `${text}\n\n${CANCELLED_MARKER}`;
  if (!block) return cancelled;
  const boxes = block[2].split('\n').filter((line) => line && !line.includes('<!-- manki-box:cancel -->'));
  return [`${cancelled}\n\n---`, `${block[1]}review cancelled`, ...boxes, `${SETTINGS_MARKER}${block[3]}`].join('\n');
}

/** Returns the labels the settings block of `body` shows for `boxes`, in that order. A box it does not show is left out. */
export function boxLabels(body: string, boxes: readonly string[]): string[] {
  const lines = SETTINGS_BLOCK.exec(body)?.[2] ?? '';
  return boxes.flatMap((box) => new RegExp(`^[ \\t]*[-*] \\[[ xX]\\] (.+?) <!-- manki-box:${box} -->`, 'm').exec(lines)?.[1] ?? []);
}

export type SettingsBox = 'pause' | 'again' | 'deeper' | 'cancel' | 'draft' | 'auto';

/** The boxes that ask for one review, as the `modes` of that review. */
export type ReviewMode = Extract<SettingsBox, 'again' | 'deeper' | 'draft'>;

export const REVIEW_MODES: readonly ReviewMode[] = ['again', 'deeper', 'draft'];

/** The boxes the Worker writes itself, with the labels Manki's `renderSettingsBlock` gives them on a PR without a review. */
const BOX_LABELS = { again: 'Review now', deeper: 'Deeper review', draft: 'Review this draft', auto: 'Review every push' } satisfies Partial<Record<SettingsBox, string>>;

type WrittenBox = keyof typeof BOX_LABELS;

const boxLine = (box: WrittenBox): string => `- [ ] ${BOX_LABELS[box]} <!-- manki-box:${box} -->`;

/**
 * Returns the settings block of a PR that has no review yet, with `status` and `boxes` unticked. Manki reads the block
 * and writes it again, so it is what `renderSettingsBlock` in manki `src/settings.ts` returns, byte for byte.
 */
export function renderSettingsBlock(head: string, status: string, boxes: readonly WrittenBox[]): string {
  return ['---', `Not reviewed yet · head \`${head.slice(0, 7)}\` · ${status}`, ...boxes.map(boxLine), SETTINGS_MARKER].join('\n');
}

/** Returns `body` with each box a draft has that its settings block lacks added to the block, unticked. */
export function withDraftBoxes(body: string): string {
  const block = SETTINGS_BLOCK.exec(body);
  if (!block) return body;
  const missing = (['draft', 'auto'] as const).map(boxLine).filter((line) => !block[2].includes(line.slice(line.indexOf('<!--'))));
  const at = body.lastIndexOf(SETTINGS_MARKER);
  return body.slice(0, at) + missing.map((line) => `${line}\n`).join('') + body.slice(at);
}

/** Returns the head commit the settings block of `body` names, as Manki writes it, or null without a block. */
export function settingsHead(body: string): string | null {
  return SETTINGS_BLOCK.exec(body)?.[1].match(/head `([0-9a-f]+)`/)?.[1] ?? null;
}

/**
 * Returns `body` with the status of its settings block set to `status` and the boxes in `untick` cleared. With `head`,
 * the status line names that commit as the head, as Manki writes it.
 */
export function withSettingsStatus(body: string, status: string, untick: SettingsBox[], head?: string): string {
  const block = SETTINGS_BLOCK.exec(body);
  if (!block) return body;
  const lines = body.slice(block.index).split('\n');
  const at = lines.findIndex((line) => line.startsWith(block[1]));
  const prefix = head ? block[1].replace(/head `[0-9a-f]+`/, `head \`${head.slice(0, 7)}\``) : block[1];
  lines[at] = `${prefix}${status}`;
  return setBoxes(body.slice(0, block.index) + lines.join('\n'), untick.map((box) => ({ box, ticked: false })));
}

/** A box whose tick changed in an edit. */
export interface BoxChange {
  box: SettingsBox;
  ticked: boolean;
}

// A box is a task list line that ends with its hidden id, so the label can change without touching the Worker.
const BOX_LINE = /^([ \t]*[-*] \[)([ xX])(\] .*<!-- manki-box:(pause|again|deeper|cancel|draft|auto) -->[ \t]*)$/gm;

function boxStates(body: string): Map<SettingsBox, boolean> {
  const states = new Map<SettingsBox, boolean>();
  for (const match of body.matchAll(BOX_LINE)) states.set(match[4] as SettingsBox, match[2] !== ' ');
  return states;
}

/** Returns the boxes whose tick differs between `before` and `after`. A box missing from either side is no change. */
export function changedBoxes(before: string, after: string): BoxChange[] {
  const old = boxStates(before);
  return [...boxStates(after)]
    .filter(([box, ticked]) => old.has(box) && old.get(box) !== ticked)
    .map(([box, ticked]) => ({ box, ticked }));
}

// A finding's issue box: a task list line that ends with the finding's id.
const ISSUE_BOX_LINE = /^[ \t]*[-*] \[([ xX])\] .*<!-- manki-box:issue:(.+?) -->[ \t]*$/gm;

function issueBoxStates(body: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const match of body.matchAll(ISSUE_BOX_LINE)) states.set(match[2], match[1] !== ' ');
  return states;
}

/** Returns the ids of the issue boxes that are ticked in `after` and were unticked in `before`. */
export function tickedIssueBoxes(before: string, after: string): string[] {
  const old = issueBoxStates(before);
  return [...issueBoxStates(after)].filter(([id, ticked]) => ticked && old.get(id) === false).map(([id]) => id);
}

/** Returns `body` with each box in `changes` set to its `ticked`. */
export function setBoxes(body: string, changes: BoxChange[]): string {
  const wanted = new Map(changes.map(({ box, ticked }) => [box, ticked]));
  return body.replace(BOX_LINE, (line, start: string, _tick: string, end: string, box: SettingsBox) =>
    wanted.has(box) ? `${start}${wanted.get(box) ? 'x' : ' '}${end}` : line);
}

/** Starts the line above each box Manki puts into a message for the next step it names, as Manki's `BOX_ANCHOR`. */
const MESSAGE_BOX_ANCHOR = '<!-- manki-issue-box -->';

/**
 * The boxes Manki puts into a message other than the settings block, as its `MessageBox`, and the Worker's `allow` box
 * in its reply to a refused command, whose id is the user id of the account it allows.
 */
export type MessageBox = 'again' | 'check' | 'forget' | 'dismiss' | 'allow';

const MESSAGE_BOXES: readonly string[] = ['again', 'check', 'forget', 'dismiss', 'allow'] satisfies MessageBox[];

/** Marks the Worker's reply to a refused command, the only comment whose allow box counts. */
export const REFUSAL_MARKER = '<!-- manki-refusal -->';

/** The label of an allow box, which names the login it allows. */
const ALLOW_LABEL = /^Allow @([A-Za-z\d](?:[A-Za-z\d-]{0,38})) to use Manki in this repository$/;

/** Returns the box that allows the account `login`, with user id `id`, to use Manki in the repository. */
export function allowBox(id: number, login: string): string {
  return `${MESSAGE_BOX_ANCHOR}\n- [ ] Allow @${login} to use Manki in this repository <!-- manki-box:allow:${id} -->`;
}

/** A message box ticked in an edit, with the id of what it acts on, such as a learning, when it has one. */
export interface MessageTick {
  box: MessageBox;
  id?: string;
  /** For an allow box, the login its label names, which must be the one refused under its id. */
  login?: string;
}

// Manki's `BOX_LINE` in `src/issue-box.ts`, with the tick and the label taken apart.
const ANCHORED_BOX_LINE = /^([ \t]*[-*] \[)([ xX])(\] (.*)<!-- manki-box:([a-z]+)(?::(.+?))? -->[ \t]*\r?)$/;
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

/** Returns, for each of `lines`, whether it is a code fence or inside one, as Manki's `fencedLines`. */
function fencedLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((text) => {
    const opener = text.match(FENCE_LINE)?.[1];
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && text.trim() === opener) fence = undefined;
      return true;
    }
    if (opener) fence = opener;
    return !!opener;
  });
}

/**
 * Returns the message boxes in `lines`, as Manki's `anchoredBoxes` reads them. A box counts only right under its anchor
 * and outside a code fence, so a box line a model wrote into Manki's text is never one.
 */
function messageBoxes(lines: string[]): Array<MessageTick & { line: number; ticked: boolean; label: string }> {
  const fenced = fencedLines(lines);
  return lines.flatMap((text, line) => {
    const match = fenced[line] || lines[line - 1]?.trim() !== MESSAGE_BOX_ANCHOR ? null : ANCHORED_BOX_LINE.exec(text);
    if (!match || !MESSAGE_BOXES.includes(match[5])) return [];
    const tick = { box: match[5] as MessageBox, ...(match[6] !== undefined && { id: match[6] }) };
    return [{ ...tick, line, ticked: match[2] !== ' ', label: match[4].trim() }];
  });
}

const tickKey = ({ box, id }: MessageTick) => (id === undefined ? box : `${box}:${id}`);

/** Returns the message boxes that are ticked in `after` and were unticked in `before`, each once. */
export function tickedMessageBoxes(before: string, after: string): MessageTick[] {
  const old = new Map(messageBoxes(before.split('\n')).map((box) => [tickKey(box), box.ticked]));
  const ticks = new Map<string, MessageTick>();
  for (const { box, id, ticked, label } of messageBoxes(after.split('\n'))) {
    const login = box === 'allow' ? ALLOW_LABEL.exec(label)?.[1] : undefined;
    const tick = { box, ...(id !== undefined && { id }), ...(login !== undefined && { login }) };
    if (ticked && old.get(tickKey(tick)) === false) ticks.set(tickKey(tick), tick);
  }
  return [...ticks.values()];
}

/**
 * Returns `body` with the ticked line of each box in `ticks` unticked. With `editor`, the line is replaced by the one
 * Manki's `settleTickedBox` writes once the step started, "<label> requested by `@<editor>`". Every other line stays.
 */
export function settleMessageBoxes(body: string, ticks: MessageTick[], editor?: string): string {
  const lines = body.split('\n');
  const keys = new Set(ticks.map(tickKey));
  for (const box of messageBoxes(lines)) {
    if (!box.ticked || !keys.has(tickKey(box))) continue;
    const text = lines[box.line];
    lines[box.line] = editor === undefined
      ? text.replace(ANCHORED_BOX_LINE, (_line, start: string, _tick: string, end: string) => `${start} ${end}`)
      : `${box.label} requested by \`@${editor}\`${text.endsWith('\r') ? '\r' : ''}`;
  }
  return lines.join('\n');
}
