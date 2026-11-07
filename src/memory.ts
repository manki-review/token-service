import { createAppJWT } from './app-jwt';
import type { Env } from './env';
import { createInstallationToken, getInstallation, githubApi, logMintedToken } from './github';
import { failure, log } from './log';
import { type OIDCClaims, verifyWorkflowRequest } from './oidc';
import { dispatchedWorkflow } from './run-check';

/** The files of a repository's own memory folder a run reads and replaces. */
const REPO_FILES = ['learnings.yml', 'suppressions.yml', 'patterns.yml'] as const;
/** The files of `_global` a run reads. No run writes them. */
const GLOBAL_FILES = ['learnings.yml', 'conventions.md'] as const;
/** The files of a repository's own memory folder a run appends lines to. */
const APPEND_FILES = ['metrics/fix-rate.jsonl'] as const;

const MAX_FILE_BYTES = 512 * 1024;
/**
 * The largest an appended file grows. Each append reads and writes the whole file, which has to fit the Free plan's CPU
 * time, and the contents API returns a file of up to 1 MB in one call.
 */
const MAX_APPEND_FILE_BYTES = 1_000_000;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_LINES = 10;
const MAX_MESSAGE_LENGTH = 200;
/** Tries of an append that GitHub answers with a conflict, since another run appended meanwhile. */
const APPEND_TRIES = 3;
const SHA = /^[0-9a-f]{40}$/;

export type MemoryOperation = 'read' | 'write' | 'append';

type StoredFile = { text: string; sha: string } | null;

const encoder = new TextEncoder();

// workerd has the native base64 methods, which the TypeScript lib does not declare yet.
type Base64Bytes = Uint8Array & { toBase64(): string };
const fromBase64 = (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64;

function base64(text: string): string {
  return (encoder.encode(text) as Base64Bytes).toBase64();
}

function decode(content: string): string {
  return new TextDecoder().decode(fromBase64(content.replace(/\s/g, '')));
}

/** Returns `message` without control characters, cut to its limit, with the repository and run it comes from. */
function commitMessage(message: unknown, claims: OIDCClaims): string | null {
  if (typeof message !== 'string') return null;
  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);
  return clean ? `${clean} (${claims.repository} run ${claims.run_id})` : null;
}

/** Mints a token that writes only the central memory repository. It is used here and never returned. */
async function memoryToken(env: Env, repository: string, claims: OIDCClaims): Promise<string | null> {
  const [owner, name] = repository.split('/');
  const installation = await getInstallation(env, owner, name);
  const jwt = await createAppJWT(env);
  if (!installation) return null;
  const response = await createInstallationToken(jwt, installation.id, { contents: 'write' }, { repositories: [name] });
  if (!response.ok) throw new Error(`the memory token mint failed with ${response.status}`);
  const data = await response.json() as { token: string; permissions: Record<string, string> };
  logMintedToken({
    purpose: 'memory', repository_id: Number(claims.repository_id), repository: claims.repository, run_id: claims.run_id,
    installation_id: installation.id, permissions: data.permissions,
  });
  return data.token;
}

/** Reads `path` of the central memory repository. Null when it does not exist. */
async function readFile(token: string, repository: string, path: string): Promise<StoredFile> {
  const response = await githubApi(token, `/repos/${repository}/contents/${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`reading ${path} failed with ${response.status}`);
  const file = await response.json() as { type?: string; sha: string; encoding?: string; content?: string };
  if (file.type !== 'file') throw new Error(`${path} is not a file`);
  if (file.encoding === 'base64' && file.content !== undefined) return { text: decode(file.content), sha: file.sha };
  // The contents API leaves out a file over 1 MB, which the blob API still returns.
  const blob = await githubApi(token, `/repos/${repository}/git/blobs/${file.sha}`);
  if (!blob.ok) throw new Error(`reading the blob of ${path} failed with ${blob.status}`);
  return { text: decode((await blob.json() as { content: string }).content), sha: file.sha };
}

/** Replaces `path` with `text` if it still has `sha`, null for a new file. Returns the new sha, or null on a conflict. */
async function putFile(token: string, repository: string, path: string, text: string, sha: string | null, message: string): Promise<string | null> {
  const response = await githubApi(token, `/repos/${repository}/contents/${path}`, {
    method: 'PUT',
    body: { message, content: base64(text), ...(sha && { sha }) },
  });
  // A stale sha gives 409, and a missing sha for a file that exists gives a 422 that names the sha. Any other 422 is an
  // error the run cannot fix by reading again.
  if (response.status === 409) return null;
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 422 && /\bsha\b/i.test(text)) return null;
    throw new Error(`writing ${path} failed with ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json() as { content: { sha: string } }).content.sha;
}

