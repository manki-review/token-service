# Tokens

`POST /token` hands the Manki run a coordinator dispatched a GitHub App installation token for its own repository.

Workflows authenticate via [GitHub's OIDC provider](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect). The service verifies the OIDC token, dynamically looks up the app installation for the requested repository, and returns a scoped installation token.

## How a run gets a token

1. A GitHub Actions workflow requests an OIDC token with audience `manki-api.dustinface.me`
2. The workflow POSTs to `https://manki-api.dustinface.me/token` with the OIDC token as a Bearer token and `{ owner, repo }` in the body
3. The service verifies the OIDC token against GitHub's JWKS, checks that the repository claim matches, and refuses a token issued more than 10 minutes ago. A token that fails this gets `403`. The Worker keeps GitHub's key set for 10 minutes and fetches it again once it is older, or when a token names a key the set does not hold and the last fetch that worked is over 30 seconds old. A fetch that fails says nothing about the token, so it gets `503` and not `403`: a timeout after 5 seconds, a network error, a reply other than `200`, or a body that is no JSON key set. A stale key set is not used in its place, and a failed fetch is not remembered, so the next request fetches again. Every endpoint that takes an OIDC token answers this way. Manki tries `/token` once more after a `5xx`. Both answers log `request_failed` with the reason in `detail`, and [log watch](operations.md#log-watch) reports the `503`
4. It answers `429` once the token's account (the `repository_owner_id` claim) has made 120 `/token` and `/state` requests in a minute, counted together per Cloudflare location by the `ACCOUNT_RATE_LIMIT` binding. Then it looks up the App's installation on the repository and answers `404` when there is none. A lookup, found or not, is reused for a minute, so repeated calls for one repository cost no GitHub request. A failed lookup is not reused and answers `500`
5. Only the run a PR coordinator dispatched gets a token. The OIDC token must carry `event_name`, `workflow_ref`, `ref` and `run_id`. `event_name` must be `workflow_dispatch`, and `workflow_ref` must name a workflow file of the same repository on the run's branch `ref`. The service reads the run with an `actions: read` token (logged as `run_check`) and requires a `workflow_dispatch` run started by `manki-review[bot]` whose title names the PR. That PR's coordinator must hold the run as dispatching or running, from the workflow file it dispatched, on the default branch. A dispatch answered without its run id is matched by the delivery id in the run title, and the coordinator takes the run id. Anything else gets `403` and a `token_refused` log line with the reason, so no other workflow of an allowed repository, such as a branch workflow or a `pull_request` workflow, gets a review or memory token.
6. It creates a GitHub App JWT and requests an installation token for the requesting repository only (`repository_ids` from the OIDC `repository_id` claim). The token holds only the permissions Manki uses (see `src/permissions.ts`), each at no more than the installation grants. `actions` never goes above `read`. `contents` never goes above `read`, so the run cannot push. GitHub requires `contents: write` to resolve a review thread, so the run resolves threads through `/resolve`. `checks` is capped at `write`, so a review in webhook mode can show a `Manki` check on the PR. An App or installation that grants only `checks: read` gets `read`. Like every other permission, both cover only the requesting repository.
7. The installation token, its expiry and the permissions GitHub reports for it are returned to the workflow. For a review whose waiting check the run takes over, the reply also names that check as `check_run: { id, head_sha }` (see [Waiting check](waiting-check.md))

## Audit log

Every minted token logs one JSON line with `msg: token_minted`, never the token itself:

| Field | Value |
|---|---|
| `purpose` | `review` for `/token`, `run_check` for the run check of `/token` and `/resolve`, `resolve` for `/resolve`, `memory` for the memory endpoints, `coordinator`, `reconciler` or `writer_check` for the Worker's own calls |
| `repository_id`, `repository` | The repository the token is for. For a `memory` token, the requesting workflow's repository, while the token covers the central memory repository and never leaves the Worker |
| `installation_id` | The App installation the token comes from |
| `permissions` | The permissions GitHub reports for the token |
| `run_id`, `check_run_id` | The requesting workflow's OIDC claims, where present. `/token` mints only |

Filter Workers Logs on `msg = token_minted` to see who got which token.
