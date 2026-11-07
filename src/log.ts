/** Writes one JSON log line, which Workers Logs indexes by field. */
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields }));
}

/**
 * Logs `details` under a new request id and returns an error response that carries only `error` and that id. The
 * details can hold upstream bodies and exception text, which no caller should see.
 */
export function failure(status: number, error: string, details: Record<string, unknown>): Response {
  const requestId = crypto.randomUUID();
  log('request_failed', { request_id: requestId, status, error, ...details });
  return Response.json({ error, request_id: requestId }, { status });
}
