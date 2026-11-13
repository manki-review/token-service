# Operations

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

## Deployment

`.github/workflows/deploy.yml` deploys the Worker with [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action) on a manual run (`workflow_dispatch`) and on a push to `main` that changes what goes into the Worker: `src/`, `wrangler.toml`, `package.json`, `package-lock.json`, `tsconfig.json` or the workflow itself. A push that changes only other files, such as the README, `.manki.yml` or the tests, deploys nothing. It runs the same tests as CI first. The deploy job runs in the `production` environment, so it waits for the owner's approval, and only that job can read the Cloudflare API token.

GitHub never holds the App key or the webhook secret. The Worker secrets above stay set by hand with `wrangler secret put`, and a deploy keeps them.

The `production` environment is set up in the repository settings:

- Required reviewers: the owner, with Prevent self-review off, since the owner approves their own merges.
- Deployment branches and tags: only `main`.
- Environment secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with only these permissions:
  - Account, Workers Scripts, Edit, with Account Resources set to the account that runs the Worker.
  - Zone, Workers Routes, Edit, with Zone Resources set to the specific zone `dustinface.me`.
  - Zone, Zone, Read, on the same zone. Wrangler looks up the zone of the route in `wrangler.toml` by its name.
- Environment variable `CLOUDFLARE_ACCOUNT_ID`: the account ID from the account's overview page in the dashboard. Wrangler needs it to deploy from CI.

To rotate the token, create a new one with the same permissions (My Profile, API Tokens, Create Token, Create Custom Token), replace the secret in `production`, and delete the old token in the dashboard. For a manual deploy from a laptop, use `wrangler login` rather than a token in the shell environment.

## Log watch

`.github/workflows/log-watch.yml` runs `scripts/log-watch/main.ts` every hour. It reads Workers Logs back to 15 minutes before the start of its last successful run, at least 75 minutes and at most 6 hours, so a late or dropped run leaves no gap. A log query reply without a list of events fails the run rather than reading as a clean window. It looks for these warning signs:

- `coordinator_start_error`.
- Failed writes of a note, comment or check: the conflict note, the note or status line of a pull request held for another of the same head, the starting status, a cancelled review's report, the waiting check and the eyes reaction. A waiting check GitHub forbids the Worker to end (`coordinator_waiting_check_refused` with `403`) counts too, since it stays queued on its commit.
- Runs the safety poll cancelled (`timed_out`) or queued again.
- Any line with a 5xx status or an error naming one.
- Work queued over 20 minutes ago that no dispatch, end or close of its PR has followed, looked for over the last 6 hours. That includes a review a settings box queued. Work waiting while its lane on the PR has a run going is not stuck, and work in a lane no routed `webhook` line names waits while any lane of its PR runs. A review held by the hourly cap counts from when the cap releases it.

It keeps one issue titled "Worker logs show warning signs", marked `<!-- log-watch -->`. A window with warning signs opens the issue, or replaces the body of the open one with that window's lines and Workers Logs request ids, at most 10 lines and 50 ids per sign. The issue is public, so only a line naming a repository that GitHub shows as public to the job's token names its repository, PR, work and error. Any other line shows only its time, its message and its request id. That covers a private repository, one whose visibility could not be read, and a line naming no repository, whose error can still quote one. A clean window comments on the open issue and closes it. The next warning sign opens a new one.

It reads the logs with the repository secret `CF_LOGS_READ_TOKEN`, a Cloudflare API token with only Account, Workers Observability, Read on the account that runs the Worker. Its job holds `actions: read`, to find its last successful run, `contents: read` and `issues: write`. It changes nothing in the Worker, so it needs no deploy.

With `DISPATCH_ENABLED` (in `wrangler.toml`) set to anything but `"true"`, the coordinators only log what they would dispatch. `WAITING_CHECK_ENABLED` switches the [waiting check](waiting-check.md) the same way.

## Cost on the Workers Free plan

The Free plan includes [100,000 Worker requests a day](https://developers.cloudflare.com/workers/platform/pricing/) and [100,000 Durable Object requests a day](https://developers.cloudflare.com/durable-objects/platform/pricing/), counting each RPC call and each alarm, plus 100,000 SQLite rows written. Past a limit, calls fail until 00:00 UTC.

- Every delivery is one Worker request, including `workflow_run` for every CI run in every installed repository, which is ignored after the signature check.
- A routed delivery adds one coordinator call and usually one or two alarms. A comment, review or thread delivery also adds a limiter call before it and, once stored, one after it. One over the installation cap adds only the first call.
- A dispatched run adds an alarm for each poll, every 2 minutes or less often after errors.
- The cron adds 288 requests a day, plus one call for each PR it checks.

Watch the daily request counts in the dashboard as more repositories opt in.
