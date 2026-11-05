import { describe, expect, it } from 'vitest';
import { postToken, stubGitHub } from './helpers';

describe('/token', () => {
  it('returns an installation token for a verified workflow', async () => {
    stubGitHub();
    const response = await postToken();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'ghs_test', expires_at: '2026-11-05T13:00:00Z' });
  });
});
