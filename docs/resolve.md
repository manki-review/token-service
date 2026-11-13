# Thread resolution

`POST /resolve` resolves or reopens one of Manki's review threads for the run a coordinator dispatched. GitHub only lets a token with `contents: write` resolve a thread, so the Worker does it with a token it mints for this call alone (`contents: write` and `pull_requests: write` on the one repository, audited as `resolve`), and the run needs no `contents: write` of its own. It takes the workflow's OIDC token as the bearer token, checked as for `/token`, rate limit, installation lookup and the dispatched run included. The body is `{ owner, repo, thread_id, resolved }`, plus `reason` (`ADDRESSED`, `INVALID` or `WONT_FIX`) only with `resolved: true`. The PR is the one the run's title names, so the body names none.

The thread must be on that PR of the token's repository, and its first comment must be by one of Manki's logins (`manki-review[bot]` or `github-actions[bot]`). It answers:

- `200 { resolved }`, the thread's state after the change. Each change logs one `thread_resolved` line with the repository, run id, PR, thread id and `resolved`.
- `400` for a malformed body, `401` without a bearer token, `403` for a token or workflow that is not the dispatched run (with the reason, logged as `resolve_refused`) or an installation that grants no `contents: write`, `404` for a thread that is not Manki's on the run's PR (logged as `resolve_refused`) or a repository without the App, `429` over the account's rate limit, and `500` with a `request_id` for any GitHub failure.
