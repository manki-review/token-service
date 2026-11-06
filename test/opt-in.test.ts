import { describe, expect, it } from 'vitest';
import { classifyWorkflows, MAX_WORKFLOW_BYTES, readOptIn, type WorkflowFile } from '../src/opt-in';
import type { Target } from '../src/routing';
import { INSTALLATION_ID, OWNER, OWNER_ID, REPO, stubGitHub } from './helpers';
import { DISPATCH_WORKFLOW_YAML, EVENT_WORKFLOW_YAML, REPOSITORY_ID, workflowsReply } from './payloads';

/** Pads `text` with a YAML comment to exactly `bytes` bytes. */
function padded(text: string, bytes: number): string {
  return `${text}#${'x'.repeat(bytes - text.length - 2)}\n`;
}

const CI_YAML = 'name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
// manki's own workflow runs the local build with `uses: ./`, so only its job `if` names Manki.
const SELF_TEST_YAML = "on: [pull_request_review]\njobs:\n  review:\n    if: github.actor != 'manki-review[bot]'\n    steps:\n      - uses: ./\n";

// A dispatch workflow whose review job is a reusable workflow in another repository, so its text does not name Manki.
const FOREIGN_DISPATCH_YAML = DISPATCH_WORKFLOW_YAML.replace(/jobs:[\s\S]*/, 'jobs:\n  review:\n    uses: acme/workflows/.github/workflows/review.yml@v1\n');

function files(entries: Record<string, string | null>): WorkflowFile[] {
  return Object.entries(entries).map(([name, text]) => ({ name, text }));
}

