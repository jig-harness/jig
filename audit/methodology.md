# Audit methodology

Four steps, executable by any capable agent runtime with read access to the
target repo. Terms: [GLOSSARY.md](../GLOSSARY.md).

## 1. Fan out parallel surveys

Use a **full clone** of the target — several survey questions (drift over
time, review practice, supersession) are unanswerable from a shallow
snapshot. Launch the four survey prompts in
[survey-prompts/](survey-prompts/) as parallel **read-only** sub-agents
against the target repo, each with the shared preamble prepended. Each survey returns a structured synthesis with
file-path evidence — never file dumps. Add a fifth, project-specific survey if
the target has a large surface the four don't cover (e.g., a data platform).

The four areas: agent scaffolding; documentation governance; automation &
mechanical enforcement; review architecture & learning loop. (Tasks/memory and
environments/CI are covered inside surveys 3–4.)

## 2. Detect the stack

Derive, don't ask ([principle 1](../principles/01-principles-over-tools.md)):
package manager from lockfiles; task runner and monorepo layout from config
files; CI provider from workflow directories; hook manager from its config;
issue tracker and review bots from references in configs, docs, and PR
history. Record the derived stack in the report header — every recommendation
must be phrased in these tools.

## 3. Score modules on the enforcement ladder

For each groundwork module (M0–M12), grade the target:

- **absent** — the practice doesn't exist (mark "expected-absent" where the
  repo's shape makes the practice inapplicable — e.g. no deploy pipeline in
  a library);
- **convention-only** — practiced or documented, but nothing mechanical fails
  when it's violated;
- **advisory** — a check runs mechanically but cannot block (non-blocking CI
  step, fail-off coverage upload); score it with its promotion condition,
  or the lack of one;
- **mechanically enforced** — hooks/CI/review gates catch violations (note
  which rung, and whether CI is the authority).

Where a module has `maturity.yaml`, score its criteria individually; otherwise
grade qualitatively with evidence. Also record **drift findings** — places
where the repo's stated practices contradict its actual state (stale
instruction files, docs describing retired tools, dangling paths). Drift is a
first-class result: the founding audit's most actionable findings were drift.

## 4. Synthesize the report

Merge into [report-template.md](report-template.md)'s structure:

1. practice inventory mapped to the module map (what exists, where);
2. gap analysis ranked by **leverage × effort**, each item with evidence and
   a concrete next action in the target's own toolchain;
3. drift/contradiction findings;
4. a recommended adoption sequence (which modules, which maturity rung first).

Rules: no finding without file-path evidence; distinguish *verified* facts
from *unchecked* counts; keep the executive summary readable by someone who
hasn't heard any of this vocabulary (link the glossary). Re-audits diff
against the prior report: fixed / still-open / regressed.
