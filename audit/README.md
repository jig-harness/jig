# The auditor

Point groundwork at an existing repository and get back an analysis report
with prioritized, actionable recommendations. This is the primary brownfield
entry point ([principle 6](../principles/06-audit-first.md)) and, re-run
periodically, a practices-drift regression check.

## Contents

| File | Purpose |
|------|---------|
| [methodology.md](methodology.md) | The four-step audit method an agent executes |
| [portfolio-methodology.md](portfolio-methodology.md) | The additional comparison pass for auditing several related repos |
| [survey-prompts/](survey-prompts/) | One ready-to-run prompt per practice area (fan out in parallel) |
| [report-template.md](report-template.md) | The structure of the deliverable |
| [portfolio-report-template.md](portfolio-report-template.md) | The portfolio-level conclusions and shared-capability structure |
| [score-modules.ts](score-modules.ts) | Generates the fill-in scoring checklist from every module's `maturity.yaml` (`--check` verifies all 13 carry criteria) |
| [calibration/](calibration/) | End-to-end audit runs against external repos, kept as worked examples |

## Running an audit (agent instructions)

1. Open an agent session in (or pointed at) the target repo, read-only.
2. Follow [methodology.md](methodology.md): run the survey prompts as
   read-only surveys (in parallel where the agent environment permits; prepend
   `survey-prompts/00-shared-preamble.md` to each), detect the stack and
   repository-host enforcement, then synthesize.
3. Produce the report per [report-template.md](report-template.md). Every
   claim carries file-path evidence; recommendations are phrased in the
   target's own toolchain.

For several related repositories, complete the per-repo runs first and then
follow [portfolio-methodology.md](portfolio-methodology.md). The comparison
pass finds copied practices that have drifted, missing organization-wide
enforcement, and capabilities that need a maintained home outside any one
application repo. It does not turn organization-specific policy into a
Groundwork module.

**v1 (scored maturity assessment)**: every module M0–M12 now ships formal
`maturity.yaml` criteria, so an audit scores the *whole* module map against
observable criteria rather than grading later modules by feel. Run
[`score-modules.ts`](score-modules.ts) to emit the fill-in checklist (one row
per criterion, with empty Score/Evidence columns) and paste it under the
report's "Module scores"; `bun score-modules.ts --check` asserts all 13 modules
carry criteria, so a future port that forgets its `maturity.yaml` fails loudly.
Qualitative grading on the enforcement ladder (*absent / convention-only /
advisory / mechanically enforced*) is now the fallback only where a criterion
is inapplicable to the target's shape (mark it "expected-absent"), not the
default for whole modules.

**Dogfood target**: periodically re-run the auditor against the reference
implementation (docomply) — it doubles as a practices-drift regression check
([methodology.md](methodology.md) step 4 diffs a re-audit against the prior
report). That run needs read access to the private reference repo; a report
without file-path evidence from the actual target is not a valid audit
([methodology.md](methodology.md) rule: no finding without evidence), so it is
run where that checkout is available, not fabricated here.
