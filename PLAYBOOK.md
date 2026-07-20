# Playbook — the end-to-end delivery narrative

This condensed narrative shows how the modules compose into one delivery
motion. The full, copyable contracts now live in their modules: the feature
pipeline is [M6](modules/M6-feature-delivery-pipeline/)
([`PIPELINE.md`](modules/M6-feature-delivery-pipeline/templates/PIPELINE.md)),
the PR loop is [M7](modules/M7-pr-lifecycle-review/)
([`PR-LIFECYCLE.md`](modules/M7-pr-lifecycle-review/templates/PR-LIFECYCLE.md)),
and the learning loop is [M8](modules/M8-learning-loop/)
([`FLYWHEEL.md`](modules/M8-learning-loop/templates/FLYWHEEL.md)) — this page is
the map, those are the territory.

Two nested loops: the **feature pipeline** (idea → shipped increment) and the
**PR loop** (change → merged), with a **learning loop** wrapped around both.
Jargon: see [GLOSSARY.md](GLOSSARY.md).

## The feature pipeline

1. **Explore / research** — a dated research note per spike (options, evidence,
   recommendation). Research that changes a decision graduates into an ADR.
2. **PRD** — *what* the feature does for users, from the committed template.
   No stack talk here.
3. **Architecture** — *how*, from the template; significant decisions become
   ADRs.
4. **Design prototype loop** (UI work only) — brief → generated prototype →
   adversarial review by a strong reviewer agent → iterate; the prototype's
   product feedback often improves the PRD/architecture, so both stay open to
   revision. Import the accepted prototype in a standard, reusable form, then
   re-examine architectural implications.
5. **Plan & file** — decompose into an epic with sub-issues carrying a clear
   tactical execution plan; flag labels (migration, API change, human-in-the-
   loop, …) drive which gates will fire downstream.

**At every stage**: adversarial review of the artifact, iterate until cleared,
then **de-scar** — the final artifact is clean; findings history lives in the
review threads and issues.

## The PR loop

1. **Develop** on a feature branch (reuse an existing remote branch before
   creating one); open a **draft PR** early so CI and bot reviewers run.
2. **Review rounds** — layered reviewers (in-house shadow reviewer, commercial
   bots, humans), with mandatory review steps selected by what changed.
3. **Resolve every comment** — accept (fix + reply) or reject (reply with a
   concrete reason), then resolve the thread; loop until zero unresolved
   threads and the build is clean.
4. **Human ready + merge** — a human marks Ready and merges (a HITL decision);
   conflicts are resolved before merge, tracker updated after.

## The learning loop (wraps both)

Misses become lenses (see M8): anything an automated step should have caught
but didn't gets classified, reconstructed as an eval fixture, and turned into
an additive check — so both loops get stricter over time without growing
manual vigilance. Session reflections and promoted memories feed the same
scaffolding.
