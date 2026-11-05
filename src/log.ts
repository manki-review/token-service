/** Writes one JSON log line, which Workers Logs indexes by field. */
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields }));
}
