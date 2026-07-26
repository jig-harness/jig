## Survey 4 — Review architecture and learning loop

Survey how code review and continuous improvement work.

1. Reviewers in play: humans, bot reviewers (CodeRabbit/Greptile/Copilot/custom), their roles and posture (blocking vs comment-only), and any layering rationale. Count a bot only if its config or workflow wiring is present — a badge or sponsor mention is not a reviewer.
   For every secret-bearing or merge-relevant automated reviewer, verify that
   its runtime, prompts, and active policy come from a pinned external source,
   a separately hosted service, or the target base branch — never the PR head
   it is reviewing. Record how proposed reviewer changes are tested without
   letting them control their own authoritative review.
2. Review routing: are mandatory review requirements selected by change type? Mechanically or by convention?
3. The comment-resolution loop: is addressing review feedback codified (a closed
   set of terminal states, human-in-the-loop
   ([HITL](../../GLOSSARY.md)) boundaries, thread-resolution mechanics)? Note
   specifically whether a finding whose code is *gone* has anywhere to go other
   than "rejected", and whether the terminal state is **declared** by the author
   in a machine-readable anchored form or **reconstructed from prose** later —
   including what happens to a reply the tooling cannot classify.
4. The review loop over rounds: what ends it? Look for a stop condition that
   distinguishes "no open threads" from "a reviewer has not reported yet", and
   that re-checks the PR is still open each round. A loop driven by a person
   eyeballing the thread list counts as convention, not mechanism.
5. Measurement: is review quality measured at all (missed-defect tracking, vendor parity, eval fixtures, telemetry)?
6. Learning loop: when a reviewer (or gate) misses a real defect, does anything systematic happen? Look for miss taxonomies, regression fixtures, checklist growth, retrospective flows. Is reflection triggered by an *observable* (a round-count threshold, say) or by the author remembering — and does its record carry the measurement that triggered it?
7. Task/memory systems: tracker taxonomy (do labels drive process?), persistent agent memory, phase formulas with required gates.
8. HITL codification: which decisions are explicitly reserved for humans (merge, release, destructive ops, scope expansion), and where is that written?

Synthesize: (A) the improvement flywheel as practiced (or its absence); (B) portable mechanisms vs entangled content; (C) measurement blind spots; (D) HITL boundary completeness.
