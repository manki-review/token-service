# PR state

The coordinator keeps each PR's running state, so Manki reads it there instead of from its comments. Both endpoints take the workflow's OIDC token as the bearer token and a JSON body `{ owner, repo, pr }`, checked as for `/token`, rate limit and installation lookup included, so a repository without the App reaches no coordinator. The coordinator is named from the token's `repository_id` claim, so a workflow only reaches the PRs of its own repository.

- `POST /state` returns `{ active, queue, last_reviewed, last_approval, pause, settings }`:
  - `active`: the items dispatching or running, with `lane`, `run_id`, `kind`, `event`, `head_sha`, `dispatched_at` and `modes`. A run finds its own item by `run_id`.
  - `queue`: the queued items, with `lane`, `kind`, `event`, `head_sha`, `enqueued_at`, `modes` and `comment_id`, the review comment of a queued thread reply and `null` for any other item, such as a box tick. A review leaves what it found in a thread to the answer of a reply that still waits.
  - `modes`: what the settings boxes asked of a review, any of `again`, `deeper` and `draft`. Empty for any other item.
  - `last_reviewed`: `{ commit, run_id, at }`, the last commit a run reported as reviewed.
  - `last_approval`: `{ commit, held, run_id, at }`, or `null` while the PR has no approval. `held` marks an approval Manki held because the PR conflicts with its base, which resets the round count like any approval.
  - `pause`: `{ reason, at }` while the automatic pause the Action decided is on, such as the round cap.
  - `settings`: `{ paused, auto }`, whether a writer ticked Pause and Review every push. `auto` is left out until the box was offered on a draft, so the Action shows it only where it works. Its presence tells the Action that the Worker handles the settings boxes.
  - It writes nothing, and a PR the coordinator never saw returns an empty state.
- `POST /state/report` stores what the PR's active run found. The body adds any of `reviewed: { commit }`, `approval: { commit, held }` or `approval: null`, and `pause: { reason }` or `pause: null`. `approval: null` clears the stored approval, as when Manki withdraws it because a blocking thread reopened, so `last_approval` reads `null` again. A field left out keeps its value. Only the run in the token's `run_id` claim may report, and only while the coordinator tracks it as dispatching or running. Any other run gets `403`. A report that changes nothing writes nothing. Each report logs one `state_report` line with the PR, the run id, the fields and the result. It returns `{ changed }`, the fields that changed.
