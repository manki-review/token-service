import type { Env } from './env';
import { log } from './log';
import { routeDelivery, type Route, type WebhookPayload } from './routing';
import { verifyWebhookSignature } from './signature';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    case 'run_completed':
      return { route: 'run_completed', pr: route.target.number, run_id: route.runId, conclusion: route.conclusion };
  }
}

/**
 * Verifies a GitHub App webhook delivery, logs its route and hands work and closes to the PR's `PrCoordinator`.
 * The 202 leaves only once the coordinator stored the delivery, so a failure there makes GitHub record a failed
 * delivery that can be redelivered.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    console.error('WEBHOOK_SECRET is not set, refusing webhook deliveries');
    return Response.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  // GitHub caps webhook payloads at 25 MB, so anything larger is not a delivery.
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, body, request.headers.get('X-Hub-Signature-256')))) {
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

  const route = routeDelivery(event, payload);
  log('webhook', { delivery, event, action: payload.action ?? null, ...summarize(route) });
  if (route.type === 'work' || route.type === 'close') {
    try {
      await env.PR_COORDINATOR.getByName(`${route.target.repositoryId}:${route.target.number}`).receive(delivery, route);
    } catch (error) {
      log('webhook_coordinator_error', { delivery, error: String(error) });
      return Response.json({ error: 'Could not queue the delivery' }, { status: 500 });
    }
  }
  return new Response(null, { status: 202 });
}
