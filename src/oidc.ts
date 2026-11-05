import { jwtVerify, createRemoteJWKSet } from 'jose';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

// Created once per isolate so GitHub's keys are cached across requests instead of fetched on every one.
const GITHUB_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

interface OIDCClaims {
  repository: string;
  repository_owner: string;
  [key: string]: unknown;
}

export async function verifyGitHubOIDC(token: string, expectedRepo: string): Promise<OIDCClaims> {
  const { payload } = await jwtVerify(token, GITHUB_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: 'manki-api.dustinface.me',
  });

  const claims = payload as unknown as OIDCClaims;

  if (claims.repository !== expectedRepo) {
    throw new Error(`Repository mismatch: token is for ${claims.repository}, requested ${expectedRepo}`);
  }

  return claims;
}
