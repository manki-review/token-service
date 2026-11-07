import type { Env } from './env';
import { githubApi, githubGraphql, mintRepositoryToken } from './github';
import { failure, log } from './log';
import { MANKI_LOGINS } from './manki';
import { verifyWorkflowRequest } from './oidc';
import { checkDispatchedRun } from './run-check';

/** The reasons `resolveReviewThread` takes, as GitHub shows them on the resolved thread. */
const RESOLUTION_REASONS = ['ADDRESSED', 'INVALID', 'WONT_FIX'];

/** A GraphQL node id, such as `PRRT_kwDOABCD1234`. */
const NODE_ID = /^[A-Za-z0-9_=-]{1,128}$/;

/** GitHub requires `contents: write` to resolve a thread, so only this short-lived token holds it, never the run. */
const RESOLVE_PERMISSIONS = { contents: 'write', pull_requests: 'write' };

const THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      pullRequest { number repository { databaseId } }
      comments(first: 1) { nodes { author { login } } }
    }
  }
}`;

interface ThreadNode {
  pullRequest?: { number: number; repository: { databaseId: number } };
  comments?: { nodes: Array<{ author: { login: string } | null }> };
}

const RESOLVE_MUTATION = `mutation($id: ID!, $reason: PullRequestReviewThreadResolutionReason) {
  result: resolveReviewThread(input: { threadId: $id, resolutionReason: $reason }) { thread { isResolved } }
}`;

const UNRESOLVE_MUTATION = `mutation($id: ID!) {
  result: unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`;

/** Reads the thread `id`. Returns null when GitHub knows no node by that id, which it reports as an error. */
async function readThread(token: string, id: string): Promise<ThreadNode | null> {
  const response = await githubApi(token, '/graphql', { method: 'POST', body: { query: THREAD_QUERY, variables: { id } } });
  if (!response.ok) throw new Error(`reading the thread failed with ${response.status}`);
  const result = await response.json() as { data?: { node: ThreadNode | null }; errors?: Array<{ type?: string; message: string }> };
  if (result.errors?.some((error) => error.type !== 'NOT_FOUND')) {
    throw new Error(`GraphQL error: ${result.errors.map((error) => error.message).join('; ')}`);
  }
  return result.data?.node ?? null;
}

/** Whether a GraphQL login is one of Manki's. GraphQL names a bot `<slug>`, while REST and webhooks use `<slug>[bot]`. */
function isMankiLogin(login: string | undefined): boolean {
  return login !== undefined && MANKI_LOGINS.includes(`${login}[bot]`);
}

/**
 * Serves `/resolve`, through which the run a PR coordinator dispatched resolves or reopens one of Manki's review threads
 * on its PR. It takes the workflow's OIDC token like `/token`, so the run itself never needs `contents: write`.
 */
export async function handleResolve(request: Request, env: Env): Promise<Response> {
  const verified = await verifyWorkflowRequest(request, env);
  if (verified instanceof Response) return verified;
  const { claims, body, installation } = verified;
  const { thread_id: threadId, resolved, reason } = body;
  if (typeof threadId !== 'string' || !NODE_ID.test(threadId)) {
    return Response.json({ error: 'thread_id must be a review thread node id' }, { status: 400 });
  }
  if (typeof resolved !== 'boolean') return Response.json({ error: 'resolved must be a boolean' }, { status: 400 });
  if (reason !== undefined && (!resolved || typeof reason !== 'string' || !RESOLUTION_REASONS.includes(reason))) {
    return Response.json({ error: `reason must be one of ${RESOLUTION_REASONS.join(', ')}, and only with resolved: true` }, { status: 400 });
  }

  const repositoryId = Number(claims.repository_id);
  const audit = { repository: claims.repository, run_id: claims.run_id, thread_id: threadId, resolved };
  try {
    const run = await checkDispatchedRun(env, claims, installation.id, repositoryId);
    if ('refused' in run) {
      log('resolve_refused', { ...audit, reason: run.refused });
      return Response.json({ error: `Only the run Manki dispatched may resolve threads: ${run.refused}` }, { status: 403 });
    }
    const mint = await mintRepositoryToken(env, installation.id, repositoryId, RESOLVE_PERMISSIONS, { purpose: 'resolve', repository: claims.repository });
    if (!mint.ok) return failure(mint.refused ? 403 : 500, 'Token mint failed', { ...audit, detail: mint.message });

    const thread = await readThread(mint.token, threadId);
    const pr = thread?.pullRequest;
    if (pr?.repository.databaseId !== repositoryId || pr.number !== run.pr || !isMankiLogin(thread?.comments?.nodes[0]?.author?.login)) {
      log('resolve_refused', { ...audit, pr: run.pr, reason: 'not a Manki thread on the run\'s pull request' });
      return Response.json({ error: 'No Manki review thread with that id on the run\'s pull request' }, { status: 404 });
    }

    const { result } = await githubGraphql<{ result: { thread: { isResolved: boolean } } }>(
      mint.token, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, resolved ? { id: threadId, reason: reason ?? null } : { id: threadId },
    );
    log('thread_resolved', { ...audit, pr: run.pr, ...(reason !== undefined && { resolution_reason: reason }) });
    return Response.json({ resolved: result.thread.isResolved });
  } catch (error) {
    return failure(500, 'Resolving the thread failed', { ...audit, detail: String(error) });
  }
}
