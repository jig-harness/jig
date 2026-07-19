## Survey 4 — Review architecture and learning loop

Survey how code review and continuous improvement work.

1. Reviewers in play: humans, bot reviewers (CodeRabbit/Greptile/Copilot/custom), their roles and posture (blocking vs comment-only), and any layering rationale.
2. Review routing: are mandatory review requirements selected by change type? Mechanically or by convention?
3. The comment-resolution loop: is addressing review feedback codified (accept/reject/defer rules, HITL boundaries, thread-resolution mechanics)?
4. Measurement: is review quality measured at all (missed-defect tracking, vendor parity, eval fixtures, telemetry)?
5. Learning loop: when a reviewer (or gate) misses a real defect, does anything systematic happen? Look for miss taxonomies, regression fixtures, checklist growth, retrospective flows.
6. Task/memory systems: tracker taxonomy (do labels drive process?), persistent agent memory, phase formulas with required gates.
7. HITL codification: which decisions are explicitly reserved for humans (merge, release, destructive ops, scope expansion), and where is that written?

Synthesize: (A) the improvement flywheel as practiced (or its absence); (B) portable mechanisms vs entangled content; (C) measurement blind spots; (D) HITL boundary completeness.

