import { jwtVerify, createRemoteJWKSet } from 'jose';
import { cappedPermissions, type Permissions } from './permissions';

interface Env {
  APP_ID: string;
  APP_PRIVATE_KEY: string;
}

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS_URL = new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`);

async function createAppJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const enc = new TextEncoder();
  const headerB64 = btoa(String.fromCharCode(...enc.encode(JSON.stringify(header))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = btoa(String.fromCharCode(...enc.encode(JSON.stringify(payload))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signingInput = `${headerB64}.${payloadB64}`;

  const pemBody = privateKeyPem
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    enc.encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

interface Installation {
  id: number;
  permissions: Permissions;
}

async function getInstallation(jwt: string, owner: string, repo: string): Promise<Installation | null> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'manki-token-service',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as { id: number; permissions?: Permissions };
  return { id: data.id, permissions: data.permissions ?? {} };
}

interface OIDCClaims {
  repository: string;
  repository_owner: string;
  [key: string]: unknown;
}

async function verifyGitHubOIDC(token: string, expectedRepo: string): Promise<OIDCClaims> {
  const JWKS = createRemoteJWKSet(GITHUB_JWKS_URL);

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: 'manki-api.dustinface.me',
  });

  const claims = payload as unknown as OIDCClaims;

  if (claims.repository !== expectedRepo) {
    throw new Error(`Repository mismatch: token is for ${claims.repository}, requested ${expectedRepo}`);
  }

  return claims;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'POST required' }, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/token') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Verify GitHub Actions OIDC token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json({ error: 'Authorization header with Bearer token required' }, { status: 401 });
    }
    const oidcToken = authHeader.slice(7);

    let body: { owner?: string; repo?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.owner || !body.repo) {
      return Response.json({ error: 'owner and repo are required' }, { status: 400 });
    }

    const expectedRepo = `${body.owner}/${body.repo}`;

    // Verify the OIDC token is from a GitHub Actions workflow in the requested repo
    try {
      await verifyGitHubOIDC(oidcToken, expectedRepo);
    } catch (error) {
      return Response.json(
        { error: `OIDC verification failed: ${error}` },
        { status: 403 },
      );
    }

    try {
      const appJwt = await createAppJWT(env.APP_ID, env.APP_PRIVATE_KEY);

      const installation = await getInstallation(appJwt, body.owner, body.repo);
      if (!installation) {
        return Response.json(
          { error: 'App not installed on this repository' },
          { status: 404 },
        );
      }

      // An empty `permissions` object would not narrow the token, so refuse instead of minting a full one.
      const permissions = cappedPermissions(installation.permissions);
      if (Object.keys(permissions).length === 0) {
        return Response.json(
          { error: 'App installation grants none of the permissions Manki needs' },
          { status: 403 },
        );
      }

      const tokenResponse = await fetch(
        `https://api.github.com/app/installations/${installation.id}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'manki-token-service',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ permissions }),
        },
      );

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        return Response.json(
          { error: `GitHub API error: ${tokenResponse.status}`, details: error },
          { status: tokenResponse.status },
        );
      }

      const tokenData = await tokenResponse.json() as { token: string; expires_at: string; permissions: Permissions };

      return Response.json({
        token: tokenData.token,
        expires_at: tokenData.expires_at,
        permissions: tokenData.permissions,
      });
    } catch (error) {
      return Response.json(
        { error: `Token generation failed: ${error}` },
        { status: 500 },
      );
    }
  },
};
