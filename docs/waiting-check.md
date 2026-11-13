# Waiting check

A PR shows nothing of a review until its run reaches a runner, since the run belongs to the default branch. So the coordinator creates the `Manki` check itself, as `queued` with the title "Waiting for a runner", right before it dispatches a review. It does so once the review is certain to start: the PR is open, no draft, lower pull request of the same head, skip rule, pause or conflict holds it, and the head is read. A head that already has a `Manki` check of the App gets none, and so does an installation without `checks: write`. A failure to create the check is logged and the review starts without it. A review that waits behind another run of the PR shows no check until its own dispatch.

A check that nothing takes over would sit on the commit beside the review's own, so the coordinator creates one only when all of the following is certain. In doubt the review starts without a waiting check:

- `WAITING_CHECK_ENABLED` in `wrangler.toml` is `"true"`. With anything else no waiting check is created, and the open ones still end as described below.
- The repository's last Manki run said it takes a waiting check over. The coordinator stores what each `/token` request says in the reconciler's opt-in registry (`reconciler_check_ability`), and reads it together with the opt-in, so it is at most 5 minutes old. A repository new to the registry, one recorded before the registry held the answer and a registry call that fails all count as no. A run that takes checks over is believed only once the registry stored it. So the first review after a repository moves to such a Manki gets no waiting check, and the next one does. Only a `/token` request and an opt-out change the answer. A run that ends without asking leaves it as it is: one that finds the head moved, one cancelled while it waited for a runner, one that fails before Manki starts.
- For a review nobody asked for (a push, a ready for review or a catch-up), the base branch's `.manki.yml` leaves `auto_review` on: there is no file, no `auto_review` key, or `auto_review: true`. With it off the run reviews nothing. Any other value and a file that does not parse count as off. A review someone asked for gets its check whatever `auto_review` says.

A repository that moves from the Manki App to a custom App (`github_app_id`) keeps its stored yes, because the runs of a custom App never ask `/token`. Each review there gets a waiting check that no run takes over, and it ends as "Review did not run" when the run ends. That check is created before the run's own, and a required check reads the one created last (see below, tested with two checks of one App, not with checks of two Apps). A required check tied to the Manki App cannot pass for a custom App run with or without it. Opting out and in again clears the answer:

1. Remove the dispatch workflow from the default branch.
2. Push to a pull request whose last event is more than 5 minutes old. Its coordinator reads the workflows again, finds none, and the registry forgets the repository (`reconciler_opted_out`).
3. Put the workflow back. The repository is recorded anew without an answer, which counts as no. A coordinator keeps what it read for 5 minutes, so an event on that pull request within that time still counts as opted out.

The run takes the check over. Manki's `/token` request carries `takes_over_check: true`, and the reply names the check and its commit. The Action sets it in progress when it reviews that commit, and completes it with the verdict.

A required check reads the `Manki` check that was created last on a commit, whatever completes last. That was tested against GitHub with two checks of one App on one head. So the verdict that counts must sit in the check created last. While a waiting check is open on a head, no other `Manki` check is created there. Where that cannot be prevented, the verdict goes into a check created after the waiting one:

- A head that already has a `Manki` check of the App gets no waiting check, so a waiting check is never created after a verdict.
- No other item of the state lane starts while a review holds a waiting check. That covers a review that went back to the queue and kept its check, after a run no runner picked up or a dispatch that failed: no thread reply goes ahead of it, since the reply's approval would create a newer check. When a review ends, its waiting check is ended before the next item of the lane starts. The lane waits while GitHub fails the call, and the alarm tries again every 2 minutes.
- A run gets its waiting check only while that is still the only `Manki` check of the App on its head, which the coordinator lists when the run asks for its token. Another check can appear there without this PR's coordinator, such as the check of a second PR with the same head commit. Then, and when the list fails, the waiting check is completed as `cancelled` ("Review run started") before the token leaves, and the run reports in a check of its own, which is created last. A check the run already set in progress stays with it.
- A run whose `/token` request lacks `takes_over_check` is an older Manki, which reports in a check of its own. Its waiting check is cancelled the same way before the token leaves. While GitHub fails that call, `/token` answers `500`, so the run holds no token to create a check with. The registry then holds that the repository's runs take no check over, so its later reviews get none. Another PR's coordinator may create one more until it reads the registry again, at most 5 minutes later, and that check is cancelled the same way.
- A skip, pause or conflict report on the head of a review that is dispatched again completes the waiting check while that is the head's only `Manki` check. Otherwise the report is a new check, and the waiting one ends as `cancelled` when the review ends. The same holds for a check whose create reply was lost (see below).

This makes a verdict in a waiting check count exactly when a check the run creates at its start would. One gap is left to the Action: a `Manki` check created on the head in the seconds between the `/token` reply and the run's take-over.

Only the Worker cleans up. Naming the check in a `/token` reply hands nothing over: the check stays the Worker's to end until its run has completed it, however often the run asks for a token. A check its run completed is left alone. Any other is completed with one of these, never as `success`, `neutral` or `skipped`, so a required `Manki` check keeps blocking:

| Why the review did not complete the check | Conclusion | Title |
|---|---|---|
| The PR's head left the check's commit | `cancelled` | Superseded by a newer commit |
| The dispatch was refused or failed for good, or no run turned up | `failure` | Review could not start |
| The Worker cancelled the run: no runner picked it up, twice, or it ran past its timeout | `timed_out` | Review timed out |
| The PR closed, or the review was cancelled or dropped, before its run started | `cancelled` | Review not started |
| The run ended without reviewing the commit | `cancelled`, or `failure` when the run failed | Review did not run |
| The run took the check over and ended without completing it | `cancelled`, or `failure` when the run failed | Review stopped |

The coordinator stores the check's `external_id`, the delivery id of the review, before it asks GitHub to create the check. A create GitHub refuses (`403`, `404`, `422`) made nothing and is forgotten. After any other failure GitHub may hold a check whose reply was lost. The review then gets no other waiting check, and the Worker looks for the lost one among the App's `Manki` checks of the commit by its `external_id`: when the run asks for its token, on each alarm pass after that, and when the review ends. A check found this way (`coordinator_waiting_check_found`) is ended like any other and never handed to a run, so the run reports in a check of its own. One that GitHub does not list by the end of the review is forgotten.

A check GitHub refuses to show or change (`403`, `404`, `422`) is forgotten and logged as `coordinator_waiting_check_refused`. A check nothing ended would turn `stale` at GitHub after 14 days.
