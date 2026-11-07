import { describe, expect, it } from 'vitest';
import { dispatchInputs, numberFromRunTitle, runTitle } from '../src/dispatch';

const SHA = 'a'.repeat(40);
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

describe('dispatchInputs', () => {
  it.each<[string, { event: string; head_sha: string | null; object_id: number | null }, Record<string, string>]>([
    ['a push', { event: 'pull_request.synchronize', head_sha: SHA, object_id: null }, { event: 'pull_request', action: 'synchronize', head_sha: SHA }],
    ['a merge', { event: 'pull_request.closed', head_sha: SHA, object_id: null }, { event: 'pull_request', action: 'closed', head_sha: SHA }],
    ['a review', { event: 'pull_request_review.submitted', head_sha: SHA, object_id: 5 }, { event: 'pull_request_review', action: 'submitted', review_id: '5' }],
    ['a thread reply', { event: 'pull_request_review_comment.created', head_sha: SHA, object_id: 6 }, { event: 'pull_request_review_comment', action: 'created', comment_id: '6' }],
    ['a review request', { event: 'issue_comment.created', head_sha: SHA, object_id: 7 }, { event: 'issue_comment', action: 'created', comment_id: '7' }],
    ['a settings box review', { event: 'issue_comment.edited', head_sha: null, object_id: 8 }, { event: 'issue_comment', action: 'edited', comment_id: '8' }],
    ['a resolved thread', { event: 'pull_request_review_thread.resolved', head_sha: SHA, object_id: null }, { event: 'pull_request_review_thread', action: 'resolved' }],
  ])('builds the inputs for %s', (_case, item, expected) => {
    expect(dispatchInputs({ ...item, delivery: DELIVERY }, 12)).toEqual({ ...expected, pr: '12', delivery_id: DELIVERY });
  });
});

describe('runTitle', () => {
  it('matches the run-name of the documented dispatch workflow and reads back', () => {
    expect(runTitle({ event: 'issue_comment.created', delivery: DELIVERY }, 12)).toBe(`Manki issue_comment.created on #12 (${DELIVERY})`);
    expect(numberFromRunTitle(`Manki issue_comment.created on #12 (${DELIVERY})`)).toBe(12);
    expect(numberFromRunTitle('Manki pull_request.synchronize on #7 (catch-up-111111111111)')).toBe(7);
  });

  it('reads the number from a run name without the delivery id', () => {
    expect(numberFromRunTitle('Manki issue_comment.created on #12')).toBe(12);
  });

  it.each(['Manki dispatch', 'Manki issue_comment.created on #12 extra', 'Manki issue_comment.created on #12 (bad id!)', 'CI on #12', 'Manki x.y on #012', undefined])(
    'reads no number from %s',
    (title) => {
      expect(numberFromRunTitle(title)).toBeUndefined();
    },
  );
});
