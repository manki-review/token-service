import { jwtVerify, createRemoteJWKSet } from 'jose';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

// Created once per isolate so GitHub's keys are cached across requests instead of fetched on every one.
const GITHUB_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

interface OIDCClaims {
  repository: string;
  repository_owner: string;
  repository_id: string;
  repository_owner_id: string;
  [key: string]: unknown;
}

const NUMERIC_ID = /^[1-9][0-9]*$/;

export async function verifyGitHubOIDC(token: string, expectedRepo: string): Promise<OIDCClaims> {
  const { payload } = await jwtVerify(token, GITHUB_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: 'manki-api.dustinface.me',
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'repository', 'repository_id', 'repository_owner_id'],
    maxTokenAge: '10m',
  });

  const claims = payload as unknown as OIDCClaims;

  if (claims.repository !== expectedRepo) {
    throw new Error(`Repository mismatch: token is for ${claims.repository}, requested ${expectedRepo}`);
  }
  for (const name of ['repository_id', 'repository_owner_id'] as const) {
    if (typeof claims[name] !== 'string' || !NUMERIC_ID.test(claims[name])) {
      throw new Error(`Invalid ${name} claim`);
    }
  }

  return claims;
}
