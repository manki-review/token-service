import { describe, expect, it } from 'vitest';
import { routeDelivery, type Route, type WebhookPayload } from '../src/routing';
import { INSTALLATION_ID, OWNER, OWNER_ID, REPO } from './helpers';
import {
  ACTIONS_AUTHOR,
  BOT_SENDER,
  COMMENT_ID,
  forkPullRequestEvent,
  HEAD_SHA,
  issueCommentEvent,
  MANKI_AUTHOR,
  PR_NUMBER,
  pullRequestEvent,
  REPOSITORY_ID,
  REVIEW_ID,
  reviewCommentEvent,
  reviewEvent,
  reviewThreadEvent,
  workflowRunEvent,
} from './payloads';

/** A compact form of the route: `ignore`, `<lane>:<kind>`, `close`, `close+merged`, `seen`, `reopen` or `run_completed`. */
const SETTINGS_COMMENT = '- [ ] Pause automatic reviews <!-- manki-box:pause -->\n- [ ] Review again <!-- manki-box:again -->\n<!-- manki-settings -->';
const FINDING_COMMENT = '**Off by one**\n\n- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:3:3:Off-by-one -->\n\n<!-- manki-finding: {} -->';
const TICKED_FINDING = FINDING_COMMENT.replace('[ ] Create', '[x] Create');

/** An edit of Manki's review body from `before` to `after`. GitHub names the review's author, Manki, as the sender. */
function reviewEdit(after: string, before?: string, review: Record<string, unknown> = {}): WebhookPayload {
  return {
    ...reviewEvent('edited', { user: MANKI_AUTHOR, body: after, node_id: 'PRR_1', ...review }),
    sender: MANKI_AUTHOR,
    ...(before !== undefined && { changes: { body: { from: before } } }),
  };
}

/** An edit of Manki's finding comment from `before` to `after`, by a writer. */
function findingEdit(after: string, before?: string, author = MANKI_AUTHOR): WebhookPayload {
  return { ...reviewCommentEvent(after, { user: author }, 'edited'), ...(before !== undefined && { changes: { body: { from: before } } }) };
}

function verdict(route: Route): string {
  switch (route.type) {
    case 'ignore':
      return 'ignore';
    case 'work':
      return `${route.work.lane}:${route.work.kind}`;
    case 'close':
      return route.merged ? 'close+merged' : 'close';
    case 'seen':
      return 'seen';
    case 'reopen':
      return 'reopen';
    case 'run_completed':
      return 'run_completed';
  }
}

