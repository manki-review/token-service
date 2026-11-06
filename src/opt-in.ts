import { parse } from 'yaml';
import { DISPATCH_INPUT_NAMES } from './dispatch';
import { githubGraphql } from './github';
import type { Target } from './routing';

/**
 * Whether a repository opted in to webhook mode, and the file name of the workflow the Worker dispatches when it did.
 * `others` names the other files that qualified, which are never dispatched.
 */
export type OptIn = { optedIn: true; workflow: string; others?: string[]; reason: string } | { optedIn: false; reason: string };

/** A repository as GitHub names it, read by its id. */
export type Repository = Pick<Target, 'owner' | 'ownerId' | 'repo' | 'defaultBranch'>;

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

/** The dispatch workflow's file name. It is picked first when several files qualify. */
const DISPATCH_WORKFLOW = 'manki.yml';

type WorkflowText = WorkflowFile & { text: string };

/** Returns why `file` cannot be the dispatch workflow, and whether it runs on `workflow_dispatch` at all. */
function dispatchProblem(file: WorkflowText): { reason: string; dispatched: boolean } | null {
  const parsed = parseOn(file.text);
  const names = parsed && triggers(parsed.on);
  if (!parsed || !names?.has('workflow_dispatch')) return { reason: `${file.name} does not run on workflow_dispatch`, dispatched: false };
  // Any other trigger would start Manki on events the Worker also dispatches.
  if (names.size > 1) return { reason: `${file.name} runs on more than workflow_dispatch`, dispatched: true };
  const missing = missingInputs(parsed.on);
  return missing.length > 0 ? { reason: `${file.name} does not declare the inputs ${missing.join(', ')}`, dispatched: true } : null;
}

/**
 * Decides whether a repository opted in to webhook mode from the workflow files on its default branch, and which file
 * the Worker dispatches. A file qualifies when it runs only on `workflow_dispatch` and declares all the dispatch inputs,
 * whether or not it names Manki: the input set alone marks it, as in manki's own file, which runs `uses: ./`. With
 * several, `manki.yml` goes first, then the first by name. No other file may be an event-driven Manki workflow.
 */
export function classifyWorkflows(files: WorkflowFile[]): OptIn {
  // A file that is not parsed cannot be ruled out, whether or not it looks like Manki.
  for (const file of files) {
    const skipped = isWorkflowFile(file.name) ? skipReason(file) : null;
    if (skipped) return { optedIn: false, reason: `${file.name} ${skipped}, so it counts as an event-driven Manki workflow` };
  }

  const manki = mankiWorkflows(files);
  const rank = (file: WorkflowFile) => (file.name === DISPATCH_WORKFLOW ? 0 : 1);
  // A file that names Manki is a candidate whatever its problem, so the reason can name what it lacks.
  const candidates = files
    .filter((file): file is WorkflowText => isWorkflowFile(file.name) && file.text !== null)
    .map((file) => ({ file, problem: dispatchProblem(file) }))
    .filter((candidate) => candidate.problem === null || manki.has(candidate.file.name))
    .sort((a, b) => rank(a.file) - rank(b.file) || a.file.name.localeCompare(b.file.name));
  const dispatch = candidates.find((candidate) => candidate.problem === null)?.file;
  if (!dispatch) {
    const near = candidates.find((candidate) => candidate.problem?.dispatched)?.problem;
    return { optedIn: false, reason: near?.reason ?? 'no Manki workflow runs on workflow_dispatch' };
  }

  for (const file of files) {
    if (file === dispatch || !isWorkflowFile(file.name) || !file.text || !manki.has(file.name)) continue;
    const on = parseOn(file.text);
    // A file that does not parse cannot be ruled out, so it counts as event-driven.
    if (on === null || [...triggers(on.on)].some((name) => EVENT_TRIGGERS.has(name))) {
      return { optedIn: false, reason: `event-driven Manki workflow ${file.name} is next to ${dispatch.name}` };
    }
  }
  const others = candidates.filter((candidate) => candidate.problem === null && candidate.file !== dispatch).map((candidate) => candidate.file.name);
  return {
    optedIn: true,
    workflow: dispatch.name,
    ...(others.length > 0 && { others }),
    reason: `${dispatch.name} and no event-driven Manki workflow`,
  };
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
