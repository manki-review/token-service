# Settings boxes

Manki's progress comment carries the settings boxes, and the Worker applies their ticks. The Action renders the boxes that apply, and the Worker keys on each line's hidden id only, never on its label. The one block the Worker writes itself ends the [notice on a PR from a fork](coordinator.md#pull-requests-from-forks), with Review again and Deeper review, as the Action writes it:

```
- [ ] Pause automatic reviews <!-- manki-box:pause -->
- [ ] Review again <!-- manki-box:again -->
- [ ] Deeper review <!-- manki-box:deeper -->
- [ ] Cancel this review <!-- manki-box:cancel -->
- [ ] Review this draft <!-- manki-box:draft -->
<!-- manki-settings -->
```

An `issue_comment.edited` delivery on a comment by one of Manki's logins that holds `<!-- manki-settings -->` goes to the settings lane. Only boxes whose tick differs between `changes.body.from` and the new body count, and Manki's own edits are dropped as a bot's. The editor's write access is looked up as for any comment, and reused for 5 minutes per login. Someone without it gets the changed boxes put back and changes nothing. A writer's change applies at once:

- **Pause** sets `settings.paused` until a writer unticks it. While it is set, automatic reviews end skipped as for the reported `pause`. Unticking it while no reported `pause` holds queues one review of the push the pause skipped, as if it had just arrived, unless a review ran, failed, was cancelled or waits since that skip, or a skip rule or a conflict handled a later push. Any other later review that started no run, or one still waiting for its sender's write access to be looked up, does not count. A Pause change from an edit older than the last one applied, by the comment's `updated_at`, is ignored, so a late redelivery cannot undo a newer one.
- **Review again**, **Deeper review** and **Review this draft** each ask for one review with that mode. The mode joins a review a writer already queued. A queued push review becomes the box's review, so a pause, a skip rule or a draft cannot drop it. Otherwise a review of the edited comment is queued. The run reads its modes from `/state`, never from the dispatch inputs, and the box clears when the Action renders the comment again. While a review runs, **Deeper review** cancels it and asks for the deeper review on the current commit. **Review again** leaves a running review of the PR's current head alone, unticks itself and sets the status line to "already reviewing `<sha>`". When the head moved since that review started, it cancels it and asks for a review of the new head. A review cancelled this way shows in its progress comment and check as replaced, such as "Review replaced by a deeper review requested by `@alice`." Once the run is dispatched, the Worker sets the status line of that settings comment to "<box labels> requested by `@<login>`, starting…", naming the boxes by their labels in the comment, so the tick shows a reaction before the run's setup ends. It edits only a comment of Manki's with a settings block, and a failure is logged and leaves the run alone.
- **Cancel** cancels the running review with the coordinator's `actions: write` token. A cancel GitHub fails is tried again. Its item ends `skipped` with conclusion `cancelled`, and the cron does not review that head again. The run's post step can no longer mint a token, so the Worker ends what the run showed. It rewrites the progress comment to "Review cancelled by `@<login>`." with the old progress folded away, keeps the settings block with the status "review cancelled" and no Cancel box, and marks it `<!-- manki-review-cancelled -->` as Manki does. That comment is the ticked one while its review has not ended, or else Manki's newest such comment among the PR's newest 100 comments. The Worker lists those without their bodies and reads only the bodies of Manki's 5 newest, since anyone can fill a comment. Either one must have been posted since the run started, since an older comment still in progress belongs to a run that died. It also completes each in-progress `Manki` check the App created on the review's head as `cancelled`. A failure in either is logged and leaves the cancel standing. With no review running, it changes nothing.
- Unticking any box but Pause changes nothing.

## Boxes in Manki's other messages

Manki also puts a box into a message that names a next step, below the text, which still names the command as a second way. The box sits on the line right after the anchor `<!-- manki-issue-box -->`, as the finding's issue box does:

```
<!-- manki-issue-box -->
- [ ] Review again <!-- manki-box:again -->
```

The kinds are `again` (Review again), `check` (Check approval), `forget:<id>` (Forget this learning) and `dismiss` (Dismiss this finding). They sit in a PR comment without a settings block, in a review body or in a review comment. A box counts only right below its anchor and outside a code fence, as Manki reads it, so a box line a model wrote into Manki's text is never one. Only a box ticked in the new body and unticked in `changes.body.from` counts, and Manki's own edits are dropped.

The editor's write access is looked up before the work is queued, and again before it starts when that lookup failed. An edit of a review names Manki as the sender, so its editor is read first, as for a finding's issue box. Without `admin` or `write` the ticked boxes are put back unticked and the item ends skipped, with no review, check or token. One tick is one item, which never merges with another edit of the same comment, and a redelivered tick is refused like any replay. A review or review comment on a PR from a fork is dropped, as every review event of such a PR is.

- **Review again** goes to the settings lane and asks for one review as the settings box does. The review is dispatched as the edit of that message, and its run replaces the box with "Review again requested by `@<login>`". When the tick joins a review already queued for another message, no run comes for this one, so the Worker writes that line itself. When a review of the PR's head is already running, the Worker puts the box back unticked and sets the running review's status line to "already reviewing `<sha>`". When the head moved since that review started, the review is replaced as for the settings box. A failure to edit the message is logged. A review that starts no run for another reason, such as a conflict with the base branch, leaves the box ticked, and unticking and ticking it again asks again.
- **Check approval**, **Forget this learning** and **Dismiss this finding** are dispatched as the edit of that message. In a PR comment they take the lane of their command: Check approval the state lane, Forget this learning the chat lane. In a review or review comment they take the state lane, as a thread command does. The run checks the editor as the command checks its commenter, and settles the box.

The Worker edits a PR comment with `PATCH /repos/{owner}/{repo}/issues/comments/{id}`, a review with `PUT /repos/{owner}/{repo}/pulls/{number}/reviews/{id}` and a review comment with `PATCH /repos/{owner}/{repo}/pulls/comments/{id}`, with a token holding `issues: write` and `pull_requests: write`. A message that is gone is left alone.
