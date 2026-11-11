import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Durable Objects read their secrets from the runtime env, so the tests bind throwaway values there.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.toml' },
    miniflare: {
      bindings: {
        APP_ID: '123456',
        APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
        WEBHOOK_SECRET: 'test-webhook-secret',
        // `OWNER_ID` of `test/helpers.ts`, in place of the real ids in `wrangler.toml`.
        WEBHOOK_ACCOUNTS: '7070',
        // Pinned so the values in `wrangler.toml` never change the tests. A test that needs dispatch or waiting checks turns them on.
        DISPATCH_ENABLED: 'false',
        WAITING_CHECK_ENABLED: 'false',
      },
      ratelimits: {
        // Far above what the tests send, so the shared count of the test account never refuses a request.
        ACCOUNT_RATE_LIMIT: { namespace_id: '1001', simple: { limit: 100_000, period: 60 } },
        // What a test binds as `ACCOUNT_RATE_LIMIT` to see a refusal.
        TIGHT_RATE_LIMIT: { namespace_id: '1002', simple: { limit: 3, period: 60 } },
      },
    },
  })],
  test: {
    restoreMocks: true,
  },
});
