// Ports of the pure checks Manki runs on an event before it does any work. Each mirrors the function of the same
// name in manki `src/interaction.ts` or `src/index.ts`. A change there must be made here too, or the Worker drops an
// event the action would have handled.

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
