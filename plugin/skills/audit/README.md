# `/jig:audit`: where a repository stands

A team adopting delivery practices needs to know which ones it already has,
which matter most to add, and, months later, whether what it adopted still
holds. Without an audit it guesses: practices that exist only as a sentence in
a document look the same as practices a check enforces, a gate that quietly
stopped running goes unnoticed, and every review of the practices starts from
nothing because no one wrote down what the last one found.

`/jig:audit` points an agent at a repository and returns an audit sheet: a
polished HTML report of where the repository stands against the profile the
team aims for, with prioritized, actionable recommendations the team accepts,
refines or declines in place and hands back to the agent. It is the brownfield entry point
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
   stacked pull requests open), and settings its shape suggests. It also
   gathers what a profile suggestion rests on (how many people commit, CI
   that deploys or publishes, documents that name a compliance regime) and
   names the lightest profile those facts support.
2. **Surveys.** Read-only surveys of the repository's practices, run in
   parallel where the agent can: agent scaffolding, documentation governance,
   automation and enforcement, review and learning loop.
3. **Maturity scoring.** Every criterion of every module
   ([criteria](criteria/README.md)) is scored on the enforcement ladder with
   file-path evidence. A criterion that names a fact a file search can rule
   out carries a *probe*: when the fact is missing, the script scores it
   `absent` itself.
4. **The record.** `.config/jig-audit.yaml` in the audited repository: the
   plugin version, the date and commit, the profile the team aims for, each
   criterion's score and evidence, and the recommendations the team
   declined, each with its reason and the condition for revisiting it. The
   next audit compares against it.
5. **Profiles as targets.** [profiles.yaml](profiles.yaml) gives each profile
   (Solo/Lite, Team/Standard, Regulated/Strict) a target level per module and
   the order to adopt modules in, so the audit shows each module's target and
   the criteria left to reach it.
6. **The audit sheet** ([format](references/report-sheet.md)): one
   self-contained HTML file, with the same report as Markdown beside it. It
   opens with the summary and a maturity map against the target, then the
   moves that matter most, what changed since the last audit (with each
   module's level across older records), the recommendations by module and
   the gaps within the target none of them covers, every criterion with its
   evidence,
   configuration fit (with a starter configuration where one helps), drift,
   and exactly what was examined and what could not be checked. Every mark
   and module chip explains itself in a popover, and a guide inside the same
   file explains Jig, its modules and profiles, and how to read the sheet,
   for a reader who has never met Jig.
7. **Decisions.** In the sheet the team marks each recommendation accept,
   take the lighter option, refine, decline (with a reason and when to
   revisit) or *this is wrong*; can flag any criterion's score as wrong; and
   can change the profile and which of its conditional targets apply. It
   copies the decisions as one block. Pasted back to the agent,
   `record.ts apply-feedback` records the declines, the profile and its
   conditions, prints the accepted work ranked as the sheet's Start here
   ranks it, and prints every *wrong* as a calibration note without
   changing a score.

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

Open the audit sheet it writes, mark your decisions, press **Copy
decisions** and paste them back into the session. Commit the record. Run the
audit again after a few weeks of work, or after updating the plugin: the
sheet then starts with what changed.

A decline is kept in the record (the sheet writes this for you):

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
| [profiles.yaml](profiles.yaml) | Each profile's target level per module, and the adoption order |
| [criteria/](criteria/README.md) | Each module's maturity criteria and probes, and their format |
| [references/methodology.md](references/methodology.md) | The audit method, step by step |
| [references/survey-prompts/](references/survey-prompts/) | One read-only survey prompt per practice area |
| [references/report-sheet.md](references/report-sheet.md) | The report source an audit writes, and the sheet rendered from it |
| [references/portfolio-methodology.md](references/portfolio-methodology.md), [portfolio-report-template.md](references/portfolio-report-template.md) | The comparison pass over several repositories |
| [calibration/](calibration/) | Audit runs against real repositories, kept as worked examples |
| `scripts/config-fit.ts` | Configuration fit (`--offline`, `--json`, `--draft` for a starter configuration) |
| `scripts/report.ts` | `validate`, `render` and `extract` of the audit sheet |
| `scripts/report/lucide/` | The icons the sheet draws, vendored from [Lucide](https://lucide.dev) under the ISC licence (its `LICENSE` beside them) |
| `scripts/score.ts` | The scoring checklist, the draft record, and `--check` of the criteria |
| `scripts/record.ts` | `check`, `compare`, `summary`, `portfolio` and `apply-feedback` over records |

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
