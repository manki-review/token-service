import { readBody } from './body';
import { allowedAccounts, type Env } from './env';
import { githubGraphql, hasWriteAccess, mintRepositoryToken } from './github';
import { eventsPerHour } from './limiter';
import { log } from './log';
import { routeDelivery, type Route, type Target, type Work, type WebhookPayload } from './routing';
import { sha256Hex, verifyWebhookSignature } from './signature';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a login's write access to a repository is reused. */
const WRITER_CACHE_MS = 5 * 60_000;
const MAX_CACHED_WRITERS = 10_000;
const writers = new Map<string, { writer: boolean; until: number }>();
/** The read-only tokens of the lookups, by installation and repository. Kept in memory only, never logged. */
const lookupTokens = new Map<string, { token: string; expiresAt: number }>();
/** A token is minted again this long before it expires, so a lookup never uses one that runs out midway. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * Returns a token for the target's repository that reads permissions, and pull requests for an editor lookup, minting
 * one only when none is held or it nears expiry.
 */
async function lookupToken(env: Env, target: Target): Promise<string> {
  const key = `${target.installationId}:${target.repositoryId}`;
  const held = lookupTokens.get(key);
  if (held && held.expiresAt - TOKEN_MARGIN_MS > Date.now()) return held.token;
  const repository = `${target.owner}/${target.repo}`;
  const mint = await mintRepositoryToken(env, target.installationId, target.repositoryId, { metadata: 'read', pull_requests: 'read' }, { purpose: 'writer_check', repository });
  if (!mint.ok) throw new Error(`the token mint failed with ${mint.status}`);
  if (lookupTokens.size >= MAX_CACHED_WRITERS) lookupTokens.clear();
  lookupTokens.set(key, { token: mint.token, expiresAt: mint.expiresAt });
  return mint.token;
}

/**
 * Whether `login` has write access to the target's repository, reused for `WRITER_CACHE_MS` per installation,
 * repository and login within one isolate. Any failure reads as no write access and is not reused, so the
 * coordinator looks the sender up again before it starts the work.
 */
async function isWriter(env: Env, target: Target, login: string): Promise<boolean> {
  const key = `${target.installationId}:${target.repositoryId}:${login.toLowerCase()}`;
  const cached = writers.get(key);
  if (cached && cached.until > Date.now()) return cached.writer;
  try {
    const writer = await hasWriteAccess(await lookupToken(env, target), target.owner, target.repo, login);
    if (writers.size >= MAX_CACHED_WRITERS) writers.clear();
    writers.set(key, { writer, until: Date.now() + WRITER_CACHE_MS });
    return writer;
  } catch (error) {
    log('webhook_writer_check_failed', { repository_id: target.repositoryId, sender: login, error: String(error) });
    return false;
  }
}

/**
 * Names the last editor of an edited review as the work's sender, since GitHub sends the review's author. Returns
 * `null` when the editor is unknown or a bot, such as Manki rewriting its own review.
 */
async function editedWork(env: Env, target: Target, work: Work): Promise<Work | null> {
  if (!work.editorOf) return work;
  try {
    const { node } = await githubGraphql<{ node: { editor: { login: string; __typename: string } | null } | null }>(
      await lookupToken(env, target),
      'query($id: ID!) { node(id: $id) { ... on PullRequestReview { editor { login __typename } } } }',
      { id: work.editorOf },
    );
    const editor = node?.editor;
    return editor && editor.__typename !== 'Bot' ? { ...work, sender: editor.login } : null;
  } catch (error) {
    log('webhook_editor_lookup_failed', { repository_id: target.repositoryId, error: String(error) });
    return null;
  }
}

/** Settles `writer` with a lookup when the payload cannot. A writer is a repository user, so the work is trusted too. */
async function checkedWork(env: Env, target: Target, work: Work): Promise<Work> {
  if (!work.checkWriter) return work;
  const writer = work.sender !== '' && await isWriter(env, target, work.sender);
  return { ...work, writer, trusted: work.trusted || writer, checkWriter: false };
}

function summarize(route: Route): Record<string, unknown> {
  switch (route.type) {
    case 'ignore':
      return { route: 'ignore', reason: route.reason };
    case 'work': {
      const { lane, kind, event, headSha, objectId, sender } = route.work;
      return {
        route: lane, pr: route.target.number, repository_id: route.target.repositoryId,
        kind, dispatch_event: event, head_sha: headSha, object_id: objectId, sender,
      };
    }
    case 'close':
      return { route: 'close', pr: route.target.number, repository_id: route.target.repositoryId, merged: route.merged !== null };
    case 'seen':
      return { route: 'seen', pr: route.target.number, repository_id: route.target.repositoryId, head_sha: route.headSha };
    case 'reopen':
      return { route: 'reopen', pr: route.target.number, repository_id: route.target.repositoryId };
    case 'run_completed':
      return { route: 'run_completed', pr: route.target.number, run_id: route.runId, conclusion: route.conclusion };
  }
}

