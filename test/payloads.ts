import type { WebhookPayload } from '../src/routing';
import { INSTALLATION_ID, OWNER, REPO } from './helpers';

export const REPOSITORY_ID = 4242;
export const PR_NUMBER = 7;
export const HEAD_SHA = 'a'.repeat(40);
export const COMMENT_ID = 1001;
export const REVIEW_ID = 2002;

const HUMAN = { login: 'alice', type: 'User' };
const MANKI = { login: 'manki-review[bot]', type: 'Bot' };

function base(action: string): WebhookPayload {
  return {
    action,
    sender: HUMAN,
    installation: { id: INSTALLATION_ID },
    repository: { id: REPOSITORY_ID, name: REPO, full_name: `${OWNER}/${REPO}`, default_branch: 'main', owner: { login: OWNER } },
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return { number: PR_NUMBER, draft: false, merged: false, head: { sha: HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}` } }, ...overrides };
}

const FORK_HEAD = { sha: HEAD_SHA, repo: { full_name: 'mallory/manki' } };

export function pullRequestEvent(action: string, pr: Record<string, unknown> = {}, sender = HUMAN): WebhookPayload {
  return { ...base(action), sender, pull_request: pullRequest(pr) };
}

export function forkPullRequestEvent(action: string): WebhookPayload {
  return pullRequestEvent(action, { head: FORK_HEAD });
}

export function reviewEvent(action: string, review: Record<string, unknown> = {}, pr: Record<string, unknown> = {}): WebhookPayload {
  return {
    ...base(action),
    pull_request: pullRequest(pr),
    review: { id: REVIEW_ID, commit_id: HEAD_SHA, user: HUMAN, ...review },
  };
}

export function reviewCommentEvent(body: string, comment: Record<string, unknown> = {}, action = 'created', pr: Record<string, unknown> = {}): WebhookPayload {
  return {
    ...base(action),
    pull_request: pullRequest(pr),
    comment: { id: COMMENT_ID, body, user: HUMAN, ...comment },
  };
}

export interface IssueCommentOptions {
  action?: string;
  onIssue?: boolean;
  author?: { login: string; type: string };
  sender?: { login: string; type: string };
  previousBody?: string;
  number?: number;
}

export function issueCommentEvent(body: string, options: IssueCommentOptions = {}): WebhookPayload {
  return {
    ...base(options.action ?? 'created'),
    sender: options.sender ?? HUMAN,
    issue: { number: options.number ?? PR_NUMBER, ...(options.onIssue ? {} : { pull_request: { url: 'https://api.github.com/x' } }) },
    comment: { id: COMMENT_ID, body, user: options.author ?? HUMAN },
    ...(options.previousBody === undefined ? {} : { changes: { body: { from: options.previousBody } } }),
  };
}

export const MANKI_AUTHOR = MANKI;
export const ACTIONS_AUTHOR = { login: 'github-actions[bot]', type: 'Bot' };
export const BOT_SENDER = { login: 'dependabot[bot]', type: 'Bot' };

export const FORCE_REVIEW_COMMENT = '<!-- manki-bot --><!-- manki-force-review -->**Review skipped**\n\n- [x] Force review';
export const FORCE_CAP_COMMENT = '<!-- manki-bot --><!-- manki-force-cap -->Round cap reached\n\n- [x] Force review';

export function workflowRunEvent(run: Record<string, unknown> = {}, action = 'completed'): WebhookPayload {
  return {
    ...base(action),
    sender: MANKI,
    workflow_run: {
      id: 555,
      event: 'workflow_dispatch',
      path: '.github/workflows/manki-dispatch.yml',
      display_title: `Manki pull_request.synchronize on PR ${PR_NUMBER} (work 3)`,
      conclusion: 'success',
      ...run,
    },
  };
}

export const DISPATCH_WORKFLOW_YAML = `name: Manki dispatch
run-name: Manki \${{ inputs.event }} on PR \${{ inputs.pr }} (work \${{ inputs.work_id }})
on:
  workflow_dispatch:
    inputs:
      pr: { type: string, required: true }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: manki-review/manki@v6
`;

export const EVENT_WORKFLOW_YAML = `name: Manki
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, closed]
  issue_comment:
    types: [created, edited]
jobs:
  review:
    if: github.actor != 'manki-review[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: manki-review/manki@v6
`;

/** The GraphQL reply listing `.github/workflows` with `files` as name to text. */
export function workflowsReply(files: Record<string, string>): { body: unknown } {
  const entries = Object.entries(files).map(([name, text]) => ({ name, object: { text } }));
  return { body: { data: { repository: { object: { entries } } } } };
}
