# PR state

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