/** Returns the lines of an append, or why they are refused. Each line is one JSON object with no line break. */
function appendLines(lines: unknown): string[] | string {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) return `lines must hold 1 to ${MAX_LINES} lines`;
  for (const line of lines) {
    if (typeof line !== 'string' || /[\r\n]/.test(line) || encoder.encode(line).byteLength > MAX_LINE_BYTES) {
      return `each line must be a string of at most ${MAX_LINE_BYTES} bytes without a line break`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return 'each line must be JSON';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'each line must be a JSON object';
  }
  return lines as string[];
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/**
 * Serves `/memory/read`, `/memory/write` and `/memory/append` for the dispatched Manki run of a repository. The Worker
 * reads and writes the central memory repository itself, only under that repository's own folder, and reads `_global`.
 * No memory token leaves the Worker.
 */
export async function handleMemory(request: Request, env: Env, operation: MemoryOperation): Promise<Response> {
  const verified = await verifyWorkflowRequest(request, env);
  if (verified instanceof Response) return verified;
  const { claims, body } = verified;
  if (typeof body.pr !== 'number' || !Number.isSafeInteger(body.pr) || body.pr <= 0) return bad('pr must be a positive integer');
  const repository = env.MEMORY_REPO;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) return bad('no memory repository is configured', 503);

  const workflow = dispatchedWorkflow(claims);
  const refused = typeof workflow === 'string'
    ? workflow
    : await env.PR_COORDINATOR.getByName(`${claims.repository_id}:${body.pr}`).refuseRun(Number(claims.run_id), null, workflow.file, workflow.ref);
  const audit = { repository: claims.repository, pr: body.pr, run_id: claims.run_id, operation };
  if (refused !== null) {
    log('memory_refused', { ...audit, reason: refused });
    return bad(`Only the run Manki dispatched may use memory: ${refused}`, 403);
  }
  // A folder is `<login>/<repo>`, and a login never holds `_`, so no repository's folder can be inside `_global`.
  const folder = claims.repository.toLowerCase();

  try {
    const token = await memoryToken(env, repository, claims);
    if (token === null) return bad(`the App is not installed on ${repository}`, 503);

    if (operation === 'read') {
      const read = async (prefix: string, files: readonly string[]) => Object.fromEntries(
        await Promise.all(files.map(async (file) => [file, await readFile(token, repository, `${prefix}/${file}`)] as const)),
      );
      return Response.json({ repo: await read(folder, REPO_FILES), global: await read('_global', GLOBAL_FILES) });
    }

    const message = commitMessage(body.message, claims);
    if (message === null) return bad('message must be a non-empty string');

    if (operation === 'write') {
      const { file, content, sha } = body;
      if (typeof file !== 'string' || !(REPO_FILES as readonly string[]).includes(file)) return bad(`file must be one of ${REPO_FILES.join(', ')}`);
      if (typeof content !== 'string') return bad('content must be a string');
      if (encoder.encode(content).byteLength > MAX_FILE_BYTES) return bad(`content is over ${MAX_FILE_BYTES} bytes`, 413);
      if (sha !== null && (typeof sha !== 'string' || !SHA.test(sha))) return bad('sha must be the file\'s blob sha, or null for a new file');
      const written = await putFile(token, repository, `${folder}/${file}`, content, sha, message);
      log('memory_write', { ...audit, file, bytes: encoder.encode(content).byteLength, conflict: written === null });
      return written === null ? bad('the file changed since it was read', 409) : Response.json({ sha: written });
    }

    const { file } = body;
    if (typeof file !== 'string' || !(APPEND_FILES as readonly string[]).includes(file)) return bad(`file must be one of ${APPEND_FILES.join(', ')}`);
    const lines = appendLines(body.lines);
    if (typeof lines === 'string') return bad(lines);
    const path = `${folder}/${file}`;
    for (let attempt = 1; attempt <= APPEND_TRIES; attempt++) {
      const current = await readFile(token, repository, path);
      const before = current === null || current.text === '' || current.text.endsWith('\n') ? current?.text ?? '' : `${current.text}\n`;
      const text = `${before}${lines.join('\n')}\n`;
      if (encoder.encode(text).byteLength > MAX_APPEND_FILE_BYTES) {
        log('memory_append_full', { ...audit, file });
        return bad(`${file} would grow over ${MAX_APPEND_FILE_BYTES} bytes`, 413);
      }
      const written = await putFile(token, repository, path, text, current?.sha ?? null, message);
      if (written !== null) {
        log('memory_append', { ...audit, file, lines: lines.length, attempt });
        return Response.json({ sha: written });
      }
    }
    log('memory_append_conflict', { ...audit, file });
    return bad(`${file} kept changing, try again`, 409);
  } catch (error) {
    return failure(502, `Memory ${operation} failed`, { ...audit, detail: String(error) });
  }
}
