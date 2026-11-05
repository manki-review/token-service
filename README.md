# manki-token-service

Cloudflare Worker that issues GitHub App installation tokens to GitHub Actions workflows.

Workflows authenticate via [GitHub's OIDC provider](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect). The service verifies the OIDC token, dynamically looks up the app installation for the requested repository, and returns a scoped installation token.

## How it works

1. A GitHub Actions workflow requests an OIDC token with audience `manki-api.dustinface.me`
2. The workflow POSTs to `https://manki-api.dustinface.me/token` with the OIDC token as a Bearer token and `{ owner, repo }` in the body
3. The service verifies the OIDC token against GitHub's JWKS and checks the repository claim matches
4. It creates a GitHub App JWT, looks up the installation for the repository, and requests an installation token limited to the permissions Manki uses (see `src/permissions.ts`), each at no more than the installation grants. `actions` never goes above `read`
5. The installation token, its expiry and the permissions GitHub reports for it are returned to the workflow

## Webhook

`POST /webhook` receives the GitHub App's webhook deliveries for Manki's webhook mode. It checks the `X-Hub-Signature-256` HMAC against `WEBHOOK_SECRET`, checks that `X-GitHub-Hook-Installation-Target-ID` is `APP_ID`, and works out where the delivery would go: ignored, the PR's state lane (reviews, thread replies, `check`, `dismiss`, review state checks from reviews and from resolved or reopened threads) or its chat lane (explain, questions, help, remember, forget). Work and closes go to the PR's `PrCoordinator` Durable Object before the `202` leaves.

`PrCoordinator` (one per PR or issue, named `<repository id>:<number>`, SQLite storage) refuses a delivery id it has seen in the last 7 days, queues work per lane, collapses queued pushes into one review of the newest head, and drops queued work when the PR closes. Its alarm takes the oldest item of each free lane, checks that the repository opted in (`.github/workflows/manki-dispatch.yml` on the default branch and no event-driven Manki workflow next to it, cached for 5 minutes), and for now only logs what it would dispatch. It deletes its storage a week after the last delivery.

## Configuration

The following secrets must be set in the Cloudflare Worker environment:

| Secret | Description |
|---|---|
| `APP_ID` | GitHub App ID for the manki-review app |
| `APP_PRIVATE_KEY` | PEM private key for the GitHub App |
| `WEBHOOK_SECRET` | The App's webhook secret. `/webhook` answers `500` until it is set |

```sh
wrangler secret put APP_ID
wrangler secret put APP_PRIVATE_KEY
wrangler secret put WEBHOOK_SECRET
```

## Development

```sh
npm install
npm run dev        # local dev server
npm run typecheck  # type-check the Worker and the tests
npm test           # run the tests
npm run deploy     # deploy to Cloudflare
```