/**
 * Verifies a GitHub App webhook delivery, logs its route and hands work, closes and run ends to the PR's
 * `PrCoordinator`.
 * The 202 leaves only once the coordinator stored the delivery, so a failure there makes GitHub record a failed
 * delivery that can be redelivered.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    console.error('WEBHOOK_SECRET is not set, refusing webhook deliveries');
    return Response.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  // GitHub caps webhook payloads at 25 MB, so anything larger is not a delivery. A chunked body has no
  // `Content-Length`, so the limit is also enforced while reading.
  const tooLarge = () => Response.json({ error: 'Payload too large' }, { status: 413 });
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return tooLarge();
  const signature = request.headers.get('X-Hub-Signature-256');
  // The previous secret stays valid while a rotation is under way, so no delivery fails in between.
  const signed = await verifyWebhookSignature(env.WEBHOOK_SECRET, body, signature)
    || await verifyWebhookSignature(env.WEBHOOK_SECRET_PREVIOUS ?? '', body, signature);
  if (!signed) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  if (request.headers.get('X-GitHub-Hook-Installation-Target-ID') !== env.APP_ID) {
    return Response.json({ error: 'Delivery is not for this App' }, { status: 403 });
  }

  const event = request.headers.get('X-GitHub-Event');
  const delivery = request.headers.get('X-GitHub-Delivery');
  if (!event || !delivery || !DELIVERY_ID.test(delivery)) {
    return Response.json({ error: 'X-GitHub-Event and X-GitHub-Delivery headers required' }, { status: 400 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const routed = routeDelivery(event, payload);
  // Every routed delivery writes Durable Object storage, which the account's daily row quota pays for. Only the
  // repositories of listed accounts may spend it, so a script on another installation cannot use it up.
  let route: Route = routed.type !== 'ignore' && !allowedAccounts(env).has(routed.target.ownerId)
    ? { type: 'ignore', reason: `account ${routed.target.ownerId} is not in WEBHOOK_ACCOUNTS` }
    : routed;
  if (route.type === 'work') {
    const edited = await editedWork(env, route.target, route.work);
    route = edited ? { ...route, work: await checkedWork(env, route.target, edited) } : { type: 'ignore', reason: 'the review\'s editor is unknown or a bot' };
  }
  // One installation may store only so many deliveries from people without write access an hour, so a flood from it
  // cannot use up the quota either, and outsiders only use up their own share. A close or a run's end is never capped.
  // Only a writer can edit Manki's settings comment, so its edits are exempt although the editor is looked up later.
  const limiter = route.type === 'work' && !route.work.writer && route.work.kind !== 'settings'
    ? env.INSTALLATION_LIMITER.getByName(String(route.target.installationId))
    : null;
  if (limiter && route.type !== 'ignore') {
    const limit = eventsPerHour(env);
    try {
      if (!await limiter.hasRoom(limit)) {
        route = { type: 'ignore', reason: `installation ${route.target.installationId} is over ${limit} events this hour` };
      }
    } catch (error) {
      log('webhook_limiter_error', { delivery, error: String(error) });
      return Response.json({ error: 'Could not queue the delivery' }, { status: 500 });
    }
  }
  log('webhook', { delivery, event, action: payload.action ?? null, ...summarize(route) });
  if (route.type !== 'ignore') {
    const coordinator = env.PR_COORDINATOR.getByName(`${route.target.repositoryId}:${route.target.number}`);
    // A thread event names no time, so resolving, reopening and resolving again send the same body. A replay of one
    // only adds a review state check, which merges with the queued one, so its id alone is checked.
    const key = { id: delivery, bodyHash: event === 'pull_request_review_thread' ? null : await sha256Hex(body) };
    let stored = false;
    try {
      if (route.type === 'run_completed') await coordinator.runCompleted(key, route.runId, route.conclusion);
      else if (route.type === 'seen') await coordinator.markSeen(key, route.target, route.headSha);
      else if (route.type === 'reopen') await coordinator.reopen(key, route.target, route.at);
      else stored = (await coordinator.receive(key, route)).accepted;
    } catch (error) {
      log('webhook_coordinator_error', { delivery, error: String(error) });
      return Response.json({ error: 'Could not queue the delivery' }, { status: 500 });
    }
    // Only stored work counts, so a replay the coordinator refused writes nothing here either. The delivery is stored,
    // so a failure to count it is only logged.
    if (limiter && stored) {
      try {
        await limiter.add();
      } catch (error) {
        log('webhook_limiter_error', { delivery, error: String(error) });
      }
    }
  }
  return new Response(null, { status: 202 });
}
