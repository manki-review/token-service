import { describe, expect, it } from 'vitest';
import { classifyWorkflows, readOptIn, type WorkflowFile } from '../src/opt-in';
import type { Target } from '../src/routing';
import { INSTALLATION_ID, OWNER, REPO, stubGitHub } from './helpers';
import { DISPATCH_WORKFLOW_YAML, EVENT_WORKFLOW_YAML, REPOSITORY_ID, workflowsReply } from './payloads';

const CI_YAML = 'name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
// manki's own workflow runs the local build with `uses: ./`, so only its job `if` names Manki.
const SELF_TEST_YAML = "on: [pull_request_review]\njobs:\n  review:\n    if: github.actor != 'manki-review[bot]'\n    steps:\n      - uses: ./\n";

function files(entries: Record<string, string | null>): WorkflowFile[] {
  return Object.entries(entries).map(([name, text]) => ({ name, text }));
}

describe('classifyWorkflows', () => {
  it.each<[string, Record<string, string | null>, boolean, string]>([
    ['no workflows', {}, false, 'no manki-dispatch.yml'],
    ['the dispatch workflow alone', { 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, true, 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['the dispatch workflow and CI', { 'ci.yml': CI_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, true, 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['both Manki workflows', { 'manki.yml': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow manki.yml is next to manki-dispatch.yml'],
    ['an event-driven workflow under another name', { 'review.yaml': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow review.yaml is next to manki-dispatch.yml'],
    ["manki's self-test workflow", { 'manki.yml': SELF_TEST_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow manki.yml is next to manki-dispatch.yml'],
    ['a Manki workflow on a single event', { 'm.yml': "on: issue_comment\njobs: { r: { steps: [{ uses: 'manki-review/manki@v6' }] } }", 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow m.yml is next to manki-dispatch.yml'],
    ['a Manki workflow on a schedule only', { 'nightly.yml': 'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, true, 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a Manki workflow that does not parse', { 'broken.yml': 'on: [pull_request\nuses: manki-review/manki@v6', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow broken.yml is next to manki-dispatch.yml'],
    ['an unrelated file that does not parse', { 'broken.yml': 'on: [pull_request', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, true, 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a Manki README next to the dispatch workflow', { 'README.md': EVENT_WORKFLOW_YAML, 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, true, 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a Manki workflow on pull_request_target', { 'm.yml': 'on: pull_request_target\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow m.yml is next to manki-dispatch.yml'],
    ['a Manki action written in mixed case', { 'm.yml': 'on: [pull_request]\njobs: { r: { steps: [{ uses: Manki-Review/Manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow m.yml is next to manki-dispatch.yml'],
    ['a local reusable Manki workflow and its caller', { 'a-caller.yml': 'on: [pull_request]\njobs:\n  review:\n    uses: ./.github/workflows/review.yml\n', 'review.yml': 'on:\n  workflow_call:\njobs: { r: { steps: [{ uses: manki-review/manki@v6 }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, false, 'event-driven Manki workflow a-caller.yml is next to manki-dispatch.yml'],
    ['a caller of a local reusable workflow without Manki', { 'a-caller.yml': 'on: [pull_request]\njobs:\n  test:\n    uses: ./.github/workflows/test.yml\n', 'test.yml': 'on: [workflow_call]\njobs: { t: { steps: [{ run: npm test }] } }', 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }, true, 'manki-dispatch.yml and no event-driven Manki workflow'],
    ['a dispatch file without workflow_dispatch', { 'manki-dispatch.yml': EVENT_WORKFLOW_YAML }, false, 'manki-dispatch.yml does not run on workflow_dispatch'],
    ['a dispatch file under the .yaml extension', { 'manki-dispatch.yaml': DISPATCH_WORKFLOW_YAML }, false, 'no manki-dispatch.yml'],
    ['an unreadable dispatch file', { 'manki-dispatch.yml': null }, false, 'no manki-dispatch.yml'],
  ])('classifies %s', (_case, entries, optedIn, reason) => {
    expect(classifyWorkflows(files(entries))).toEqual({ optedIn, reason });
  });
});

describe('readOptIn', () => {
  const target: Target = { installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, owner: OWNER, repo: REPO, defaultBranch: 'trunk', number: 1 };

  it('reads the workflows directory of the default branch in one query', async () => {
    const requests = stubGitHub({ api: { 'POST /graphql': workflowsReply({ 'manki-dispatch.yml': DISPATCH_WORKFLOW_YAML }) } });
    expect(await readOptIn('ghs_repo', target)).toMatchObject({ optedIn: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer ghs_repo');
    expect(((await requests[0].json()) as { variables: unknown }).variables).toEqual({ owner: OWNER, name: REPO, expression: 'trunk:.github/workflows' });
  });

  it('treats a missing workflows directory as not opted in', async () => {
    stubGitHub({ api: { 'POST /graphql': { body: { data: { repository: { object: null } } } } } });
    expect(await readOptIn('ghs_repo', target)).toEqual({ optedIn: false, reason: 'no manki-dispatch.yml' });
  });

  it('throws on a GraphQL error', async () => {
    stubGitHub({ api: { 'POST /graphql': { body: { errors: [{ message: 'Something went wrong' }] } } } });
    await expect(readOptIn('ghs_repo', target)).rejects.toThrow('GraphQL error: Something went wrong');
  });
});
