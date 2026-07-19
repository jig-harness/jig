# Playbook — the end-to-end delivery narrative

**Status: draft.** This condensed, generalized narrative will be refined from
the reference implementation's canonical process docs when modules M6 and M7
port (see [ROADMAP.md](ROADMAP.md) § Port sources). It exists now so adopters
see how the modules compose into one delivery motion.

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