describe('classifyWorkflows', () => {
  it.each<[string, Record<string, string | null>, string | null, string]>([
    ['no workflows', {}, null, 'no Manki workflow runs on workflow_dispatch'],
    ['the dispatch workflow alone', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['the dispatch workflow and CI', { 'ci.yml': CI_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['both Manki workflows', { 'manki.yml': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow manki.yml is next to manki-dispatch.yml'],
    ['an event-driven workflow under another name', { 'review.yaml': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow review.yaml is next to manki-dispatch.yml'],
    ["manki's self-test workflow", { 'manki.yml': SELF_TEST_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow manki.yml is next to manki-dispatch.yml'],
    ['a Manki workflow on a single event', { 'm.yml': "on: issue_comment\njobs: { r: { steps: [{ uses: 'manki-review/manki@v6' }] } }", 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow m.yml is next to manki-dispatch.yml'],
    ['a Manki workflow on a schedule only', { 'nightly.yml': 'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a Manki workflow that does not parse', { 'broken.yml': 'on: [pull_request\nuses: manki-review/manki@v6', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow broken.yml is next to manki-dispatch.yml'],
    ['an unrelated file that does not parse', { 'broken.yml': 'on: [pull_request', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a Manki README next to the dispatch workflow', { 'README.md': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a Manki workflow on pull_request_target', { 'm.yml': 'on: pull_request_target\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow m.yml is next to manki-dispatch.yml'],
    ['a Manki action written in mixed case', { 'm.yml': 'on: [pull_request]\njobs: { r: { steps: [{ uses: Manki-Review/Manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow m.yml is next to manki-dispatch.yml'],
    ['a local reusable Manki workflow and its caller', { 'a-caller.yml': 'on: [pull_request]\njobs:\n  review:\n    uses: ./.github/workflows/review.yml\n', 'review.yml': 'on:\n  workflow_call:\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'event-driven Manki workflow a-caller.yml is next to manki-dispatch.yml'],
    ['a caller of a local reusable workflow without Manki', { 'a-caller.yml': 'on: [pull_request]\njobs:\n  test:\n    uses: ./.github/workflows/test.yml\n', 'test.yml': 'on: [workflow_call]\njobs: { t: { steps: [{ run: npm test }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a dispatch file without the delivery_id and review_id inputs', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML.replace(/ {6}(review_id|delivery_id):.*\n/g, '') }, null, 'manki-dispatch.yml does not declare the inputs review_id, delivery_id'],
    ['a dispatch file without inputs', { 'manki-dispatch.yml': 'on: workflow_dispatch\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }' }, null, 'manki-dispatch.yml does not declare the inputs event, action, pr, head_sha, comment_id, review_id, delivery_id'],
    ['a dispatch file that also runs on pull_request', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML.replace('on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:') }, null, 'manki-dispatch.yml runs on more than workflow_dispatch'],
    ['a dispatch file that calls a local reusable Manki workflow', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML.replace(/jobs:[\s\S]*/, 'jobs:\n  review:\n    uses: ./.github/workflows/manki-review.yml\n'), 'manki-review.yml': 'on:\n  workflow_call:\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }' }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a dispatch file without workflow_dispatch', { 'manki-dispatch.yml': EVENT_WORKFLOW_YAML }, null, 'no Manki workflow runs on workflow_dispatch'],
    ['a dispatch file under the .yaml extension', { 'manki-dispatch.yaml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yaml', 'manki-dispatch.yaml and no event-driven Manki workflow'],
    ['an unreadable dispatch file', { 'manki-dispatch.yml': null }, null, 'no Manki workflow runs on workflow_dispatch'],
    ['a dispatch file of 64 KB', { 'manki-dispatch.yml': padded(DISPATCH_WORKFLOW_YAML, MAX_WORKFLOW_BYTES) }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a dispatch file over 64 KB', { 'manki-dispatch.yml': padded(DISPATCH_WORKFLOW_YAML, MAX_WORKFLOW_BYTES + 1) }, null, 'manki-dispatch.yml is over 64 KB, so it counts as an event-driven Manki workflow'],
    ['a workflow over 64 KB that does not name Manki', { 'ci.yml': padded(CI_YAML, MAX_WORKFLOW_BYTES + 1), 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, null, 'ci.yml is over 64 KB, so it counts as an event-driven Manki workflow'],
    ['a workflow of 64 KB that does not name Manki', { 'ci.yml': padded(CI_YAML, MAX_WORKFLOW_BYTES), 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a README over 64 KB', { 'README.md': padded(EVENT_WORKFLOW_YAML, MAX_WORKFLOW_BYTES + 1), 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a dispatch file with a duplicate key', { 'manki-dispatch.yml': `${DISPATCH_WORKFLOW_YAML}name: again\n` }, 'manki-dispatch.yml', 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['the dispatch workflow as manki.yml', { 'manki.yml': DISPATCH_WORKFLOW_YAML }, 'manki.yml', 'manki.yml and no event-driven Manki workflow'],
    ['the dispatch workflow under any name', { 'review.yaml': DISPATCH_WORKFLOW_YAML }, 'review.yaml', 'review.yaml and no event-driven Manki workflow'],
    ['the old name calling a reusable workflow in another repository', { 'manki-dispatch.yml': FOREIGN_DISPATCH_YAML }, null, 'no Manki workflow runs on workflow_dispatch'],
    ['a file that names Manki next to the old name that does not', { 'manki-dispatch.yml': FOREIGN_DISPATCH_YAML, 'review.yml': DISPATCH_WORKFLOW_YAML }, 'review.yml', 'review.yml and no event-driven Manki workflow'],
    ['a dispatch workflow that does not name Manki', { 'deploy.yml': FOREIGN_DISPATCH_YAML }, null, 'no Manki workflow runs on workflow_dispatch'],
  ])('classifies %s', (_case, entries, workflow, reason) => {
    expect(classifyWorkflows(files(entries))).toEqual(workflow === null ? { optedIn: false, reason } : { optedIn: true, workflow, reason });
  });

  it.each<[string, Record<string, string>, string, string[]]>([
    ['manki.yml next to another name', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML, 'manki.yml': DISPATCH_WORKFLOW_YAML }, 'manki.yml', ['manki-dispatch.yml']],
    ['two files that name Manki, neither manki.yml', { 'b.yml': DISPATCH_WORKFLOW_YAML, 'a.yml': DISPATCH_WORKFLOW_YAML }, 'a.yml', ['b.yml']],
  ])('picks one file and names the others for %s', (_case, entries, workflow, others) => {
    expect(classifyWorkflows(files(entries))).toEqual({ optedIn: true, workflow, others, reason: `${workflow} and no event-driven Manki workflow` });
  });

  it.each<[string, WorkflowFile[], string]>([
    ['the dispatch file', [{ name: 'manki-dispatch.yml', text: DISPATCH_WORKFLOW_YAML, truncated: true }], 'manki-dispatch.yml is truncated, so it counts as an event-driven Manki workflow'],
    ['another workflow', [{ name: 'ci.yml', text: CI_YAML, truncated: true }, { name: 'manki-dispatch.yml', text: DISPATCH_WORKFLOW_YAML }], 'ci.yml is truncated, so it counts as an event-driven Manki workflow'],
  ])('treats a truncated text of %s as one that does not parse', (_case, workflows, reason) => {
    expect(classifyWorkflows(workflows)).toEqual({ optedIn: false, reason });
  });
});

describe('readOptIn', () => {
  const target: Target = { installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, owner: OWNER, ownerId: OWNER_ID, repo: REPO, defaultBranch: 'trunk', number: 1 };

  it('reads the workflows directory of the default branch in one query', async () => {
    const requests = stubGitHub({ api: { 'POST /graphql': workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }) } });
    expect(await readOptIn('ghs_repo', target)).toMatchObject({ optedIn: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer ghs_repo');
    expect(((await requests[0].json()) as { variables: unknown }).variables).toEqual({ owner: OWNER, name: REPO, expression: 'trunk:.github/workflows' });
  });

  it('treats a file GitHub truncated as one that does not parse', async () => {
    const requests = stubGitHub({ api: { 'POST /graphql': { body: { data: { repository: { object: { entries: [
      { name: 'manki-dispatch.yml', object: { text: DISPATCH_WORKFLOW_YAML, isTruncated: true } },
    ] } } } } } } });
    expect(await readOptIn('ghs_repo', target)).toEqual({ optedIn: false, reason: 'manki-dispatch.yml is truncated, so it counts as an event-driven Manki workflow' });
    expect(((await requests[0].json()) as { query: string }).query).toContain('isTruncated');
  });

  it('treats a missing workflows directory as not opted in', async () => {
    stubGitHub({ api: { 'POST /graphql': { body: { data: { repository: { object: null } } } } } });
    expect(await readOptIn('ghs_repo', target)).toEqual({ optedIn: false, reason: 'no Manki workflow runs on workflow_dispatch' });
  });

  it('throws on a GraphQL error', async () => {
    stubGitHub({ api: { 'POST /graphql': { body: { errors: [{ message: 'Something went wrong' }] } } } });
    await expect(readOptIn('ghs_repo', target)).rejects.toThrow('GraphQL error: Something went wrong');
  });
});
