# manki-token-service

Cloudflare Worker that issues GitHub App installation tokens to GitHub Actions workflows.

Workflows authenticate via [GitHub's OIDC provider](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect). The service verifies the OIDC token, dynamically looks up the app installation for the requested repository, and returns a scoped installation token.

## How it works

1. A GitHub Actions workflow requests an OIDC token with audience `manki-api.dustinface.me`
2. The workflow POSTs to `https://manki-api.dustinface.me/token` with the OIDC token as a Bearer token and `{ owner, repo }` in the body
3. The service verifies the OIDC token against GitHub's JWKS, checks that the repository claim matches, and refuses a token issued more than 10 minutes ago
4. It answers `429` once the token's account (the `repository_owner_id` claim) has made 120 `/token` and `/state` requests in a minute, counted together per Cloudflare location by the `ACCOUNT_RATE_LIMIT` binding. Then it looks up the App's installation on the repository and answers `404` when there is none. A lookup, found or not, is reused for a minute, so repeated calls for one repository cost no GitHub request. A failed lookup is not reused and answers `500`
5. Only the run a PR coordinator dispatched gets a token. The OIDC token must carry `event_name`, `workflow_ref`, `ref` and `run_id`. `event_name` must be `workflow_dispatch`, and `workflow_ref` must name a workflow file of the same repository on the run's branch `ref`. The service reads the run with an `actions: read` token (logged as `run_check`) and requires a `workflow_dispatch` run started by `manki-review[bot]` whose title names the PR. That PR's coordinator must hold the run as dispatching or running, from the workflow file it dispatched, on the default branch. A dispatch answered without its run id is matched by the delivery id in the run title, and the coordinator takes the run id. Anything else gets `403` and a `token_refused` log line with the reason, so no other workflow of an allowed repository, such as a branch workflow or a `pull_request` workflow, gets a review or memory token.
6. It creates a GitHub App JWT and requests an installation token for the requesting repository only (`repository_ids` from the OIDC `repository_id` claim). The token holds only the permissions Manki uses (see `src/permissions.ts`), each at no more than the installation grants. `actions` never goes above `read`. `contents` never goes above `read`, so the run cannot push. GitHub requires `contents: write` to resolve a review thread, so the run resolves threads through `/resolve`. `checks` is capped at `write`, so a review in webhook mode can show a `Manki` check on the PR. An App or installation that grants only `checks: read` gets `read`. Like every other permission, both cover only the requesting repository.
7. The installation token, its expiry and the permissions GitHub reports for it are returned to the workflow

### Audit log

Every minted token logs one JSON line with `msg: token_minted`, never the token itself:

| Field | Value |
|---|---|
| `purpose` | `review` for `/token`, `run_check` for the run check of `/token` and `/resolve`, `resolve` for `/resolve`, `memory` for the memory endpoints, `coordinator`, `reconciler` or `writer_check` for the Worker's own calls |
| `repository_id`, `repository` | The repository the token is for. For a `memory` token, the requesting workflow's repository, while the token covers the central memory repository and never leaves the Worker |
| `installation_id` | The App installation the token comes from |
| `permissions` | The permissions GitHub reports for the token |
| `run_id`, `check_run_id` | The requesting workflow's OIDC claims, where present. `/token` mints only |

Filter Workers Logs on `msg = token_minted` to see who got which token.

## Webhook

`POST /webhook` receives the GitHub App's webhook deliveries for Manki's webhook mode. It checks the `X-Hub-Signature-256` HMAC against `WEBHOOK_SECRET`, checks that `X-GitHub-Hook-Installation-Target-ID` is `APP_ID`, and works out where the delivery would go: ignored, the PR's state lane (reviews, thread replies, `check`, `dismiss`, review state checks from reviews and from resolved or reopened threads) its chat lane (explain, questions, remember, forget) or its help lane (`help` on a PR). Work and closes go to the PR's `PrCoordinator` Durable Object before the `202` leaves.

`PrCoordinator` (one per PR or issue, named `<repository id>:<number>`, SQLite storage) refuses a delivery whose id or body SHA-256 it has seen in the last 7 days (only the id for a thread event, whose body can repeat), queues work per lane, collapses queued pushes into one review of the newest head, a review command into a trusted review command still queued, and the edits of one comment into one item, and drops queued work when the PR closes. Its alarm takes the oldest item of each free lane, except that a queued thread reply goes before a review in the state lane, so the review sees each thread as the reply leaves it. Once replies have gone ahead of a review for 5 minutes, the review goes first again. Time the review spent waiting behind a run does not count. The alarm then checks that the repository opted in (a dispatch workflow on the default branch and no event-driven Manki workflow next to it, cached for 5 minutes. A workflow file over 64 KB or truncated by GitHub is never parsed and counts as event-driven), and then starts a run of the dispatch workflow on the default branch with `workflow_dispatch`. The dispatch workflow is found by its content: a file in `.github/workflows` that runs only on `workflow_dispatch` and declares all the inputs below. That input set marks it, so it need not name Manki, as manki's own file does not (it runs `uses: ./`). Naming Manki (`uses: manki-review/manki`, the `manki-review[bot]` job `if`, or a local reusable workflow that does) still decides which other files count as event-driven Manki workflows. Name it `manki.yml`. When several files qualify, `manki.yml` goes first, then the first by name. Only that file is dispatched, and `coordinator_opt_in_warning` names the others. The owner, name and default branch come from `GET /repositories/<id>`, read with the opt-in and cached with it, never from the delivery's payload. The inputs follow Manki's dispatch adapter: `event`, `action`, `pr`, `head_sha` (pushes and merges), `comment_id` or `review_id`, and `delivery_id`. The workflow's `run-name` must be `Manki ${{ inputs.event }}.${{ inputs.action }} on #${{ inputs.pr }} (${{ inputs.delivery_id }})`: the Worker reads the PR from it to route `workflow_run`, and matches the delivery id to find a run whose dispatch response was lost. The token for that call is minted for the one repository with `actions: write` and nothing else, apart from `/token`, which stays capped. A lane stays busy until the `workflow_run` webhook reports the run's end. A poll every 2 minutes is the safety net: it ends items whose run completed or was deleted, and cancels runs still queued after 30 minutes or running after 40. An item whose run never started is queued again once. A run not seen ending 75 minutes after its dispatch is cancelled, and its lane stays busy until the cancel succeeds or the run is seen completed. When it cancels a review's run that started, for running past 40 minutes or at that deadline, the Worker ends the run's progress comment and in-progress `Manki` check itself as for a Cancel tick, since the run's post step can no longer mint a token. They say "Review stopped:" and why, such as "it ran longer than 40 minutes". A token mint that fails with a 5xx, a 429, a rate limit or a network error is retried with the same backoff as a failed start. A failed start is retried after 2, 4, 8 and then every 16 minutes. An item with no dispatch attempt waits for it in the queue, so a newer push merges into it instead of queueing behind it. Only a 403 that is no rate limit (by its headers or its message), a 404 or a 422 counts as a refusal. Failed dispatches retry after 15 seconds, 1 minute and 5 minutes, and a retry first looks for a run the earlier attempt started. A comment or review counts as trusted when its author's `author_association` is `OWNER`, `MEMBER`, `COLLABORATOR` or `CONTRIBUTOR`, or its sender opened the PR, as Manki's own check decides it. An outsider's review never replaces the trigger of a trusted review state check, and a review whose sender is not known as a writer never replaces a writer's. A writer's review or thread change takes over a trigger not known as a writer's, so the check never runs under the name of a sender the lookup would refuse. An untrusted review request queues on its own and never merges with a push review. A Manki command whose sender wrote it and has write access gets the eyes reaction in the alarm right after it is queued, so the commenter sees it before the run starts. Its token holds only `issues: write` for a PR or issue comment, or `pull_requests: write` for a review comment, on the one repository. Only an opted-in repository with dispatch on gets it, and a failure is logged and leaves the queue alone. Each lane allows 30 dispatches per hour for trusted work and 5 for untrusted work, counted apart. A trusted review or merge over the cap waits until the hour allows it. Any other work over the cap is dropped. Installation tokens are cached in memory per permission set until 5 minutes before they expire. It deletes its storage a week after the PR closed, or 90 days after the last delivery of a PR it never saw close, and never while an item is queued, dispatching or running. A reopen, or work queued after the close such as a comment, counts the PR as open again. A reopen records its time, also for a PR without state, and a close whose `closed_at` is older is a late redelivery and changes nothing, even once its delivery id is forgotten. A run's end after the close does not.

Before a review from a push starts, the coordinator reads `skip_labels`, `skip_authors` and `skip_branches` from `.manki.yml` on the PR's base branch, so a PR cannot skip itself. A PR that matches one gets no run: the Worker completes a `Manki` check on its head as `skipped` and posts no comment. The rules match as in Manki. Labels and authors match in any case, and branches as globs on the head branch. An author rule also needs the push's sender to be a listed author, since a writer can push to a bot's PR. When the PR's head is no longer the queued push's, or for a catch-up, the pusher is unknown and no author rule matches. Label and branch rules never match a fork's head. A missing file, one over 64 KB, one that does not parse, or rules that are not lists of non-empty strings skip nothing. A review request by comment ignores the rules. The Worker only reads `.manki.yml`, so a workflow with another `config_path` gets its skips from the Action, after a run starts. A skipped head counts as handled, so neither the cron nor a redelivered push reviews it again. The check needs `checks: write` on the installation. Without it the PR is still skipped, without the check. Before any review starts, push or request, the coordinator also reads the PR's mergeability. When GitHub says it conflicts with its base (`mergeable: false` or `mergeable_state: dirty`), no run starts. The Worker posts one note, "This PR conflicts with `<base>`. Rebase it, and Manki reviews it then.", marked `<!-- manki-conflict-note -->`. A later skip edits that note instead of adding another, and Manki deletes it once a review posts. The Worker also completes a `Manki` check on the head as `action_required` with the title "Rebase needed". The item ends `skipped` with conclusion `conflict`, which `coordinator_finished` logs, and the cron leaves that head alone. While GitHub has not computed mergeability (`mergeable: null`), the review waits 5 and then 15 seconds and reads the PR again, then starts as before. A retry after a dispatch attempt skips none of this. The note's token holds `issues: write` and `pull_requests: write`, since GitHub needs `pull_requests: write` to comment on a pull request. The check needs `checks: write`. A note that fails to post is logged as `coordinator_conflict_note_failed`, and the item still ends skipped. A GitHub failure while creating the check is retried after the usual backoff, and the retry checks the conflict again, since no dispatch was tried.

Drafts get no automatic review. A push to a draft, or a draft opened, is still queued, and before its review starts the coordinator drops it unless `.manki.yml` on the base branch sets `drafts: review`. Any other value, or no file, skips drafts, as in Manki. Marking the PR ready for review starts a normal review, and converting it back to a draft stops them again. Comments, replies and the Review this draft box still run on a draft. The cron never catches up a draft, even with `drafts: review`.

Some decisions need no model, so the coordinator makes them without a run:

- **Help.** `@manki help` on a PR, in a comment or a review comment, is answered by the coordinator itself with Manki's command table and a thumbs-up on the command. It has its own lane, so it never waits behind a run. Its token holds only `issues: write` and `pull_requests: write` on the one repository. A reply that fails to post is retried with the start backoff.
- **Write access.** Manki only acts on a comment or submitted review whose sender has write access. The webhook handler settles it before the work is queued, for a comment or review its sender wrote. An `OWNER` has it. Anyone else is looked up with `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, with a `writer_check` token holding `metadata: read`, since a read-only member shows as `MEMBER`, a read-only outside collaborator as `COLLABORATOR`, and a member with private membership as `NONE`, `CONTRIBUTOR` or even `FIRST_TIME_CONTRIBUTOR`. Only `admin` or `write` counts, and a writer counts as trusted too. The answer is reused for 5 minutes per installation, repository and login. A failed lookup counts as no write access and is not reused. A comment or review item still not known as a writer, or an edit of someone else's comment, has its sender looked up again before it starts. Without `admin` or `write` it ends skipped and starts no run. Such an item can neither take over a queued push review nor take on its head, so a refused comment never costs the push its review.
- **Pause.** While the PR's reported `pause` is set, a review from a push, a ready for review or a catch-up ends skipped. Everything a person asks for still runs: a settings box review, a review request, thread replies, other commands and review state checks, so resolving the last thread can still lead to an approval.

### Settings boxes

Manki's progress comment carries the settings boxes, and the Worker applies their ticks. The Action renders the boxes that apply, and the Worker keys on each line's hidden id only, never on its label:

```
- [ ] Pause automatic reviews <!-- manki-box:pause -->
- [ ] Review again <!-- manki-box:again -->
- [ ] Deeper review <!-- manki-box:deeper -->
- [ ] Cancel this review <!-- manki-box:cancel -->
- [ ] Review this draft <!-- manki-box:draft -->
<!-- manki-settings -->
```

An `issue_comment.edited` delivery on a comment by one of Manki's logins that holds `<!-- manki-settings -->` goes to the settings lane. Only boxes whose tick differs between `changes.body.from` and the new body count, and Manki's own edits are dropped as a bot's. The editor's write access is looked up as for any comment, and reused for 5 minutes per login. Someone without it gets the changed boxes put back and changes nothing. A writer's change applies at once:

- **Pause** sets `settings.paused` until a writer unticks it. While it is set, automatic reviews end skipped as for the reported `pause`. A Pause change from an edit older than the last one applied, by the comment's `updated_at`, is ignored, so a late redelivery cannot undo a newer one.
- **Review again**, **Deeper review** and **Review this draft** each ask for one review with that mode. The mode joins a review a writer already queued. A queued push review becomes the box's review, so a pause, a skip rule or a draft cannot drop it. Otherwise a review of the edited comment is queued. The run reads its modes from `/state`, never from the dispatch inputs, and the box clears when the Action renders the comment again. While a review runs, **Deeper review** cancels it and asks for the deeper review on the current commit. **Review again** leaves a running review of the PR's current head alone, unticks itself and sets the status line to "already reviewing `<sha>`". When the head moved since that review started, it cancels it and asks for a review of the new head. A review cancelled this way shows in its progress comment and check as replaced, such as "Review replaced by a deeper review requested by @alice." Once the run is dispatched, the Worker sets the status line of that settings comment to "<box labels> requested by @<login>, starting…", naming the boxes by their labels in the comment, so the tick shows a reaction before the run's setup ends. It edits only a comment of Manki's with a settings block, and a failure is logged and leaves the run alone.
- **Cancel** cancels the running review with the coordinator's `actions: write` token. A cancel GitHub fails is tried again. Its item ends `skipped` with conclusion `cancelled`, and the cron does not review that head again. The run's post step can no longer mint a token, so the Worker ends what the run showed. It rewrites the progress comment to "Review cancelled by @<login>." with the old progress folded away, keeps the settings block with the status "review cancelled" and no Cancel box, and marks it `<!-- manki-review-cancelled -->` as Manki does. That comment is the ticked one while its review has not ended, or else Manki's newest such comment. Either one must have been posted since the run started, since an older comment still in progress belongs to a run that died. It also completes each in-progress `Manki` check the App created on the review's head as `cancelled`. A failure in either is logged and leaves the cancel standing. With no review running, it changes nothing.
- Unticking any box but Pause changes nothing.

Only repositories owned by an account whose numeric id is in `WEBHOOK_ACCOUNTS` (comma-separated, in `wrangler.toml`) reach a coordinator. That is the account the App is installed on, a user or an organization. Any repository of a listed account works once it opts in as described above. A delivery for any other account is logged and answered `202` without touching Durable Object storage, so another installation cannot use up the account's daily storage write quota. Look up an account's id with `gh api users/<login> --jq .id`. Each installation may also store at most 500 comment, review and thread deliveries from people without write access an hour (per clock hour, `INSTALLATION_EVENTS_PER_HOUR` to change it). The `InstallationLimiter` Durable Object, one per installation, counts them. One over the cap is logged and answered `202` without touching a coordinator. Only stored work counts: a delivery the router ignores never reaches the limiter, and the limiter counts a delivery only after its coordinator stored it, so a refused replay writes nothing. `pull_request` deliveries are exempt, because a push to a branch of the repository takes write access and the router already drops fork pushes. A comment or review by a writer, as the lookup above settles it, is exempt too, and so is a settings edit (an edit of Manki's comment), a dismissed review and a resolved or reopened thread, which take write access as well. So outsiders can only use up their own share. Run ends are exempt, since dropping one would leave a lane busy. A run end only comes from a run the App started and writes nothing unless it ends a running item. A close that is no merge and finds no queued work writes at most its close time and delivery id, once until the next reopen. A fork's reopen is dropped, so an outsider closing and reopening a PR in a loop costs no storage. Only a stored delivery writes the count, one row each, so a flood above the cap adds no storage writes. `workflow_run` deliveries are dropped unless `manki-review[bot]` sent them, and a body over 25 MiB is refused with `413` while it is read, with or without `Content-Length`.

## PR state

The coordinator keeps each PR's running state, so Manki reads it there instead of from its comments. Both endpoints take the workflow's OIDC token as the bearer token and a JSON body `{ owner, repo, pr }`, checked as for `/token`, rate limit and installation lookup included, so a repository without the App reaches no coordinator. The coordinator is named from the token's `repository_id` claim, so a workflow only reaches the PRs of its own repository.

- `POST /state` returns `{ active, queue, last_reviewed, last_approval, pause, settings }`:
  - `active`: the items dispatching or running, with `lane`, `run_id`, `kind`, `event`, `head_sha`, `dispatched_at` and `modes`. A run finds its own item by `run_id`.
  - `queue`: the queued items, with `lane`, `kind`, `event`, `head_sha`, `enqueued_at` and `modes`.
  - `modes`: what the settings boxes asked of a review, any of `again`, `deeper` and `draft`. Empty for any other item.
  - `last_reviewed`: `{ commit, run_id, at }`, the last commit a run reported as reviewed.
  - `last_approval`: `{ commit, held, run_id, at }`. `held` marks an approval Manki held because the PR conflicts with its base, which resets the round count like any approval.
  - `pause`: `{ reason, at }` while the automatic pause the Action decided is on, such as the round cap.
  - `settings`: `{ paused }`, whether a writer ticked Pause. Its presence tells the Action that the Worker handles the settings boxes.
  - It writes nothing, and a PR the coordinator never saw returns an empty state.
- `POST /state/report` stores what the PR's active run found. The body adds any of `reviewed: { commit }`, `approval: { commit, held }` and `pause: { reason }` or `pause: null`. Only the run in the token's `run_id` claim may report, and only while the coordinator tracks it as dispatching or running. Any other run gets `403`. A report that changes nothing writes nothing. Each report logs one `state_report` line with the PR, the run id, the fields and the result. It returns `{ changed }`, the fields that changed.

## Thread resolution

`POST /resolve` resolves or reopens one of Manki's review threads for the run a coordinator dispatched. GitHub only lets a token with `contents: write` resolve a thread, so the Worker does it with a token it mints for this call alone (`contents: write` and `pull_requests: write` on the one repository, audited as `resolve`), and the run needs no `contents: write` of its own. It takes the workflow's OIDC token as the bearer token, checked as for `/token`, rate limit, installation lookup and the dispatched run included. The body is `{ owner, repo, thread_id, resolved }`, plus `reason` (`ADDRESSED`, `INVALID` or `WONT_FIX`) only with `resolved: true`. The PR is the one the run's title names, so the body names none.

The thread must be on that PR of the token's repository, and its first comment must be by one of Manki's logins (`manki-review[bot]` or `github-actions[bot]`). It answers:

- `200 { resolved }`, the thread's state after the change. Each change logs one `thread_resolved` line with the repository, run id, PR, thread id and `resolved`.
- `400` for a malformed body, `401` without a bearer token, `403` for a token or workflow that is not the dispatched run (with the reason, logged as `resolve_refused`) or an installation that grants no `contents: write`, `404` for a thread that is not Manki's on the run's PR (logged as `resolve_refused`) or a repository without the App, `429` over the account's rate limit, and `500` with a `request_id` for any GitHub failure.

## Memory

Review memory lives in one central repository, `MEMORY_REPO` in `wrangler.toml` (`manki-review/review-memory`). The Worker reads and writes it for each repository's dispatched Manki run. No memory token leaves the Worker: it mints its own `contents: write` token for that repository alone, from the installation it finds with `GET /repos/<memory repo>/installation`, logged as `memory`.

**Folders.** A repository's memory is the folder `<owner>/<repo>/`, from the OIDC `repository` claim in lower case, never from the body. A login never holds `_`, so no repository's folder can be inside `_global/`. A renamed repository keeps its memory only once its folder is moved.

**Identity.** Every endpoint takes the run's OIDC token as the bearer token and a JSON body with `owner`, `repo` and `pr`, the PR or issue number of the run. The token must be for that repository, from `workflow_dispatch`, from a workflow file of the repository on a branch, as for `/token`. The coordinator of `pr` must hold the token's `run_id` as dispatching or running, from that workflow file, on the default branch. Otherwise the answer is `403` with `Only the run Manki dispatched may use memory: <reason>` and a `memory_refused` log line, before the Worker touches the memory repository.

**Public repositories only.** Central memory is shared, so a private repository never uses it. A token whose `repository_visibility` claim is not `public`, such as `private`, `internal` or a missing claim, gets `403` with `Only a public repository may use memory: repository visibility is <visibility>` and a `memory_refused` log line. This check comes before the dispatched-run check.

**`POST /memory/read`** with `{ owner, repo, pr }` returns `200`:

```json
{
  "repo": { "learnings.yml": { "text": "...", "sha": "<blob sha>" }, "suppressions.yml": null, "patterns.yml": null },
  "global": { "learnings.yml": null, "conventions.md": { "text": "...", "sha": "<blob sha>" } }
}
```

Each file is its raw text with its blob sha, or `null` when it does not exist. `repo` holds the files of the repository's folder and `global` those of `_global/`. Nothing else is read, so `metrics/fix-rate.jsonl` is never returned.

**`POST /memory/write`** with `{ owner, repo, pr, file, content, sha, message }` replaces one file of the repository's own folder.

- `file`: `learnings.yml`, `suppressions.yml` or `patterns.yml`. Anything else, such as a path or a file of `_global/`, gets `400`. No run writes `_global/`.
- `content`: the whole new text, at most 512 KB, or `413`.
- `sha`: the blob sha the run read the file at, or `null` for a file that does not exist yet. Anything else gets `400`.
- `message`: the commit message, at most 200 characters after control characters become spaces. The Worker adds ` (<owner>/<repo> run <run id>)`. An empty one gets `400`.
- Returns `200` with `{ sha }`, the file's new blob sha. When the file changed since the run read it, or the run sent `null` for a file that exists, it returns `409` with `{ "error": "the file changed since it was read" }`: read again, apply the edit to the new text, and write again.

**`POST /memory/append`** with `{ owner, repo, pr, file, lines, message }` appends lines to a file of the repository's own folder, creating it when missing.

- `file`: `metrics/fix-rate.jsonl`. Anything else gets `400`.
- `lines`: 1 to 10 strings, each one JSON object of at most 16 KB with no line break. The Worker writes each on its own line. Anything else gets `400`.
- `message`: as for a write.
- The Worker reads the file and writes it back itself, trying 3 times when another run appended meanwhile. Returns `200` with `{ sha }`, `409` when all 3 tries met a conflict, and `413` when the file would grow over 1,000,000 bytes, with a `memory_append_full` log line. Each append reads and writes the whole file, which has to fit the Free plan's CPU time, so a full file is moved aside by hand.

Every endpoint answers `400` for a body without a positive integer `pr`, `413` for a body over 1 MiB (also without `Content-Length`, and for `/token` and `/state` too), `429` when the account is over its share of requests (`ACCOUNT_RATE_LIMIT`, shared with `/token` and `/state`), `404` when the App is not installed on the requesting repository, `503` when no memory repository is configured or the App is not installed on it, and `502` with `{ error, request_id }` when GitHub fails, including a write GitHub refuses for another reason than the sha. The details go to a `request_failed` log line under that request id. Redacting secrets is the caller's job: the Worker stores what it gets. Each write and append logs `memory_write` or `memory_append` with the repository, PR, run id and file.

## Reconciler

A cron trigger every 5 minutes runs one pass of the `Reconciler` Durable Object, a singleton.

- **Opt-in registry.** Each time a coordinator reads the workflows it reports the result, with the owning account's id from `GET /repositories/<id>`. The first sighting of a dispatch workflow records the repository's opt-in time, and opting out removes it. Redelivery and catch-up only touch repositories whose account is in `WEBHOOK_ACCOUNTS`. A repository recorded before the account id was stored gets it from `GET /repositories/<id>` at the start of the next pass, once.
- **Redelivery.** It lists the App's webhook deliveries, newest first, down to the newest delivery the last finished scan reached. A scan that hits the limit of 10 pages goes on from the same page in the next pass, so failures behind a burst of `workflow_run` deliveries are still found. Each failed delivery is redelivered at most twice, those not retried yet first. Only deliveries whose first attempt is under 6 hours old, the same limit as for stale comments, for a repository that had opted in by then, are sent again. So failures from before the Worker was ready stay failed.
- **Catch-up.** For each opted-in repository it lists open PRs updated in the last day.
  - A same-repository, non-draft PR goes to its coordinator as a review when its head has no Manki review, no review run in the coordinator that ended in success and no match of a skip rule. A review that was otherwise skipped, dropped, failed, cancelled or deleted does not count, so its head is caught up again, at most once a day.
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
| Issue comment | Review requests, settings box edits, commands and questions |
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

`.github/workflows/log-watch.yml` runs `scripts/log-watch/main.ts` every hour. It reads the last 75 minutes of Workers Logs for warning signs:

- `coordinator_start_error`.
- Failed writes of a note or comment: the conflict note, the starting status, a cancelled review's report and the eyes reaction.
- Runs the safety poll cancelled (`timed_out`) or queued again.
- Any line with a 5xx status or an error naming one.
- Work queued over 20 minutes ago that no dispatch, end or close of its PR has followed, looked for over the last 6 hours.

It keeps one issue titled "Worker logs show warning signs", marked `<!-- log-watch -->`. A window with warning signs opens the issue, or replaces the body of the open one with that window's lines and Workers Logs request ids. A clean window comments on the open issue and closes it. The next warning sign opens a new one.

It reads the logs with the repository secret `CF_LOGS_READ_TOKEN`, a Cloudflare API token with only Account, Workers Observability, Read on the account that runs the Worker. Its job holds `contents: read` and `issues: write`. It changes nothing in the Worker, so it needs no deploy.

## Development

```sh
npm install
npm run dev        # local dev server
npm run typecheck  # type-check the Worker and the tests
npm test           # run the tests
npm run deploy     # deploy by hand, outside the workflow
```
