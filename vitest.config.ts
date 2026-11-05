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
      },
    },
  })],
  test: {
    restoreMocks: true,
  },
});
