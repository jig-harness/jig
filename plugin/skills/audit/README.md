# `/jig:audit`: where a repository stands

A team adopting delivery practices needs to know which ones it already has,
which matter most to add, and, months later, whether what it adopted still
holds. Without an audit it guesses: practices that exist only as a sentence in
a document look the same as practices a check enforces, a gate that quietly
stopped running goes unnoticed, and every review of the practices starts from
nothing because no one wrote down what the last one found.

`/jig:audit` points an agent at a repository and returns a report with
prioritized, actionable recommendations. It is the brownfield entry point
([principle 6](https://github.com/docomply/jig/blob/main/principles/06-audit-first.md)),
and because it records what it found in the repository itself, every later run
is a regression check: it reports what was fixed, what slipped, and what Jig
added since, and it does not repeat a recommendation the team declined.

## What it does

1. **Configuration fit** (a script). Checks the repository's
   `.config/jig.yaml` against the plugin's
   [configuration schema](config-schema.yaml) and against the repository:
   unknown, refused or deprecated fields, wrong types, commands and paths that
   do not exist, required checks that never run, a tracker that cannot be
   reached, declared values the repository contradicts (`stacking: none` with
   stacked pull requests open), and settings its shape suggests.
2. **Surveys.** Read-only surveys of the repository's practices, run in
   parallel where the agent can: agent scaffolding, documentation governance,
   automation and enforcement, review and learning loop.
3. **Maturity scoring.** Every criterion of every module
   ([criteria](criteria/README.md)) is scored on the enforcement ladder with
   file-path evidence. A criterion that names a fact a file search can rule
   out carries a *probe*: when the fact is missing, the script scores it
   `absent` itself.
4. **The record.** `.config/jig-audit.yaml` in the audited repository: the
   plugin version, the date and commit, each criterion's score and evidence,
   and the recommendations the team declined, each with its reason and the
   condition for revisiting it. The next audit compares against it.
5. **The report**, in the [report template](references/report-template.md)'s
   structure: executive summary, detected stack, configuration fit, module
   scores and levels, changes since the last audit, ranked gaps, drift, and an
   adoption sequence.

The audit is read-only: it writes the record and nothing else. Applying a
recommendation is a separate request (`/jig:audit apply <ref>`) that opens one
pull request for that one recommendation, through `do-item`'s pull-request
policy.

## Run it

Install the [plugin](../../README.md#install-the-plugin), open an agent
session in a full clone of the repository, and run `/jig:audit`. Nothing needs
configuring: the audit reads `.config/jig.yaml` when there is one and reports
"not configured" when there is not. It uses `gh` for the repository host's
settings (branch protection, required checks, recent pull requests) and the
tracker adapter for one read; without them it marks those questions
unchecked.

Commit the record it writes. Run the audit again after a few weeks of work, or
after updating the plugin: the report then starts with what changed.

To decline a recommendation, keep it in the record:

```yaml
declined:
  - refs: [M1/precommit-autofix-hooks]   # criteria (M<n>/<id>) or config/<finding id>
    reason: The editor formats on save and CI checks formatting.
    revisit_when: Formatting failures reach CI more than once a month.
    revisit_after: "2027-04-01"           # optional
```

Later audits leave it out until the condition holds, the date passes, or the
criteria it names pass on their own.

For several related repositories, `/jig:audit portfolio a=<record> b=<record>`
compares their committed records instead of auditing each again
([portfolio method](references/portfolio-methodology.md)).

## Contents

| Path | What it holds |
|------|---------------|
| [SKILL.md](SKILL.md) | The procedure the agent follows |
| [config-schema.yaml](config-schema.yaml) | Every `.config/jig.yaml` field: type, readers, `since`, deprecation |
| [criteria/](criteria/README.md) | Each module's maturity criteria and probes, and their format |
| [references/methodology.md](references/methodology.md) | The audit method, step by step |
| [references/survey-prompts/](references/survey-prompts/) | One read-only survey prompt per practice area |
| [references/report-template.md](references/report-template.md) | The structure of the report |
| [references/portfolio-methodology.md](references/portfolio-methodology.md), [portfolio-report-template.md](references/portfolio-report-template.md) | The comparison pass over several repositories |
| [calibration/](calibration/) | Audit runs against real repositories, kept as worked examples |
| `scripts/config-fit.ts` | Configuration fit (`--offline`, `--json`) |
| `scripts/score.ts` | The scoring checklist, the draft record, and `--check` of the criteria |
| `scripts/record.ts` | `check`, `compare`, `summary` and `portfolio` over records |

## Changing it

- A new configuration field goes into [config-schema.yaml](config-schema.yaml),
  [CONFIGURATION.md](../../CONFIGURATION.md) and the skill that reads it in one
  pull request, with `since:` the new plugin version; the audit's tests fail
  when the schema and CONFIGURATION.md disagree, or when the schema's value
  sets differ from the reading skills' own.
- A new or changed criterion follows [criteria/README.md](criteria/README.md);
  a new one carries `since:`.
- A run that exposes a gap in the method updates the survey prompts or the
  methodology, and the run is kept under [calibration/](calibration/).
