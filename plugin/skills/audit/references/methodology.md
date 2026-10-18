# Audit methodology

Four steps, executable by any capable agent runtime with read access to the
target repo. Terms: [GLOSSARY.md](https://github.com/docomply/jig/blob/main/GLOSSARY.md).

## 1. Fan out parallel surveys

Use a **full clone** of the target — several survey questions (drift over
time, review practice, supersession) are unanswerable from a shallow
snapshot. Run the survey prompts in
[survey-prompts/](survey-prompts/) as **read-only** surveys against the target
repo, each with the shared preamble prepended, and give each the host facts
the audit already read (`fit.json`) and the draft record, so no survey
queries the host again or scores what a probe decided. Run them in parallel
where the agent environment permits safe delegation; otherwise run them
sequentially without weakening their evidence requirements. A repository of
under about 300 tracked files needs no delegation: the auditor surveys it
inline, prompt by prompt. Each survey returns a structured synthesis with
file-path evidence — never file dumps — and an answer for each open
criterion of its own modules, one line each in the format the skill's
`record.ts fill` reads (`M1/ci-runs-gates-on-pr: mechanical | evidence`); the
auditor writes them into the record with `record.ts fill`, or `record.ts
merge` for copies of the draft that subagents filled. Add a fifth,
project-specific survey if the target has a large surface the four don't cover
(e.g., a data platform).

The four areas: agent scaffolding; documentation governance; automation &
mechanical enforcement; review architecture & learning loop. They map onto the
module map as: survey 1 → M0; survey 2 → M4/M5/M6; survey 3 → M1/M2/M3/M10/M12/M13/M14/M15/M16;
survey 4 → M7/M8/M9/M11. (Tasks/memory, environments/CI, pipeline economy, testing strategy, contracts and error handling, releases and versions, process
observability and parallel-agent ergonomics are covered inside surveys 3–4 rather than each
getting its own prompt — add a fifth survey only if one of those is a large
surface in the target.)

## 2. Detect the stack and repository-host enforcement

Derive, don't ask ([principle 1](https://github.com/docomply/jig/blob/main/principles/01-principles-over-tools.md)):
package manager from lockfiles; task runner and monorepo layout from config
files; CI provider from workflow directories; hook manager from its config;
issue tracker and review bots from references in configs, docs, and PR
history. Record the derived stack in the report header — every recommendation
must be phrased in these tools.

Where read-only forge access is available, also verify the settings that are
not stored in the checkout: the default branch, branch protection or rulesets,
required checks, required human reviews, conversation-resolution requirements,
and bot or administrator bypasses. A workflow that runs successfully is not a
merge gate unless the repository host requires it. If host settings cannot be
queried, mark them **unchecked** rather than inferring them from prose or
workflow files. The skill's `config-fit.ts` reads the integration branch, its
protection and rulesets, and the checks recent merged pull requests ran, and
reports them as facts.

Never print credentials while inspecting repository configuration. If a
remote URL or checked-in config contains one, record only the credential's
presence and location, then recommend revocation and a credential-free
replacement.

## 3. Score modules on the enforcement ladder

For each Jig module, grade the target:

- **absent** — the practice doesn't exist (mark "expected-absent" only where
  the repo's shape rules the practice out for good — e.g. no deploy pipeline
  in a library; a practice that waits on another module's practice not yet
  adopted, such as a CI check in a repository without CI, is absent);
- **convention-only** — practiced or documented, but nothing mechanical fails
  when it's violated;
- **advisory** — a check runs mechanically but cannot block (non-blocking CI
  step, fail-off coverage upload, a check that runs only in a local git hook
  anyone can skip); score it with its promotion condition, or the lack of
  one;
- **mechanically enforced** — CI, a required check or a review gate catches
  violations for every change (note which rung, and whether CI is the
  authority).

The scoring rules for the cases that recur (part of a scope covered, a host
plan that cannot require checks, a hook configured but not installed, a
criterion left `not-examined` beyond the profile's target) are in the
[criteria format](../criteria/README.md#scoring).

Every module carries [criteria](../criteria/README.md), so score
**every** module by its criteria individually. The skill's `score.ts --draft`
writes the record to fill in: one entry per criterion with its level and pass
bar, where a criterion whose probe found its precondition missing is already
scored `absent` with the search as evidence, marked `probe: `. Grade every
other entry against the target with a file-path evidence note. A probe's
`absent` stands unless you find what the probe could not see; then score it
and write your own evidence in place of the probe's. An entry commented
`# probe capped: …; at most <rung>` lacks only what a higher rung needs
(CI, for a check CI would enforce): score what you observe, no higher than
that rung, which its `at_most` field holds the record to.
Qualitative grading is the fallback only for a criterion the target's shape
makes inapplicable (score it `expected-absent`).

Where a generator has a documented read-only check mode (a type generator's
`--check`, `tsc --noEmit`, a frozen-lockfile install check, or
`git diff --exit-code` after running the generator in a scratch copy of the
checkout), run it: its result is evidence for the M2 freshness criteria, and
a failing run is a stale file the survey alone would only have called
unchecked. A check that prints nothing on success is reported with its exit
status: silence alone cannot be told from a check that did not run.

Before accepting a survey's scores, verify a sample against the files
yourself: every `mechanical` score, and one claim per module. A sample that
fails sends the module's answers back for re-reading.

Then run the **drift pass**, once, across all modules — drift is
cross-cutting, and surveys that each look for it report the same
contradiction several times. Drift findings are places where the repo's
stated practices contradict its actual state: stale instruction files, docs
describing retired tools, dangling paths, and the repository host's settings
compared with what the repository's own documents say about them (a document
saying administrators are bound by branch protection while the host says
they are not). Drift is a first-class result, and often the most actionable
one: a contradiction is cheap to fix and misleads every agent session until
it is.

## 4. Synthesize the report

Write the report source ([report-sheet.md](report-sheet.md)) and render the
audit sheet from it. The source holds what the record does not:

1. a summary a newcomer can read, and what was examined and what could not
   be checked;
2. recommendations ranked by **leverage × effort**, each with evidence, the
   refs that would decline it, and a concrete next action in the target's own
   toolchain;
3. drift/contradiction findings;
4. the terms a reader needs.

The sheet adds the rest from the record: each module's level, its target
under the team's [profile](../profiles.yaml) and the criteria left to reach
it, in the profile file's adoption order, which is
[brownfield adoption](https://github.com/docomply/jig/blob/main/adoption/brownfield.md)'s
default order (fix drift first, then the modules one rung at a time).

Rules: no finding without file-path evidence; distinguish *verified* facts
from *unchecked* counts; keep the executive summary readable by someone who
hasn't heard any of this vocabulary (link the glossary). Re-audits compare
against the prior record (`record.ts compare`): fixed, still open, regressed,
new, and added by Jig since the prior audit's version; a recommendation the
team declined is not repeated until its condition holds.

When the scope contains related repositories, finish each repo's four steps
before running the separate
[portfolio comparison](portfolio-methodology.md). Do not average module scores
across unlike repo shapes.
