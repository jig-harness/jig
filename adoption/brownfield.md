# Brownfield adoption

Improving an existing project. The entry point is an **audit**, not a module.

## Before the first audit

An audit scores one commit, so settle what would make that commit misleading
first. If the repository still uses the `groundwork` plugin (Jig's former
name), migrate it as
[moving from the `groundwork` plugin](../plugin/README.md#moving-from-the-groundwork-plugin)
says and commit the migration, then audit: the audit reads the configuration
the migration writes. The rest of the hygiene before a first audit:

- the Jig configuration (`.config/jig.yaml`) migrated and committed, so the
  audit's draft names a commit that holds it;
- `.context/` in `.gitignore` where the workspace tool keeps working files
  there, so they never show as changes;
- the dependencies installed, so the git hooks the repository configures
  actually run in this checkout;
- the checkout on the integration branch and up to date with the remote, so
  the audit does not score a stale tree.

## The ladder

1. **Audit** — run [`/jig:audit`](../plugin/skills/audit/README.md) in the
   repo. Output: module scores, drift findings, and a prioritized adoption
   sequence phrased in your own toolchain, plus a committed record the next
   audit compares against.
2. **Fix drift first** — stale instruction files and docs that contradict
   reality actively mislead every agent session; fixing them is cheap and
   pays immediately. Drift fixes are usually an audit's highest-value quick
   wins.
3. **Adopt modules in the report's order, one maturity level at a time** — "adopted"
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
- **One concern per change**: adopt via small PRs scoped to one module's next
  maturity level, not a big-bang "process PR" nobody can review.

## Grandfathering a coverage gate

A pass/fail coverage check ("every file/workspace must map to something") is
right for greenfield and unreachable for brownfield on day one. The honest
pattern has these properties:

1. A named, in-code exception set that **new entries may never be added to**
   — it exists to grandfather what predates the gate, not to accumulate new
   debt. Stating this as policy is not enough: the set is an ordinary
   in-code list, so a PR adding a newly-uncovered item can add it to the same
   list and keep the gate green. Enforce it mechanically — diff the set
   against its value on the base branch and fail the check if the diff
   contains any addition; removals always pass. The comparison side must
   come from the trusted base (the base branch's copy of the set or of a
   frozen baseline file, never the PR's own copy, which the PR can edit in
   step), and the comparison script stays under required review ownership.
2. Suppression applies **only** to the "uncovered" finding class. A path
   moving from fully-uncovered to partially-covered is a fresh fact, not
   noise — it still reports, so the backlog reflects the gate's real
   progress instead of a single frozen count.
3. A companion set pinning any *partial* coverage by **exact glob and a real
   on-disk path**, so neither deleting the pinning declaration nor deleting
   the files it names passes silently: the glob must still resolve to its
   path, and the pin set is diffed against the base branch so a removed pin
   fails unless its path is now fully covered or gone from the tree.

Its failure mode is worth stating plainly: an exception set that only routes
findings to a closed tracking issue has no owner, and a closed issue looks
resolved on every dashboard that matters — the set becomes permanent by
default. An exception set needs a **live**, currently-open owner, or it stops
being a grandfather clause and becomes a permanent carve-out nobody chose.

See [M3](../modules/M3-change-area-catalog/reference/catalog/README.md#grandfathering-catalog-coverage)
for the concrete two-set mechanism applied to change-area workspace coverage.
