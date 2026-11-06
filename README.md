# manki-token-service

Cloudflare Worker that issues GitHub App installation tokens to GitHub Actions workflows.

Workflows authenticate via [GitHub's OIDC provider](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect). The service verifies the OIDC token, dynamically looks up the app installation for the requested repository, and returns a scoped installation token.

## How it works

1. A GitHub Actions workflow requests an OIDC token with audience `manki-api.dustinface.me`
2. The workflow POSTs to `https://manki-api.dustinface.me/token` with the OIDC token as a Bearer token and `{ owner, repo }` in the body, plus `memory: true` to also get a memory token
3. The service verifies the OIDC token against GitHub's JWKS, checks that the repository claim matches, and refuses a token issued more than 10 minutes ago
4. It creates a GitHub App JWT, looks up the installation for the repository, and requests an installation token for the requesting repository only (`repository_ids` from the OIDC `repository_id` claim). The token holds only the permissions Manki uses (see `src/permissions.ts`), each at no more than the installation grants. `actions` never goes above `read`. `contents` is capped at `write`, because GitHub requires it to resolve review threads. `checks` is capped at `write`, so a review in webhook mode can show a `Manki` check on the PR. An App or installation that grants only `checks: read` gets `read`. Like every other permission, both cover only the requesting repository.
5. The installation token, its expiry and the permissions GitHub reports for it are returned to the workflow

### Memory token

With `memory: true`, the service mints a second token that holds only `contents: write` on the `review-memory` repository of the same installation account, and returns it as `memory_token` with `memory_expires_at`. Manki reads and writes review memory with it. When `review-memory` is not part of the installation, or the installation grants no `contents`, GitHub refuses the mint and the response has no memory token. The review token is returned either way.

The repository name is fixed. A memory repo with any other name (`memory.repo` in `.manki.yml`) cannot get a token from this service and needs Manki's `memory_repo_token` input.

### Audit log

Every minted token logs one JSON line with `msg: token_minted`, never the token itself:

| Field | Value |
|---|---|
| `purpose` | `review` or `memory` for `/token`, `coordinator` or `reconciler` for the Worker's own calls |
| `repository_id`, `repository` | The repository the token is for. For a `memory` token, the requesting workflow's repository, while the token covers `review-memory` |
| `installation_id` | The App installation the token comes from |
| `permissions` | The permissions GitHub reports for the token |
| `run_id`, `check_run_id` | The requesting workflow's OIDC claims, where present. `/token` mints only |

Filter Workers Logs on `msg = token_minted` to see who got which token.

## Webhook

`POST /webhook` receives the GitHub App's webhook deliveries for Manki's webhook mode. It checks the `X-Hub-Signature-256` HMAC against `WEBHOOK_SECRET`, checks that `X-GitHub-Hook-Installation-Target-ID` is `APP_ID`, and works out where the delivery would go: ignored, the PR's state lane (reviews, thread replies, `check`, `dismiss`, review state checks from reviews and from resolved or reopened threads) or its chat lane (explain, questions, help, remember, forget). Work and closes go to the PR's `PrCoordinator` Durable Object before the `202` leaves.

`PrCoordinator` (one per PR or issue, named `<repository id>:<number>`, SQLite storage) refuses a delivery whose id or body SHA-256 it has seen in the last 7 days (only the id for a thread event, whose body can repeat), queues work per lane, collapses queued pushes into one review of the newest head, a review command into a trusted review command still queued, and the edits of one comment into one item, and drops queued work when the PR closes. Its alarm takes the oldest item of each free lane, checks that the repository opted in (a dispatch workflow on the default branch and no event-driven Manki workflow next to it, cached for 5 minutes. A workflow file over 64 KB or truncated by GitHub is never parsed and counts as event-driven), and then starts a run of the dispatch workflow on the default branch with `workflow_dispatch`. The dispatch workflow is found by its content: a file in `.github/workflows` that runs Manki (`uses: manki-review/manki`, the `manki-review[bot]` job `if`, or a local reusable workflow that does), runs only on `workflow_dispatch` and declares the inputs below. Name it `manki.yml`. For one minor release, a file named `manki-dispatch.yml` also counts without naming Manki, for a dispatch workflow that calls a reusable workflow in another repository. When several files qualify, one that names Manki goes first, then `manki.yml`, then the first by name. Only that file is dispatched, and `coordinator_opt_in_warning` names the others. The owner, name and default branch come from `GET /repositories/<id>`, read with the opt-in and cached with it, never from the delivery's payload. The inputs follow Manki's dispatch adapter: `event`, `action`, `pr`, `head_sha` (pushes and merges), `comment_id` or `review_id`, and `delivery_id`. The workflow's `run-name` must be `Manki ${{ inputs.event }}.${{ inputs.action }} on #${{ inputs.pr }} (${{ inputs.delivery_id }})`: the Worker reads the PR from it to route `workflow_run`, and matches the delivery id to find a run whose dispatch response was lost. The token for that call is minted for the one repository with `actions: write` and nothing else, apart from `/token`, which stays capped. A lane stays busy until the `workflow_run` webhook reports the run's end. A poll every 2 minutes is the safety net: it ends items whose run completed or was deleted, and cancels runs still queued after 30 minutes or running after 40. An item whose run never started is queued again once. A run not seen ending 75 minutes after its dispatch is cancelled, and its lane stays busy until the cancel succeeds or the run is seen completed. A token mint that fails with a 5xx, a 429, a rate limit or a network error is retried with the same backoff as a failed start. Only a 403 that is no rate limit (by its headers or its message), a 404 or a 422 counts as a refusal. Failed dispatches retry after 15 seconds, 1 minute and 5 minutes, and a retry first looks for a run the earlier attempt started. A comment or review counts as trusted when its author's `author_association` is `OWNER`, `MEMBER`, `COLLABORATOR` or `CONTRIBUTOR`, or its sender opened the PR, as Manki's own check decides it. An outsider's review never replaces the trigger of a trusted review state check. An untrusted review request queues on its own and never merges with a push review. A Manki command whose author has write access by `author_association` (`OWNER`, `MEMBER` or `COLLABORATOR`), and a Force review tick on Manki's comment, get the eyes reaction in the alarm right after they are queued, so the commenter sees it before the run starts. Its token holds only `issues: write` for a PR or issue comment, or `pull_requests: write` for a review comment, on the one repository. Only an opted-in repository with dispatch on gets it, and a failure is logged and leaves the queue alone. Each lane allows 30 dispatches per hour for trusted work and 5 for untrusted work, counted apart. A trusted review or merge over the cap waits until the hour allows it. Any other work over the cap is dropped. Installation tokens are cached in memory per permission set until 5 minutes before they expire. It deletes its storage a week after the PR closed, or 90 days after the last delivery of a PR it never saw close, and never while an item is queued, dispatching or running. A reopen, or work queued after the close such as a comment, counts the PR as open again. A run's end after the close does not.

Only repositories owned by an account whose numeric id is in `WEBHOOK_ACCOUNTS` (comma-separated, in `wrangler.toml`) reach a coordinator. That is the account the App is installed on, a user or an organization. Any repository of a listed account works once it opts in as described above. A delivery for any other account is logged and answered `202` without touching Durable Object storage, so another installation cannot use up the account's daily storage write quota. Look up an account's id with `gh api users/<login> --jq .id`. Each installation may also store at most 500 comment, review and thread deliveries from people without write access an hour (per clock hour, `INSTALLATION_EVENTS_PER_HOUR` to change it). The `InstallationLimiter` Durable Object, one per installation, counts them. One over the cap is logged and answered `202` without touching a coordinator. Only stored work counts: a delivery the router ignores never reaches the limiter, and the limiter counts a delivery only after its coordinator stored it, so a refused replay writes nothing. `pull_request` deliveries are exempt, because a push to a branch of the repository takes write access and the router already drops fork pushes. A comment or review whose author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` is exempt too, and so are a Force review tick (an edit of Manki's comment), a dismissed review and a resolved or reopened thread, which take write access as well. So outsiders can only use up their own share. Run ends are exempt, since dropping one would leave a lane busy. A run end only comes from a run the App started and writes nothing unless it ends a running item. A close that is no merge and finds no queued work writes nothing, so closing and reopening a PR in a loop costs no storage. Only a stored delivery writes the count, one row each, so a flood above the cap adds no storage writes. `workflow_run` deliveries are dropped unless `manki-review[bot]` sent them, and a body over 25 MiB is refused with `413` while it is read, with or without `Content-Length`.

## PR state

The coordinator keeps each PR's running state, so Manki reads it there instead of from its comments. Both endpoints take the workflow's OIDC token as the bearer token and a JSON body `{ owner, repo, pr }`, checked as for `/token`. The coordinator is named from the token's `repository_id` claim, so a workflow only reaches the PRs of its own repository.

- `POST /state` returns `{ active, queue, last_reviewed, last_approval, pause, settings }`:
  - `active`: the items dispatching or running, with `lane`, `run_id`, `kind`, `event`, `head_sha` and `dispatched_at`.
  - `queue`: the queued items, with `lane`, `kind`, `event`, `head_sha` and `enqueued_at`.
  - `last_reviewed`: `{ commit, run_id, at }`, the last commit a run reported as reviewed.
  - `last_approval`: `{ commit, held, run_id, at }`. `held` marks an approval Manki held because the PR conflicts with its base, which resets the round count like any approval.
  - `pause`: `{ reason, at }` while the automatic pause the Action decided is on, such as the round cap.
  - `settings`: the progress comment's boxes, `paused`, `full_review`, `deeper_review`, `review_draft` and `force_review`.
  - It writes nothing, and a PR the coordinator never saw returns an empty state.
- `POST /state/report` stores what the PR's active run found. The body adds any of `reviewed: { commit }`, `approval: { commit, held }` and `pause: { reason }` or `pause: null`. Only the run in the token's `run_id` claim may report, and only while the coordinator tracks it as dispatching or running. Any other run gets `403`. A report that changes nothing writes nothing. Each report logs one `state_report` line with the PR, the run id, the fields and the result. It returns `{ changed }`, the fields that changed.

## Reconciler

A cron trigger every 5 minutes runs one pass of the `Reconciler` Durable Object, a singleton.

- **Opt-in registry.** Each time a coordinator reads the workflows it reports the result, with the owning account's id from `GET /repositories/<id>`. The first sighting of a dispatch workflow records the repository's opt-in time, and opting out removes it. Redelivery and catch-up only touch repositories whose account is in `WEBHOOK_ACCOUNTS`. A repository recorded before the account id was stored gets it from `GET /repositories/<id>` at the start of the next pass, once.
- **Redelivery.** It lists the App's webhook deliveries, newest first, down to the newest delivery the last finished scan reached. A scan that hits the limit of 10 pages goes on from the same page in the next pass, so failures behind a burst of `workflow_run` deliveries are still found. Each failed delivery is redelivered at most twice, those not retried yet first. Only deliveries whose first attempt is under 6 hours old, the same limit as for stale comments, for a repository that had opted in by then, are sent again. So failures from before the Worker was ready stay failed.
- **Catch-up.** For each opted-in repository it lists open PRs updated in the last day.
  - A same-repository, non-draft PR goes to its coordinator as a review when its head has no Manki review and no review run in the coordinator that ended in success. A review that was skipped, dropped, failed, cancelled or deleted does not count, so its head is caught up again, at most once a day.
  - PRs opened by a bot are skipped, as Manki does not review them. A bot's push to a person's PR reaches the coordinator, which records the head as handled. If that delivery was lost, the catch-up cannot tell it from a person's push and reviews the head.
- Each pass makes at most 40 calls, counting GitHub and coordinator calls together, within the Free plan's 50 subrequests. The next pass resumes with the next repository.

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
- A routed delivery adds one coordinator call and usually one or two alarms. A comment, review or thread delivery also adds a limiter call before it and, once stored, one after it. One over the installation cap adds only the first call.
- A dispatched run adds an alarm for each poll, every 2 minutes or less often after errors.
- The cron adds 288 requests a day, plus one call for each PR it checks.

Watch the daily request counts in the dashboard as more repositories opt in.

## Configuration

The following secrets must be set in the Cloudflare Worker environment:

| Secret | Description |
|---|---|
| `APP_ID` | GitHub App ID for the manki-review app. `/webhook` checks deliveries against it |
| `APP_CLIENT_ID` | Optional. The App's client ID (`Iv…`, on the App's settings page). When set, it is the `iss` of the App JWT, as [GitHub recommends](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app). Otherwise `APP_ID` is |
| `APP_PRIVATE_KEY` | PEM private key for the GitHub App |
| `WEBHOOK_SECRET` | The App's webhook secret. `/webhook` answers `500` until it is set |
| `WEBHOOK_SECRET_PREVIOUS` | Optional. The secret before a rotation, accepted as well until it is deleted |

```sh
wrangler secret put APP_ID
wrangler secret put APP_CLIENT_ID  # optional
wrangler secret put APP_PRIVATE_KEY
wrangler secret put WEBHOOK_SECRET
```

The client ID is not secret, so `APP_CLIENT_ID` can also go into `[vars]` in `wrangler.toml` instead of a secret.

To rotate the webhook secret, put the current one into `WEBHOOK_SECRET_PREVIOUS`, then the new one into `WEBHOOK_SECRET` and the App's settings, and delete `WEBHOOK_SECRET_PREVIOUS` once deliveries verify under the new one.

## Development

```sh
npm install
npm run dev        # local dev server
npm run typecheck  # type-check the Worker and the tests
npm test           # run the tests
npm run deploy     # deploy to Cloudflare
```
