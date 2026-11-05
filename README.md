# manki-token-service

Cloudflare Worker that issues GitHub App installation tokens to GitHub Actions workflows.

Workflows authenticate via [GitHub's OIDC provider](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect). The service verifies the OIDC token, dynamically looks up the app installation for the requested repository, and returns a scoped installation token.

## How it works

1. A GitHub Actions workflow requests an OIDC token with audience `manki-api.dustinface.me`
2. The workflow POSTs to `https://manki-api.dustinface.me/token` with the OIDC token as a Bearer token and `{ owner, repo }` in the body
3. The service verifies the OIDC token against GitHub's JWKS and checks the repository claim matches
4. It creates a GitHub App JWT, looks up the installation ID for the repository, and requests an installation token
5. The installation token is returned to the workflow

## Configuration

The following secrets must be set in the Cloudflare Worker environment:

| Secret | Description |
|---|---|
| `APP_ID` | GitHub App ID for the manki-review app |
| `APP_PRIVATE_KEY` | PEM private key for the GitHub App |

```sh
wrangler secret put APP_ID
wrangler secret put APP_PRIVATE_KEY
```

## Development

```sh
npm install
npm run dev        # local dev server
npm run typecheck  # type-check the Worker and the tests
npm test           # run the tests
npm run deploy     # deploy to Cloudflare
```
