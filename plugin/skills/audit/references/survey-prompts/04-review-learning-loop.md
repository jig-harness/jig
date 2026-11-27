## Survey 4 — Review architecture and learning loop

Your modules (the answers you return): M7, M8, M9 and M11.

Survey how code review and continuous improvement work.

1. Reviewers in play: humans, bot reviewers (CodeRabbit/Greptile/Copilot/custom), their roles and posture (blocking vs comment-only), and any layering rationale. Count a bot only if a workflow step invokes it on pull requests, or host-side evidence (check runs, reviews or comments by a named app) shows it active. The fit report does not carry recent pull-request activity, so look at it yourself and say which of the three channels (reviews, comments, check runs) you did not check; configuration alone is not enough — a badge or sponsor mention is not a reviewer.
   Host-side evidence has one observation time and one population. The observation time is the audit time when the audited revision is the current tip of the integration branch, and that revision's commit date for a historical audit (the `--at` option, or a clean checkout of an older commit, whose `HEAD` is then the revision); count nothing observed after it. The population is the pull requests open or merged in the 90 days before the observation time, whichever branch they target. For each of the three channels, cover that population: the pull-request heads and test merges as well as final merge commits, not a sample, one channel, or merge commits alone. A channel not covered that way is unchecked for the revisions it left out, even when the lookup returned some results; evidence outside the population establishes neither current use nor absence.
   When examined, with no automated reviewer M7's reviewer criteria score `absent`, never
   `expected-absent` (a draft's unexamined criteria stay as they are): any repository can add one. When a channel went unchecked and the repository has no wiring, do not conclude absence or recommend installing one. Try to close the gap before synthesis. If it stays open for a criterion the draft requires an answer for (inside the target, or opened by `--examine-all`; never one already marked `not-examined`), do not guess a score: stop and report the audit incomplete, naming the criterion and the channel. Say where you looked (the
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
