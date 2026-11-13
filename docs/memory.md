# Memory

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
