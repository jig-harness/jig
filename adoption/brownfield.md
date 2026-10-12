# Brownfield adoption

Improving an existing project. The entry point is an **audit**, not a module.

## The ladder

1. **Audit** — run [audit/](../audit/) against the repo. Output: module
   scores, drift findings, and a prioritized adoption sequence phrased in your
   own toolchain.
2. **Fix drift first** — stale instruction files and docs that contradict
   reality actively mislead every agent session; fixing them is cheap and
   pays immediately. Drift fixes are usually an audit's highest-value quick
   wins.
3. **Adopt modules in the report's order, one rung at a time** — "adopted"
   means "reached Lite," then climb. The default leverage ordering when the
   report doesn't say otherwise: **M1** (gates — makes everything else
   checkable) → **M2** (freshness — stops the rot) → **M0** (instructions —
   makes agents effective) → **M4** (docs governance). Defer M3/M8/M11 until
   the basics hold.
4. **Codify before you mechanize** — for practices your team already follows
   tacitly, write the canonical doc first (cheap), then promote it up the
   enforcement ladder (hook → CI) as evidence accumulates. Don't build gates
   for rules nobody has agreed to.
5. **Re-audit** — periodically, and after each adoption push: the re-audit
   diffs against the prior report (fixed / still-open / regressed) and
   doubles as a practices-drift regression check.

## Constraints that make brownfield different

- **Meet the stack where it is** (principle 1): recommendations must land in
  the existing toolchain; a practice that requires a tool migration is a last
  resort, and flexibility across trackers/hook-managers/CI providers is the
  point.
- **Baselines before blocking**: new gates start advisory on a brownfield
  codebase (existing violations grandfathered or burned down first), with a
  promotion condition attached — advisory-forever is drift (principle 4).
- **One concern per change**: adopt via small PRs scoped to one module rung,
  not a big-bang "process PR" nobody can review.
