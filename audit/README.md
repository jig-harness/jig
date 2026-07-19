# The auditor

Point groundwork at an existing repository and get back an analysis report
with prioritized, actionable recommendations. This is the primary brownfield
entry point ([principle 6](../principles/06-audit-first.md)) and, re-run
periodically, a practices-drift regression check.

## Contents

| File | Purpose |
|------|---------|
| [methodology.md](methodology.md) | The four-step audit method an agent executes |
| [survey-prompts/](survey-prompts/) | One ready-to-run prompt per practice area (fan out in parallel) |
| [report-template.md](report-template.md) | The structure of the deliverable |
| [calibration/](calibration/) | End-to-end audit runs against external repos, kept as worked examples |

## Running an audit (agent instructions)

1. Open an agent session in (or pointed at) the target repo, read-only.
2. Follow [methodology.md](methodology.md): launch the survey prompts as
   parallel read-only sub-agents (prepend `survey-prompts/00-shared-preamble.md`
   to each), detect the stack, then synthesize.
3. Produce the report per [report-template.md](report-template.md). Every
   claim carries file-path evidence; recommendations are phrased in the
   target's own toolchain.

**v0 caveat**: formal `maturity.yaml` scoring criteria exist for the ported
modules (M0–M2 so far — score those against their criteria files); the
remaining modules land theirs with each port (see
[ROADMAP.md](../ROADMAP.md)). Until then, score unported modules
qualitatively on the enforcement ladder (*absent / convention-only /
mechanically enforced*). That is exactly what the founding audit did.
