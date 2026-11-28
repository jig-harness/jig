## Survey 4 — Review architecture and learning loop

Your modules (the answers you return): M7, M8, M9 and M11.

Survey how code review and continuous improvement work.

1. Reviewers in play: humans, bot reviewers (CodeRabbit/Greptile/Copilot/custom), their roles and posture (blocking vs comment-only), and any layering rationale. Count a bot only if a workflow step invokes it on pull requests, or host-side evidence (check runs, reviews or comments by a named app) shows it active. The fit report does not carry recent pull-request activity, so look at it yourself and say which of the three channels (reviews, comments, check runs) you did not check; configuration alone is not enough — a badge or sponsor mention is not a reviewer.
   Host-side evidence has one observation time and one 90-day window. The observation time is the audit time when the audited revision is the current tip of the integration branch, and that revision's commit date for a historical audit (the `--at` option, or a clean checkout of an older commit, whose `HEAD` is then the revision). The population is the pull requests open or merged in the 90 days before the observation time, whichever branch they target. Count only activity timestamped within that 90-day window — a review submitted, a comment posted, or a check run completed (or started, if no completion time is recorded) between 90 days before the observation time and the observation time itself; older activity on a long-open pull request or activity after the observation time establishes neither current use nor absence.
   For each of the three channels, inspect every pull request in that population — never a sample, a single channel, or final merge commits alone. For check runs, inspect every pull-request revision the repository host retains (each pull request's head and any retained test-merge commit, as well as the merge commit when checks run there). For reporting, distinguish an unchecked channel (a channel not queried, a sample that omitted pull requests, a merge-commit-only lookup where pull-request heads were available, or an unreadable query) from historical records the host no longer retains (such as expired check runs or ephemeral test-merge commits replaced on merge): when you covered every record the host exposes for the population, preserve the observed results and qualify the evidence with what the host did not retain rather than calling unretained host history a skipped check.
   When examined, with no automated reviewer M7's reviewer criteria score `absent`, never
   `expected-absent` (a draft's unexamined criteria stay as they are): any repository can add one. Always preserve confirmed observations from checked-in wiring and checked channels, and judge evidence completeness per criterion against that criterion's scope for either kind of missing evidence — an unchecked channel or unretained host history that could hold a hosted reviewer's trace (such as expired check runs or unretained pull-request revisions). Without confirmed wiring or host activity, missing evidence that could hide a hosted reviewer bars concluding absence or recommending installation; even with one confirmed reviewer, missing evidence can still hide another hosted reviewer and bars settling any criterion that applies to every active, secret-bearing, or merge-relevant reviewer above the rung confirmed observations already force. Try to close any unchecked channel before synthesis. If missing evidence (an unchecked channel or unretained host history) could still change the exact score of a criterion the draft requires an answer for (inside the target, or opened by `--examine-all`; never one already marked `not-examined`), do not guess a score: stop and report the audit incomplete, naming the criterion and the unchecked channel or unretained host history. Only where confirmed observations already fix the criterion's exact rung (for example, a confirmed in-scope reviewer is already at `absent` — never merely failing a higher pass bar such as `advisory` or `convention` where an unseen reviewer could still lower the weakest-part score to `absent`) may you record that score and note the missing evidence in the evidence instead of stopping. Say where you looked (the
   review configuration, the workflow wiring, who reviewed recent pull
   requests).
   For every secret-bearing or merge-relevant automated reviewer, verify that
   its runtime, prompts, and active policy come from a pinned external source,
   a separately hosted service, or the target base branch — never the PR head
   it is reviewing. Record how proposed reviewer changes are tested without
   letting them control their own authoritative review.
2. Review routing: are mandatory review requirements selected by change type? Mechanically or by convention?
3. The comment-resolution loop: is addressing review feedback codified (a closed
   set of terminal states, human-in-the-loop
   ([HITL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) boundaries, thread-resolution mechanics)? Note
   specifically whether a finding whose code is *gone* has anywhere to go other
   than "rejected", and whether the terminal state is **declared** by the author
   in a machine-readable anchored form or **reconstructed from prose** later —
   including what happens to a reply the tooling cannot classify.
4. The review loop over rounds: what ends it? Look for a stop condition that
   distinguishes "no open threads" from "a reviewer has not reported yet", and
   that re-checks the PR is still open each round. A loop driven by a person
   eyeballing the thread list counts as convention, not mechanism.
5. Measurement: is review quality measured at all (missed-defect tracking, vendor parity, eval fixtures, telemetry)?
6. Learning loop: when a reviewer (or gate) misses a real defect, does anything systematic happen? Look for miss taxonomies, regression fixtures, checklist growth, retrospective flows. Is reflection triggered by an *observable* (a round-count threshold, say) or by the author remembering — and does its record carry the measurement that triggered it? Say whose habit it is: turned on in a person's own configuration (with Jig's plugin, the user layer `~/.jig/jig.yaml`, which you can only learn by asking) or in the repository's, which turns it on for everyone working there.
7. Task/memory systems: tracker taxonomy (do labels drive process?), persistent agent memory, phase formulas with required gates.
   Trace deferred review findings to their destination on each supported
   tracker: are they backlog batches keyed by pull request and type, linked
   to their originating issue and epic without becoming children? Check that
   later findings append to the open batch, with the highest priority and
   union of categories. At epic closure, where do person-only checks go, and
   does the finishing pull request remove delivered scope from the active plan
   and roadmap? Accept a native epic type that needs no separate kind as well
   as an epic flag that retains a work type.
8. HITL codification: which decisions are explicitly reserved for humans (merge, release, destructive ops, scope expansion), and where is that written?

Synthesize: (A) the improvement flywheel as practiced (or its absence); (B) portable mechanisms vs entangled content; (C) measurement blind spots; (D) HITL boundary completeness.
