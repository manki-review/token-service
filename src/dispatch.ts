// The `workflow_dispatch` contract with Manki's dispatch adapter (`readDispatchInputs` in manki `src/dispatch.ts`)
// and the dispatch workflow in its `SETUP.md`. A change on either side must be made on both.

export interface DispatchItem {
  /** `<event>.<action>`, such as `pull_request.synchronize`. */
  event: string;
  head_sha: string | null;
  object_id: number | null;
  delivery: string;
}

/** Returns the inputs for a run of `manki-dispatch.yml` that replays `item` on PR or issue `number`. */
export function dispatchInputs(item: DispatchItem, number: number): Record<string, string> {
  const [event, action] = item.event.split('.');
  const inputs: Record<string, string> = { event, action, pr: String(number), delivery_id: item.delivery };
  if (event === 'pull_request' && item.head_sha) inputs.head_sha = item.head_sha;
  if (item.object_id !== null) inputs[event === 'pull_request_review' ? 'review_id' : 'comment_id'] = String(item.object_id);
  return inputs;
}

/**
 * The `display_title` the dispatch workflow's `run-name` gives a run of `item`:
 * `Manki ${{ inputs.event }}.${{ inputs.action }} on #${{ inputs.pr }} (${{ inputs.delivery_id }})`.
 * The delivery id makes it unique to one item, so a lost dispatch response can be matched exactly.
 */
export function runTitle(item: Pick<DispatchItem, 'event' | 'delivery'>, number: number): string {
  return `Manki ${item.event} on #${number} (${item.delivery})`;
}

/**
 * Reads the PR or issue number back out of a dispatch run's `display_title`. A title without the delivery id, from a
 * workflow that predates it, still names the PR.
 */
export function numberFromRunTitle(title: string | undefined): number | undefined {
  const match = title?.match(/^Manki [a-z_]+\.[a-z_]+ on #([1-9][0-9]*)(?: \([A-Za-z0-9-]{1,64}\))?$/);
  return match ? Number(match[1]) : undefined;
}
