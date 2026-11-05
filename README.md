# manki-token-service

Cloudflare Worker that issues GitHub App installation tokens to GitHub Actions workflows.

Workflows authenticate via [GitHub's OIDC provider](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect). The service verifies the OIDC token, dynamically looks up the app installation for the requested repository, and returns a scoped installation token.

## How it works

1. A GitHub Actions workflow requests an OIDC token with audience `manki-api.dustinface.me`
2. The workflow POSTs to `https://manki-api.dustinface.me/token` with the OIDC token as a Bearer token and `{ owner, repo }` in the body, plus `memory: true` to also get a memory token
3. The service verifies the OIDC token against GitHub's JWKS, checks that the repository claim matches, and refuses a token issued more than 10 minutes ago
4. It creates a GitHub App JWT, looks up the installation for the repository, and requests an installation token for the requesting repository only (`repository_ids` from the OIDC `repository_id` claim). The token holds only the permissions Manki uses (see `src/permissions.ts`), each at no more than the installation grants. `contents` and `actions` never go above `read`
5. The installation token, its expiry and the permissions GitHub reports for it are returned to the workflow

### Memory token

With `memory: true`, the service mints a second token that holds only `contents: write` on the `review-memory` repository of the same installation account, and returns it as `memory_token` with `memory_expires_at`. Manki reads and writes review memory with it. When `review-memory` is not part of the installation, or the installation grants no `contents`, GitHub refuses the mint and the response has no memory token. The review token is returned either way.

The repository name is fixed. A memory repo with any other name (`memory.repo` in `.manki.yml`) cannot get a token from this service and needs Manki's `memory_repo_token` input.

## Webhook

`POST /webhook` receives the GitHub App's webhook deliveries for Manki's webhook mode. It checks the `X-Hub-Signature-256` HMAC against `WEBHOOK_SECRET`, checks that `X-GitHub-Hook-Installation-Target-ID` is `APP_ID`, and works out where the delivery would go: ignored, the PR's state lane (reviews, thread replies, `check`, `dismiss`, review state checks from reviews and from resolved or reopened threads) or its chat lane (explain, questions, help, remember, forget). Work and closes go to the PR's `PrCoordinator` Durable Object before the `202` leaves.

`PrCoordinator` (one per PR or issue, named `<repository id>:<number>`, SQLite storage) refuses a delivery whose id or body SHA-256 it has seen in the last 7 days (only the id for a thread event, whose body can repeat), queues work per lane, collapses queued pushes into one review of the newest head and the edits of one comment into one item, and drops queued work when the PR closes. Its alarm takes the oldest item of each free lane, checks that the repository opted in (`.github/workflows/manki-dispatch.yml` on the default branch and no event-driven Manki workflow next to it, cached for 5 minutes. A workflow file over 64 KB or truncated by GitHub is never parsed: as the dispatch file it means not opted in, as any other file it counts as event-driven), and then starts a run of `manki-dispatch.yml` on the default branch with `workflow_dispatch`. The owner, name and default branch come from `GET /repositories/<id>`, read with the opt-in and cached with it, never from the delivery's payload. The inputs follow Manki's dispatch adapter: `event`, `action`, `pr`, `head_sha` (pushes and merges), `comment_id` or `review_id`, and `delivery_id`. The workflow's `run-name` must be `Manki ${{ inputs.event }}.${{ inputs.action }} on #${{ inputs.pr }} (${{ inputs.delivery_id }})`: the Worker reads the PR from it to route `workflow_run`, and matches the delivery id to find a run whose dispatch response was lost. The token for that call is minted for the one repository with `actions: write` and nothing else, apart from `/token`, which stays capped. A lane stays busy until the `workflow_run` webhook reports the run's end. A poll every 2 minutes is the safety net: it ends items whose run completed or was deleted, and cancels runs still queued after 30 minutes or running after 40. An item whose run never started is queued again once. A run not seen ending 75 minutes after its dispatch is cancelled, and its lane stays busy until the cancel succeeds or the run is seen completed. A token mint that fails with a 5xx, a 429, a rate limit or a network error is retried with the same backoff as a failed start. Only a plain 403, a 404 or a 422 counts as a refusal. Failed dispatches retry after 15 seconds, 1 minute and 5 minutes, and a retry first looks for a run the earlier attempt started. A comment or review counts as trusted when its author's `author_association` is `OWNER`, `MEMBER`, `COLLABORATOR` or `CONTRIBUTOR`, or its sender opened the PR, as Manki's own check decides it. An outsider's review never replaces the trigger of a trusted review state check. An untrusted review request queues on its own and never merges with a push review. Each lane allows 30 dispatches per hour for trusted work and 5 for untrusted work, counted apart. A trusted review or merge over the cap waits until the hour allows it. Any other work over the cap is dropped. Installation tokens are cached in memory per permission set until 5 minutes before they expire. It deletes its storage a week after the last delivery.

Only repositories whose numeric id is in `WEBHOOK_REPOS` (comma-separated, in `wrangler.toml`) reach a coordinator. A delivery for any other repository is logged and answered `202` without touching Durable Object storage, so another installation cannot use up the account's daily storage write quota. `workflow_run` deliveries are dropped unless `manki-review[bot]` sent them, and a body over 25 MiB is refused with `413` while it is read, with or without `Content-Length`.

With `DISPATCH_ENABLED` (in `wrangler.toml`) set to anything but `"true"`, the coordinators only log what they would dispatch.

### App events

The GitHub App subscribes to these events. They all arrive at `/webhook`:

| Event | Used for |
|---|---|
| Pull request | Reviews on open, push and ready for review. A close clears the queue, and a merge records the fix rate |
| Pull request review | The review state check (auto-approve) |
| Pull request review comment | Thread replies and thread commands |
| Pull request review thread | The review state check when a thread is resolved or reopened. GitHub Actions has no trigger for this one |
| Issue comment | Review requests, Force review ticks, commands and questions |
| Workflow run | The end of a dispatched run. Every other run is ignored |

### Cost on the Workers Free plan

The Free plan includes [100,000 Worker requests a day](https://developers.cloudflare.com/workers/platform/pricing/) and [100,000 Durable Object requests a day](https://developers.cloudflare.com/durable-objects/platform/pricing/), counting each RPC call and each alarm, plus 100,000 SQLite rows written. Past a limit, calls fail until 00:00 UTC.

- Every delivery is one Worker request, including `workflow_run` for every CI run in every installed repository, which is ignored after the signature check.
- A routed delivery adds one coordinator call and usually one or two alarms.
- A dispatched run adds an alarm for each poll, every 2 minutes or less often after errors.
- The cron adds 288 requests a day, plus one call for each PR it checks.

Watch the daily request counts in the dashboard as more repositories opt in.

## Configuration

The following secrets must be set in the Cloudflare Worker environment:

| Secret | Description |
|---|---|
| `APP_ID` | GitHub App ID for the manki-review app |
| `APP_PRIVATE_KEY` | PEM private key for the GitHub App |
| `WEBHOOK_SECRET` | The App's webhook secret. `/webhook` answers `500` until it is set |
| `WEBHOOK_SECRET_PREVIOUS` | Optional. The secret before a rotation, accepted as well until it is deleted |

```sh
wrangler secret put APP_ID
wrangler secret put APP_PRIVATE_KEY
wrangler secret put WEBHOOK_SECRET
```

To rotate the webhook secret, put the current one into `WEBHOOK_SECRET_PREVIOUS`, then the new one into `WEBHOOK_SECRET` and the App's settings, and delete `WEBHOOK_SECRET_PREVIOUS` once deliveries verify under the new one.

## Development

```sh
npm install
npm run dev        # local dev server
npm run typecheck  # type-check the Worker and the tests
npm test           # run the tests
npm run deploy     # deploy to Cloudflare
```
