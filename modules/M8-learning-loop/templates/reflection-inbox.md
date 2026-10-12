# Reflection inbox

Where session reflections land before anyone acts on them. One `##` section per
reflection.

**Move processed entries to an archive; do not delete them.** The trigger's
duplicate guard works by finding the `<!-- reflection: … -->` marker, and it reads
the archive as well as this file (`ARCHIVE=`). Delete a processed entry and the
guard forgets that change ever reflected, so the next re-run of the loop — a CI
retry, a resumed session — appends it again and double-counts the change in the
ranking the measurement exists to produce. A `docs/reflection-archive.md` that
nobody reads still does that job.

Records are written by
[`reflection-trigger.ts`](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/reference/reflection-trigger/reflection-trigger.ts), which fires when a
change takes at least `ROUND_THRESHOLD` review rounds to converge. It fills in
the two machine-written fields (`change:`, `rounds:`) and leaves the two
judgement fields blank for you.

Keep the field names as they are. `- change:` and `- rounds:` are what make this
file aggregable — "which changes fought the scaffolding hardest" is the question
that ranks the levers, and it is a `grep` away only while the shape holds.

| Field | Written by | Holds |
|-------|-----------|-------|
| `change` | the trigger | the change identifier — PR number, branch, or ticket key |
| `rounds` | the trigger | how many review rounds it took to converge |
| `levers` | you | what under-served the change: an instruction that did not land, a rule the reviewer had to teach twice, a convention that should have been mechanised, a reviewer config that let a known class through |
| `disposition` | you | the lever id (`L-NNNN`) it became, or `reviewer-config` / `eval-corpus` if the reviewer was the one that was wrong repeatedly, or `no-action` with a reason |

`change` and `disposition` are different keys and must stay that way. `change` is
the **source change** — a PR number, branch, or ticket key — which exists before
the reflection. `disposition` is the **lever** it produced, which does not exist
yet when the trigger fires, and one change may produce several or none. Keeping
them separate is what lets you join in both directions: "which changes fought the
scaffolding hardest" and "which levers came out of them".

A reflection with no lever is a legitimate outcome — record it as
`disposition: no-action` with the reason rather than deleting the entry. The
count of no-action entries is itself a signal: if most hard reviews produce
nothing, the threshold is set too low.

<!-- Records are appended below this line. The example is illustrative — delete it. -->

## PR-482 — converged in 5 rounds (threshold 3)

<!-- reflection: PR-482 rounds=5 -->

- change: PR-482
- rounds: 5
- levers: the reviewer flagged the same missing-timeout pattern in three
  successive rounds; nothing in the instruction files said which calls need one,
  so it was rediscovered per file rather than applied up front
- disposition: L-0117 (a lens for the pattern) plus a line in the module's
  conventions so the next change does not need the reviewer to teach it
