import { minimatch } from 'minimatch';
import { parse } from 'yaml';

// Ports of the pure checks Manki runs on an event before it does any work. Each mirrors the function of the same
// name in manki `src/interaction.ts`, `src/index.ts` or `src/config.ts`. A change there must be made here too, or the
// Worker drops an event the action would have handled.

export const BOT_LOGIN = 'manki-review[bot]';

/** The logins Manki's own comments carry: the App, or `github-actions[bot]` when a run had no App token. */
export const MANKI_LOGINS: readonly string[] = [BOT_LOGIN, 'github-actions[bot]'];

/** The marker every comment and review comment Manki writes carries. */
export const MANKI_COMMENT_MARKER = '<!-- manki';

const FORCE_REVIEW_MARKER = '<!-- manki-force-review -->';
const FORCE_CAP_MARKER = '<!-- manki-force-cap -->';
const TICKED_FORCE_REVIEW = '- [x] Force review';

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

export function detectTickedMarker(body: string): 'FORCE_REVIEW_MARKER' | 'FORCE_CAP_MARKER' | null {
  if (!body.includes(TICKED_FORCE_REVIEW)) return null;
  if (body.includes(FORCE_CAP_MARKER)) return 'FORCE_CAP_MARKER';
  if (body.includes(FORCE_REVIEW_MARKER)) return 'FORCE_REVIEW_MARKER';
  return null;
}

/** The skip rules of a base branch's `.manki.yml`. */
export interface SkipRules {
  skip_labels: string[];
  skip_authors: string[];
  skip_branches: string[];
}

const SKIP_KEYS = ['skip_labels', 'skip_authors', 'skip_branches'] as const;

/**
 * Returns the skip rules `text` sets, as Manki's `loadSkipRules` reads them. Null when it sets none, does not parse, or
 * sets one that is not a list of non-empty strings.
 */
export function parseSkipRules(text: string): SkipRules | null {
  let root: unknown;
  try {
    root = parse(text);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const given = SKIP_KEYS.filter((key) => Object.hasOwn(root, key));
  if (given.length === 0) return null;
  const valid = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
  if (!given.every((key) => valid((root as Record<string, unknown>)[key]))) return null;
  return { skip_labels: [], skip_authors: [], skip_branches: [], ...Object.fromEntries(given.map((key) => [key, (root as Record<string, unknown>)[key]])) };
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
