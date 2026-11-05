import { parse } from 'yaml';
import { DISPATCH_INPUT_NAMES } from './dispatch';
import { githubGraphql } from './github';
import { DISPATCH_WORKFLOW, type Target } from './routing';

export interface OptIn {
  optedIn: boolean;
  reason: string;
}

/** A repository as GitHub names it, read by its id. */
export type Repository = Pick<Target, 'owner' | 'repo' | 'defaultBranch'>;

export interface WorkflowFile {
  name: string;
  text: string | null;
  /** Whether GitHub cut `text` short. A truncated file counts as one that does not parse. */
  truncated?: boolean;
}

/** The largest workflow file that is parsed. A larger one costs too much CPU to parse in an alarm. */
export const MAX_WORKFLOW_BYTES = 64 * 1024;

// The triggers of an event-driven Manki workflow. Any of them next to the dispatch workflow would review twice.
// A local reusable workflow (`workflow_call`) only runs through a caller, whose own triggers are checked.
const EVENT_TRIGGERS = new Set([
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
]);

// The Manki action, or the job `if` from `SETUP.md`, which manki's own workflow also carries with `uses: ./`.
// A reusable workflow in another repository hides both, so a caller of one cannot be detected.
const MANKI_WORKFLOW = /uses:\s*['"]?manki-review\/manki[@/'"\s]|manki-review\[bot\]/i;
const LOCAL_REUSABLE = /uses:\s*['"]?\.\/\.github\/workflows\/([^\s'"@]+)/gi;

const encoder = new TextEncoder();

/** Returns why `file` is never parsed, or null when it may be. */
function skipReason(file: WorkflowFile): string | null {
  if (file.truncated) return 'is truncated';
  if (file.text !== null && encoder.encode(file.text).byteLength > MAX_WORKFLOW_BYTES) return `is over ${MAX_WORKFLOW_BYTES / 1024} KB`;
  return null;
}

/**
 * Returns the `on:` of a workflow file, or null when it does not parse. It skips the duplicate key check, whose cost
 * grows with the square of a map's size.
 */
function parseOn(text: string): { on: unknown } | null {
  try {
    return { on: (parse(text, { uniqueKeys: false }) as { on?: unknown } | null)?.on };
  } catch {
    return null;
  }
}

function triggers(on: unknown): Set<string> {
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on.filter((name): name is string => typeof name === 'string'));
  if (on && typeof on === 'object') return new Set(Object.keys(on));
  return new Set();
}

/** Returns the dispatch inputs the workflow's `workflow_dispatch` trigger does not declare. */
function missingInputs(on: unknown): string[] {
  const dispatch = on && typeof on === 'object' ? (on as { workflow_dispatch?: { inputs?: Record<string, unknown> } | null }).workflow_dispatch : null;
  const declared = dispatch?.inputs ?? {};
  return DISPATCH_INPUT_NAMES.filter((name) => !Object.hasOwn(declared, name));
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
  const tooBig = skipReason(dispatch);
  if (tooBig) return { optedIn: false, reason: `${DISPATCH_WORKFLOW} ${tooBig}` };
  const parsed = parseOn(dispatch.text);
  const dispatchTriggers = parsed && triggers(parsed.on);
  if (!parsed || !dispatchTriggers?.has('workflow_dispatch')) {
    return { optedIn: false, reason: `${DISPATCH_WORKFLOW} does not run on workflow_dispatch` };
  }
  // Any other trigger would start Manki on events the Worker also dispatches.
  if (dispatchTriggers.size > 1) {
    return { optedIn: false, reason: `${DISPATCH_WORKFLOW} runs on more than workflow_dispatch` };
  }
  const missing = missingInputs(parsed.on);
  if (missing.length > 0) {
    return { optedIn: false, reason: `${DISPATCH_WORKFLOW} does not declare the inputs ${missing.join(', ')}` };
  }

  // A file that is not parsed cannot be ruled out, whether or not it looks like Manki, so it counts as event-driven.
  for (const file of files) {
    const skipped = file !== dispatch && isWorkflowFile(file.name) ? skipReason(file) : null;
    if (skipped) return { optedIn: false, reason: `${file.name} ${skipped}, so it counts as an event-driven Manki workflow` };
  }

  const manki = mankiWorkflows(files);
  for (const file of files) {
    if (file === dispatch || !isWorkflowFile(file.name) || !file.text || !manki.has(file.name)) continue;
    const on = parseOn(file.text);
    // A file that does not parse cannot be ruled out, so it counts as event-driven.
    if (on === null || [...triggers(on.on)].some((name) => EVENT_TRIGGERS.has(name))) {
      return { optedIn: false, reason: `event-driven Manki workflow ${file.name} is next to ${DISPATCH_WORKFLOW}` };
    }
  }
  return { optedIn: true, reason: `${DISPATCH_WORKFLOW} and no event-driven Manki workflow` };
}

const WORKFLOWS_QUERY = `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Tree { entries { name object { ... on Blob { text isTruncated } } } }
    }
  }
}`;

interface WorkflowsResponse {
  repository: { object: { entries?: Array<{ name: string; object: { text?: string | null; isTruncated?: boolean } | null }> } | null } | null;
}

/** Reads `.github/workflows` on the default branch in one GraphQL request and classifies it. */
export async function readOptIn(token: string, target: Repository): Promise<OptIn> {
  const data = await githubGraphql<WorkflowsResponse>(token, WORKFLOWS_QUERY, {
    owner: target.owner,
    name: target.repo,
    expression: `${target.defaultBranch}:.github/workflows`,
  });
  const entries = data.repository?.object?.entries ?? [];
  return classifyWorkflows(entries.map((entry) => ({
    name: entry.name,
    text: entry.object?.text ?? null,
    truncated: entry.object?.isTruncated === true,
  })));
}
