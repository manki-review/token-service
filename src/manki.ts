import { minimatch } from 'minimatch';
import { parse } from 'yaml';

// Ports of the pure checks Manki runs on an event before it does any work. Each mirrors the function of the same
// name in manki `src/interaction.ts`, `src/index.ts`, `src/config.ts` or `src/review-record.ts`. A change there must be
// made here too, or the Worker drops an event the action would have handled.

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
 * Whether Manki itself wrote the flag `marker` in the review `body`: on a line of its own below the last round record,
 * or anywhere when the body holds no record. A marker above the record is quoted text.
 */
export function hasOwnMarker(body: string, marker: string): boolean {
  const lines = body.split('\n');
  const record = lines.map((line) => line.startsWith(RECORD_OPENER) && line.includes('-->')).lastIndexOf(true);
  return lines.slice(record + 1).some((line) => line.trimEnd() === marker);
}

/** The answer to a help command, as Manki's `handleHelp` posts it. */
export const HELP_REPLY = [
  '| Command | What it does |',
  '|---|---|',
  '| `/manki review` | Reviews the head commit unless Manki\'s newest review of it is complete. Tick Review again in the settings block to review it again |',
  '| `/manki explain [topic]` | Explains something about this PR |',
  '| `/manki check` | Checks for open blocking threads and approves when there are none |',
  '| `/manki dismiss [finding]` | Dismisses a finding |',
  '| `/manki remember <instruction>` | Stores an instruction for future reviews |',
  '| `/manki forget <text>` | Removes a learning or suppression |',
  '| `/manki help` | Shows this message |',
  '',
  '`@manki` and `@manki-review` work as the prefix too. A reply to a Manki review comment gets an answer in its thread.',
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
 * Returns the progress comment `body` marked as cancelled with `headline`, such as "Review cancelled by @alice.", as
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

export type SettingsBox = 'pause' | 'again' | 'deeper' | 'cancel' | 'draft';

/** The boxes that ask for one review, as the `modes` of that review. */
export type ReviewMode = Extract<SettingsBox, 'again' | 'deeper' | 'draft'>;

export const REVIEW_MODES: readonly ReviewMode[] = ['again', 'deeper', 'draft'];

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
const BOX_LINE = /^([ \t]*[-*] \[)([ xX])(\] .*<!-- manki-box:(pause|again|deeper|cancel|draft) -->[ \t]*)$/gm;

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