const cases: Array<[string, string, WebhookPayload, string]> = [
  // pull_request
  ['a push', 'pull_request', pullRequestEvent('synchronize'), 'state:review'],
  ['an opened PR', 'pull_request', pullRequestEvent('opened'), 'state:review'],
  ['a PR marked ready', 'pull_request', pullRequestEvent('ready_for_review'), 'state:review'],
  ['a push to a draft, which the coordinator decides on', 'pull_request', pullRequestEvent('synchronize', { draft: true }), 'state:review'],
  ['a PR opened as a draft', 'pull_request', pullRequestEvent('opened', { draft: true }), 'state:review'],
  ['a PR converted to a draft', 'pull_request', pullRequestEvent('converted_to_draft', { draft: true }), 'ignore'],
  ['a push to a fork PR', 'pull_request', forkPullRequestEvent('synchronize'), 'ignore'],
  ['a push to a PR whose fork was deleted', 'pull_request', pullRequestEvent('synchronize', { head: { sha: HEAD_SHA, repo: null } }), 'ignore'],
  ['a push by a bot', 'pull_request', pullRequestEvent('synchronize', {}, BOT_SENDER), 'seen'],
  ['a PR opened by a bot', 'pull_request', pullRequestEvent('opened', {}, BOT_SENDER), 'seen'],
  ['a push by the Manki App', 'pull_request', pullRequestEvent('synchronize', {}, { login: 'manki-review[bot]', type: 'User' }), 'seen'],
  ['a bot push to a fork PR', 'pull_request', { ...forkPullRequestEvent('synchronize'), sender: BOT_SENDER }, 'ignore'],
  ['a PR labeled by a bot', 'pull_request', pullRequestEvent('labeled', {}, BOT_SENDER), 'ignore'],
  ['a labeled PR', 'pull_request', pullRequestEvent('labeled'), 'ignore'],
  ['a reopened PR', 'pull_request', pullRequestEvent('reopened'), 'reopen'],
  ['a reopened fork PR', 'pull_request', forkPullRequestEvent('reopened'), 'ignore'],
  ['a merge', 'pull_request', pullRequestEvent('closed', { merged: true }), 'close+merged'],
  ['a close without merge', 'pull_request', pullRequestEvent('closed'), 'close'],
  ['a merge by a bot', 'pull_request', pullRequestEvent('closed', { merged: true }, BOT_SENDER), 'close'],
  ['a merge of a fork PR', 'pull_request', { ...forkPullRequestEvent('closed'), pull_request: { ...forkPullRequestEvent('closed').pull_request, merged: true } }, 'close'],

  // pull_request_review
  ['a submitted review', 'pull_request_review', reviewEvent('submitted'), 'state:review_state'],
  ['a dismissed review', 'pull_request_review', reviewEvent('dismissed'), 'state:review_state'],
  ['an edited review', 'pull_request_review', reviewEvent('edited'), 'ignore'],
  ['a ticked issue box in Manki\'s review', 'pull_request_review', reviewEdit(TICKED_FINDING, FINDING_COMMENT), 'state:thread'],
  ['Manki\'s rewrite of its review that ticks no box', 'pull_request_review', reviewEdit(`${FINDING_COMMENT}\nheld`, FINDING_COMMENT), 'ignore'],
  ['an unticked issue box in Manki\'s review', 'pull_request_review', reviewEdit(FINDING_COMMENT, TICKED_FINDING), 'ignore'],
  ['a Manki review edit without the earlier body', 'pull_request_review', reviewEdit(TICKED_FINDING), 'ignore'],
  ['a ticked box in Manki\'s review without its node id', 'pull_request_review', reviewEdit(TICKED_FINDING, FINDING_COMMENT, { node_id: undefined }), 'ignore'],
  ['a ticked box in Manki\'s review on a fork PR', 'pull_request_review', { ...reviewEdit(TICKED_FINDING, FINDING_COMMENT), pull_request: forkPullRequestEvent('x').pull_request }, 'ignore'],
  ['a review by a bot', 'pull_request_review', reviewEvent('submitted', { user: MANKI_AUTHOR }), 'ignore'],
  ['a review on a stale commit', 'pull_request_review', reviewEvent('submitted', { commit_id: 'b'.repeat(40) }), 'ignore'],
  ['a review on a fork PR', 'pull_request_review', { ...reviewEvent('submitted'), pull_request: forkPullRequestEvent('x').pull_request }, 'ignore'],

  // pull_request_review_thread
  ['a resolved thread', 'pull_request_review_thread', reviewThreadEvent('resolved'), 'state:review_state'],
  ['a reopened thread', 'pull_request_review_thread', reviewThreadEvent('unresolved'), 'state:review_state'],
  ['another thread action', 'pull_request_review_thread', reviewThreadEvent('created'), 'ignore'],
  ['a thread resolved by a bot', 'pull_request_review_thread', reviewThreadEvent('resolved', {}, BOT_SENDER), 'ignore'],
  ['a thread resolved by the Manki App', 'pull_request_review_thread', reviewThreadEvent('resolved', {}, { login: 'manki-review[bot]', type: 'Bot' }), 'ignore'],
  ['a thread on a fork PR', 'pull_request_review_thread', reviewThreadEvent('resolved', { head: { sha: HEAD_SHA, repo: { full_name: 'mallory/manki' } } }), 'ignore'],
  ['a thread on a closed PR', 'pull_request_review_thread', reviewThreadEvent('resolved', { state: 'closed' }), 'ignore'],
  ['a thread on a PR without a state', 'pull_request_review_thread', reviewThreadEvent('resolved', { state: undefined }), 'ignore'],

  // pull_request_review_comment
  ['a reply in a thread', 'pull_request_review_comment', reviewCommentEvent('Fixed in the last push', { in_reply_to_id: 1 }), 'state:thread'],
  ['a mention in a new thread', 'pull_request_review_comment', reviewCommentEvent('@manki is this safe?'), 'state:thread'],
  ['a dismiss in a thread', 'pull_request_review_comment', reviewCommentEvent('@manki dismiss', { in_reply_to_id: 1 }), 'state:thread'],
  ['a remember in a thread', 'pull_request_review_comment', reviewCommentEvent('@manki remember use tabs', { in_reply_to_id: 1 }), 'state:thread'],
  ['a forget in a thread', 'pull_request_review_comment', reviewCommentEvent('@manki forget tabs'), 'state:thread'],
  ['a help in a thread', 'pull_request_review_comment', reviewCommentEvent('/manki help'), 'help:help'],
  ['a check in a thread', 'pull_request_review_comment', reviewCommentEvent('@manki check'), 'state:thread'],
  ['a new thread without a mention', 'pull_request_review_comment', reviewCommentEvent('nit: rename this'), 'ignore'],
  ['a review comment by a bot', 'pull_request_review_comment', reviewCommentEvent('@manki hi', { user: ACTIONS_AUTHOR }), 'ignore'],
  ['a Manki finding comment', 'pull_request_review_comment', reviewCommentEvent('<!-- manki-finding --> @manki', { user: { login: 'alice', type: 'User' } }), 'ignore'],
  ['an edited review comment', 'pull_request_review_comment', reviewCommentEvent('@manki hi', {}, 'edited'), 'ignore'],
  ['a ticked issue box in a Manki finding', 'pull_request_review_comment', findingEdit(TICKED_FINDING, FINDING_COMMENT), 'state:thread'],
  ['an unticked issue box in a Manki finding', 'pull_request_review_comment', findingEdit(FINDING_COMMENT, TICKED_FINDING), 'ignore'],
  ['an edit of a Manki finding that ticks no box', 'pull_request_review_comment', findingEdit(`${FINDING_COMMENT}\nmore`, FINDING_COMMENT), 'ignore'],
  ['a Manki finding edit without the earlier body', 'pull_request_review_comment', findingEdit(TICKED_FINDING), 'ignore'],
  ['a ticked issue box in a copy by someone else', 'pull_request_review_comment', findingEdit(TICKED_FINDING, FINDING_COMMENT, { login: 'mallory', type: 'User' }), 'ignore'],
  ['a review comment on a fork PR', 'pull_request_review_comment', reviewCommentEvent('@manki hi', {}, 'created', { head: { sha: HEAD_SHA, repo: { full_name: 'mallory/manki' } } }), 'ignore'],

  // issue_comment on a PR
  ['a review request', 'issue_comment', issueCommentEvent('@manki review'), 'state:review'],
  ['a review request by slash command', 'issue_comment', issueCommentEvent('/manki review please'), 'state:review'],
  ['a check', 'issue_comment', issueCommentEvent('@manki check'), 'state:comment'],
  ['a dismiss', 'issue_comment', issueCommentEvent('@manki dismiss the null check finding'), 'state:comment'],
  ['an explain', 'issue_comment', issueCommentEvent('@manki explain the cache'), 'chat:comment'],
  ['a free question', 'issue_comment', issueCommentEvent('@manki why is this slow?'), 'chat:comment'],
  ['a help', 'issue_comment', issueCommentEvent('@Manki help'), 'help:help'],
  ['a help that asks for a review', 'issue_comment', issueCommentEvent('@manki help me review this'), 'state:review'],
  ['an edit that adds a help', 'issue_comment', issueCommentEvent('@manki help', { action: 'edited', previousBody: 'hmm' }), 'help:help'],
  ['an edit that keeps a help', 'issue_comment', issueCommentEvent('@manki help, thanks', { action: 'edited', previousBody: '@manki help' }), 'ignore'],
  ['a remember', 'issue_comment', issueCommentEvent('@manki remember we use tabs'), 'chat:comment'],
  ['a forget', 'issue_comment', issueCommentEvent('@manki-review forget tabs'), 'chat:comment'],
  ['a check quoted in code', 'issue_comment', issueCommentEvent('@manki what does `@manki check` do?'), 'chat:comment'],
  ['a comment without a mention', 'issue_comment', issueCommentEvent('LGTM'), 'ignore'],
  ['a mention inside a word', 'issue_comment', issueCommentEvent('ask @mankind'), 'ignore'],
  ['a comment by a bot', 'issue_comment', issueCommentEvent('@manki review', { sender: BOT_SENDER }), 'ignore'],
  ['a deleted comment', 'issue_comment', issueCommentEvent('@manki review', { action: 'deleted' }), 'ignore'],
  ['an edit that adds a mention', 'issue_comment', issueCommentEvent('@manki explain', { action: 'edited', previousBody: 'hmm' }), 'chat:comment'],
  ['an edit that adds a review request', 'issue_comment', issueCommentEvent('@manki review', { action: 'edited', previousBody: 'hmm' }), 'state:review'],
  ['an edit that keeps a mention', 'issue_comment', issueCommentEvent('@manki explain this', { action: 'edited', previousBody: '@manki explain' }), 'chat:comment'],
  ['an edit that keeps a review request', 'issue_comment', issueCommentEvent('@manki review please', { action: 'edited', previousBody: '@manki review' }), 'state:review'],
  ['an edit that removes a mention', 'issue_comment', issueCommentEvent('never mind', { action: 'edited', previousBody: '@manki explain' }), 'ignore'],

  ['a ticked settings box', 'issue_comment', issueCommentEvent(SETTINGS_COMMENT.replace('[ ] Pause', '[x] Pause'), { action: 'edited', author: MANKI_AUTHOR, previousBody: SETTINGS_COMMENT }), 'settings:settings'],
  ['a settings edit that changes no box', 'issue_comment', issueCommentEvent(`${SETTINGS_COMMENT}\nmore`, { action: 'edited', author: MANKI_AUTHOR, previousBody: SETTINGS_COMMENT }), 'ignore'],
  ['a settings edit without the earlier body', 'issue_comment', issueCommentEvent(SETTINGS_COMMENT, { action: 'edited', author: MANKI_AUTHOR }), 'ignore'],
  ['a ticked box on a copy of the settings by someone else', 'issue_comment', issueCommentEvent(SETTINGS_COMMENT.replace('[ ] Pause', '[x] Pause'), { action: 'edited', previousBody: SETTINGS_COMMENT }), 'ignore'],

  // issue_comment on an issue
  ['a mention on an issue', 'issue_comment', issueCommentEvent('@manki help', { onIssue: true }), 'chat:issue'],
  ['a remember on an issue', 'issue_comment', issueCommentEvent('@manki remember tabs', { onIssue: true }), 'chat:issue'],
  ['a review request on an issue', 'issue_comment', issueCommentEvent('@manki review', { onIssue: true }), 'ignore'],
  ['a Manki comment on an issue', 'issue_comment', issueCommentEvent('<!-- manki-bot --> @manki help', { onIssue: true }), 'ignore'],

  // workflow_run
  ['a finished dispatch run', 'workflow_run', workflowRunEvent(), 'run_completed'],
  ['a started dispatch run', 'workflow_run', workflowRunEvent({}, 'in_progress'), 'ignore'],
  ['a finished CI run', 'workflow_run', workflowRunEvent({ event: 'pull_request', path: '.github/workflows/ci.yml' }), 'ignore'],
  ['a dispatch run whose path names the ref', 'workflow_run', workflowRunEvent({ path: '.github/workflows/manki-dispatch.yml@refs/heads/main' }), 'run_completed'],
  ['a run of a workflow whose name only starts the same', 'workflow_run', workflowRunEvent({ path: '.github/workflows/manki-dispatch.yml.bak' }), 'ignore'],
  ['a dispatch run that only differs in its event', 'workflow_run', workflowRunEvent({ event: 'push' }), 'ignore'],
  ['a dispatch run of manki.yml', 'workflow_run', workflowRunEvent({ path: '.github/workflows/manki.yml' }), 'run_completed'],
  ['a run of a dynamic workflow', 'workflow_run', workflowRunEvent({ path: 'dynamic/pages/pages-build-deployment' }), 'ignore'],
  ['a dispatch run without a PR in its name', 'workflow_run', workflowRunEvent({ display_title: 'Manki dispatch' }), 'ignore'],
  ['a dispatch run a person started', 'workflow_run', { ...workflowRunEvent(), sender: { login: 'alice', type: 'User' } }, 'ignore'],
  ['a dispatch run another App started', 'workflow_run', { ...workflowRunEvent(), sender: BOT_SENDER }, 'ignore'],
  ['a dispatch run without a sender', 'workflow_run', { ...workflowRunEvent(), sender: undefined }, 'ignore'],

  // Other events and broken payloads
  ['a ping', 'ping', { zen: 'Keep it logically awesome.' } as WebhookPayload, 'ignore'],
  ['an installation event', 'installation', { action: 'new_permissions_accepted' }, 'ignore'],
  ['a push event', 'push', pullRequestEvent('x'), 'ignore'],
  ['a payload without an installation', 'pull_request', { ...pullRequestEvent('synchronize'), installation: undefined }, 'ignore'],
];

