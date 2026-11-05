import { parse } from 'yaml';
import { githubGraphql } from './github';
import { DISPATCH_WORKFLOW, type Target } from './routing';

export interface OptIn {
  optedIn: boolean;
  reason: string;
}

export interface WorkflowFile {
  name: string;
  text: string | null;
}

// The triggers of an event-driven Manki workflow. Any of them next to the dispatch workflow would review twice.
// `workflow_call` counts too: such a reusable workflow runs whenever another workflow is triggered.
const EVENT_TRIGGERS = new Set([
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'workflow_call',
]);

// The Manki action, or the job `if` from `SETUP.md`, which manki's own workflow also carries with `uses: ./`.
// A reusable workflow in another repository hides both, so a caller of one cannot be detected.
const MANKI_WORKFLOW = /uses:\s*['"]?manki-review\/manki[@/'"\s]|manki-review\[bot\]/i;
const LOCAL_REUSABLE = /uses:\s*['"]?\.\/\.github\/workflows\/([^\s'"@]+)/gi;

function triggers(text: string): Set<string> | null {
  let workflow: unknown;
  try {
    workflow = parse(text);
  } catch {
    return null;
  }
  const on = (workflow as { on?: unknown } | null)?.on;
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on.filter((name): name is string => typeof name === 'string'));
  if (on && typeof on === 'object') return new Set(Object.keys(on));
  return new Set();
}

function isWorkflowFile(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

/** Returns the names of the workflow files that run Manki, directly or through a local reusable workflow. */
function mankiWorkflows(files: WorkflowFile[]): Set<string> {
  const manki = new Set(files.filter((file) => file.text && MANKI_WORKFLOW.test(file.text)).map((file) => file.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const file of files) {
      if (manki.has(file.name) || !file.text) continue;
      const called = [...file.text.matchAll(LOCAL_REUSABLE)].map((match) => match[1]);
      if (called.some((name) => manki.has(name))) {
        manki.add(file.name);
        grew = true;
      }
    }
  }
  return manki;
}

/**
 * Decides whether a repository opted in to webhook mode from the workflow files on its default branch. It opts in
 * when `manki-dispatch.yml` runs on `workflow_dispatch` and no other file is an event-driven Manki workflow.
 */
export function classifyWorkflows(files: WorkflowFile[]): OptIn {
  const dispatch = files.find((file) => file.name === DISPATCH_WORKFLOW);
  if (!dispatch?.text) return { optedIn: false, reason: `no ${DISPATCH_WORKFLOW}` };
  if (!triggers(dispatch.text)?.has('workflow_dispatch')) {
    return { optedIn: false, reason: `${DISPATCH_WORKFLOW} does not run on workflow_dispatch` };
  }

  const manki = mankiWorkflows(files);
  for (const file of files) {
    if (file === dispatch || !isWorkflowFile(file.name) || !file.text || !manki.has(file.name)) continue;
    const on = triggers(file.text);
    // A file that does not parse cannot be ruled out, so it counts as event-driven.
    if (on === null || [...on].some((name) => EVENT_TRIGGERS.has(name))) {
      return { optedIn: false, reason: `event-driven Manki workflow ${file.name} is next to ${DISPATCH_WORKFLOW}` };
    }
  }
  return { optedIn: true, reason: `${DISPATCH_WORKFLOW} and no event-driven Manki workflow` };
}

const WORKFLOWS_QUERY = `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Tree { entries { name object { ... on Blob { text } } } }
    }
  }
}`;

interface WorkflowsResponse {
  repository: { object: { entries?: Array<{ name: string; object: { text?: string | null } | null }> } | null } | null;
}

/** Reads `.github/workflows` on the default branch in one GraphQL request and classifies it. */
export async function readOptIn(token: string, target: Target): Promise<OptIn> {
  const data = await githubGraphql<WorkflowsResponse>(token, WORKFLOWS_QUERY, {
    owner: target.owner,
    name: target.repo,
    expression: `${target.defaultBranch}:.github/workflows`,
  });
  const entries = data.repository?.object?.entries ?? [];
  return classifyWorkflows(entries.map((entry) => ({ name: entry.name, text: entry.object?.text ?? null })));
}