describe('routeDelivery', () => {
  it.each(cases)('routes %s', (_case, event, payload, expected) => {
    expect(verdict(routeDelivery(event, payload))).toBe(expected);
  });

  it('drops a comment event that arrives over 6 hours after the comment was written or edited', () => {
    const now = Date.parse('2030-01-01T12:00:00Z');
    const at = (iso: string) => ({ created_at: '2030-01-01T00:00:00Z', updated_at: iso });
    const issueComment = (iso: string) => {
      const payload = issueCommentEvent('@manki explain');
      return { ...payload, comment: { ...payload.comment, ...at(iso) } };
    };
    expect(verdict(routeDelivery('issue_comment', issueComment('2030-01-01T06:00:00Z'), now))).toBe('chat:comment');
    expect(routeDelivery('issue_comment', issueComment('2030-01-01T05:59:59Z'), now)).toEqual({ type: 'ignore', reason: 'comment is over 6 hours old' });
    expect(verdict(routeDelivery('pull_request_review_comment', reviewCommentEvent('ok', { in_reply_to_id: 1, ...at('2030-01-01T05:00:00Z') }), now))).toBe('ignore');
    expect(verdict(routeDelivery('pull_request_review', { ...reviewEvent('submitted'), comment: at('2030-01-01T00:00:00Z') }, now))).toBe('state:review_state');
  });

  it('names the target from the payload', () => {
    const route = routeDelivery('pull_request', pullRequestEvent('synchronize'));
    expect(route).toMatchObject({
      target: { installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, owner: OWNER, ownerId: OWNER_ID, repo: REPO, defaultBranch: 'main', number: PR_NUMBER },
    });
  });

  it.each<[string, string, WebhookPayload, object]>([
    ['a push', 'pull_request', pullRequestEvent('synchronize'), { event: 'pull_request.synchronize', headSha: HEAD_SHA, objectId: null, sender: 'alice' }],
    ['a review', 'pull_request_review', reviewEvent('submitted'), { event: 'pull_request_review.submitted', headSha: HEAD_SHA, objectId: REVIEW_ID }],
    ['a resolved thread', 'pull_request_review_thread', reviewThreadEvent('resolved'), { event: 'pull_request_review_thread.resolved', headSha: HEAD_SHA, objectId: null, sender: 'alice' }],
    ['a thread reply', 'pull_request_review_comment', reviewCommentEvent('ok', { in_reply_to_id: 1 }), { event: 'pull_request_review_comment.created', objectId: COMMENT_ID }],
    ['a review request', 'issue_comment', issueCommentEvent('@manki review'), { event: 'issue_comment.created', headSha: null, objectId: COMMENT_ID }],
  ])('fills the dispatch fields for %s', (_case, event, payload, expected) => {
    const route = routeDelivery(event, payload);
    expect(route.type).toBe('work');
    expect(route.type === 'work' && route.work).toMatchObject(expected);
  });

  it.each<[string, string, WebhookPayload, boolean]>([
    ['a push', 'pull_request', pullRequestEvent('synchronize'), true],
    ['a review by a collaborator', 'pull_request_review', reviewEvent('submitted'), true],
    ['a review by an outsider', 'pull_request_review', reviewEvent('submitted', { author_association: 'NONE' }), false],
    ['a review by the PR author', 'pull_request_review', reviewEvent('submitted', { author_association: 'NONE' }, { user: { login: 'alice', type: 'User' } }), true],
    ['a resolved thread', 'pull_request_review_thread', reviewThreadEvent('resolved'), true],
    ...['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'].map((association): [string, string, WebhookPayload, boolean] =>
      [`a review request by a ${association}`, 'issue_comment', issueCommentEvent('@manki review', { association }), true]),
    ['a review request by a first-time contributor', 'issue_comment', issueCommentEvent('@manki review', { association: 'FIRST_TIME_CONTRIBUTOR' }), false],
    ['a review request by an outsider', 'issue_comment', issueCommentEvent('@manki review', { association: 'NONE' }), false],
    ['a review request without an association', 'issue_comment', { ...issueCommentEvent('@manki review'), comment: { id: COMMENT_ID, body: '@manki review' } }, false],
    ['a review request by the PR author', 'issue_comment', issueCommentEvent('@manki review', { association: 'NONE', issueAuthor: 'Alice' }), true],
    ['an outsider\'s question', 'issue_comment', issueCommentEvent('@manki explain', { association: 'NONE' }), false],
    ['a thread reply by an outsider', 'pull_request_review_comment', reviewCommentEvent('ok', { in_reply_to_id: 1, author_association: 'NONE' }), false],
    ['a thread reply by the PR author', 'pull_request_review_comment', reviewCommentEvent('ok', { in_reply_to_id: 1, author_association: 'NONE' }, 'created', { user: { login: 'alice', type: 'User' } }), true],
  ])('marks %s as trusted or not', (_case, event, payload, trusted) => {
    const route = routeDelivery(event, payload);
    expect(route.type === 'work' && route.work.trusted).toBe(trusted);
  });

  it.each<[string, string, WebhookPayload, boolean, number?]>([
    ...['OWNER', 'MEMBER', 'COLLABORATOR'].map((association): [string, string, WebhookPayload, boolean] =>
      [`a review request by a ${association}`, 'issue_comment', issueCommentEvent('@manki review', { association }), true]),
    ['a question on an issue', 'issue_comment', issueCommentEvent('@manki explain this', { onIssue: true }), true],
    ['an edit that keeps the command', 'issue_comment', issueCommentEvent('@manki review please', { action: 'edited' }), true],
    ['a mention in a review comment', 'pull_request_review_comment', reviewCommentEvent('@manki is this safe?'), true],
    ['a review request by a contributor', 'issue_comment', issueCommentEvent('@manki review', { association: 'CONTRIBUTOR' }), false],
    ['a review request by the PR author', 'issue_comment', issueCommentEvent('@manki review', { association: 'NONE', issueAuthor: 'Alice' }), false],
    ['a question by an outsider on their issue', 'issue_comment', issueCommentEvent('@manki help', { onIssue: true, association: 'NONE', issueAuthor: 'alice' }), false],
    ['an edit of a collaborator\'s command by someone else', 'issue_comment', issueCommentEvent('@manki review', { action: 'edited', sender: { login: 'mallory', type: 'User' } }), false],
    // A reply that is no command names the comment it answers, and the coordinator reacts once that comment is Manki's.
    ['a thread reply without a mention', 'pull_request_review_comment', reviewCommentEvent('Fixed', { in_reply_to_id: 7 }), false, 7],
    ['a command in a thread reply', 'pull_request_review_comment', reviewCommentEvent('@manki dismiss', { in_reply_to_id: 7 }), true],
    ['a mention in a review comment by an outsider', 'pull_request_review_comment', reviewCommentEvent('@manki is this safe?', { author_association: 'NONE' }), false],
    ['a help, which gets a thumbs-up with its answer instead', 'issue_comment', issueCommentEvent('@manki help'), false],
    ['a push', 'pull_request', pullRequestEvent('synchronize'), false],
  ])('reacts to %s when it is queued or not', (_case, event, payload, acknowledge, repliesTo) => {
    const route = routeDelivery(event, payload);
    expect(route.type).toBe('work');
    expect(route.type === 'work' && [route.work.acknowledge && route.work.writer, route.work.repliesTo]).toEqual([acknowledge, repliesTo]);
  });

  it.each<[string, string, WebhookPayload, boolean, boolean]>([
    ['an owner\'s comment', 'issue_comment', issueCommentEvent('@manki explain', { association: 'OWNER' }), true, false],
    ['a collaborator\'s comment', 'issue_comment', issueCommentEvent('@manki explain'), true, true],
    ['a member\'s comment', 'issue_comment', issueCommentEvent('@manki explain', { association: 'MEMBER' }), true, true],
    ['a collaborator\'s edit of their own comment', 'issue_comment', issueCommentEvent('@manki explain', { action: 'edited' }), true, true],
    ['an edit of a collaborator\'s comment by someone else', 'issue_comment', issueCommentEvent('@manki explain', { action: 'edited', sender: { login: 'mallory', type: 'User' } }), false, false],
    ['a contributor\'s comment, which a private member shows as', 'issue_comment', issueCommentEvent('@manki explain', { association: 'CONTRIBUTOR' }), false, true],
    ['an outsider\'s thread reply', 'pull_request_review_comment', reviewCommentEvent('ok', { in_reply_to_id: 1, author_association: 'NONE' }), false, true],
    ['a first-timer\'s comment', 'issue_comment', issueCommentEvent('@manki explain', { association: 'FIRST_TIMER' }), false, true],
    ['a first-time contributor\'s comment, which a private member can show as', 'issue_comment', issueCommentEvent('@manki explain', { association: 'FIRST_TIME_CONTRIBUTOR' }), false, true],
    ['a collaborator\'s review', 'pull_request_review', reviewEvent('submitted'), true, true],
    ['an outsider\'s review', 'pull_request_review', reviewEvent('submitted', { author_association: 'NONE' }), false, true],
    ['a dismissed review', 'pull_request_review', reviewEvent('dismissed', { author_association: 'NONE' }), true, false],
    ['a push', 'pull_request', pullRequestEvent('synchronize'), true, false],
    // The editor of Manki's comment is looked up, so a writer's tick counts as trusted work.
    ['a tick in Manki\'s finding', 'pull_request_review_comment', findingEdit(TICKED_FINDING, FINDING_COMMENT), false, true],
  ])('marks %s as a writer or not, and whether to look the sender up', (_case, event, payload, writer, checkWriter) => {
    const route = routeDelivery(event, payload);
    expect(route.type === 'work' && { writer: route.work.writer, checkWriter: route.work.checkWriter }).toEqual({ writer, checkWriter });
  });

  it('leaves the sender of a tick in Manki\'s review to the editor lookup', () => {
    const route = routeDelivery('pull_request_review', reviewEdit(TICKED_FINDING, FINDING_COMMENT));
    expect(route.type === 'work' && route.work).toMatchObject({
      event: 'pull_request_review.edited', objectId: REVIEW_ID, sender: '', editorOf: 'PRR_1', writer: false, checkWriter: true, acknowledge: false,
    });
  });

  it('names the boxes a settings edit ticked or unticked, and counts the editor as no writer until looked up', () => {
    const before = SETTINGS_COMMENT.replace('[ ] Review again', '[x] Review again');
    const after = SETTINGS_COMMENT.replace('[ ] Pause', '[X] Pause');
    expect(routeDelivery('issue_comment', issueCommentEvent(after, { action: 'edited', author: MANKI_AUTHOR, previousBody: before }))).toMatchObject({
      type: 'work',
      work: { lane: 'settings', kind: 'settings', event: 'issue_comment.edited', writer: false, acknowledge: false, boxes: [{ box: 'pause', ticked: true }, { box: 'again', ticked: false }] },
    });
    const deeper = '- [ ] Deeper review <!-- manki-box:deeper -->\n<!-- manki-settings -->';
    expect(routeDelivery('issue_comment', issueCommentEvent(deeper.replace('[ ]', '[x]'), { action: 'edited', author: MANKI_AUTHOR, previousBody: deeper }))).toMatchObject({
      type: 'work', work: { boxes: [{ box: 'deeper', ticked: true }] },
    });
    // The removed Full and Force review boxes are no boxes any more, so ticking one changes nothing.
    for (const old of ['full', 'force']) {
      const body = `- [ ] Old box <!-- manki-box:${old} -->\n<!-- manki-settings -->`;
      const route = routeDelivery('issue_comment', issueCommentEvent(body.replace('[ ]', '[x]'), { action: 'edited', author: MANKI_AUTHOR, previousBody: body }));
      expect(route.type === 'work' ? route.work.boxes ?? [] : []).toEqual([]);
    }
  });

  it('fills the merge work and the run end', () => {
    expect(routeDelivery('pull_request', pullRequestEvent('closed', { merged: true }))).toMatchObject({
      type: 'close',
      merged: { lane: 'state', kind: 'merged', event: 'pull_request.closed', headSha: HEAD_SHA },
    });
    expect(routeDelivery('workflow_run', workflowRunEvent({ conclusion: 'failure' }))).toMatchObject({
      type: 'run_completed', runId: 555, conclusion: 'failure', target: { number: PR_NUMBER },
    });
  });
});
