---
name: audit
description: "Audit a repository against Jig's practice modules: check its Jig configuration against the repository, score every module's maturity criteria with file-path evidence against the profile the team aims for, compare with the committed record of the last audit, and report prioritized recommendations as an HTML audit sheet the team marks its decisions in; records those decisions when they are pasted back; read-only unless asked to apply a recommendation. Use to see where a repository stands, to re-check it for drift, or to compare several repositories."
argument-hint: "[apply <ref> ...] | [portfolio <name>=<record> ...] | (paste an audit_feedback block)"
allowed-tools: "Read Write Edit Grep Glob Agent Bash(bun *) Bash(git *) Bash(gh *)"
---

# Audit a repository

Tell a repository where it stands against Jig's practice modules
([modules](https://github.com/docomply/jig/blob/main/modules/README.md)), and,
on every later run, what changed since. The audit writes one file, the record
`.config/jig-audit.yaml`, and changes nothing else in the repository unless the
user asks to apply a recommendation (step 8).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository under audit. Never `cd` into
the skill directory. Use a full clone, not a shallow one: several questions
need history. The method in detail is in
`${CLAUDE_SKILL_DIR}/references/methodology.md`; read it before the first step.

## Arguments

- No argument: audit the repository (steps 1–6).
- A pasted `audit_feedback:` block (the audit sheet's **Copy decisions**):
  record the team's decisions and plan the accepted work (step 7).
- `apply <ref> …`: apply recommendations of the last audit (step 8).
- `portfolio <name>=<record> …`: compare several repositories' records
  (step 9).

## 1. Configuration fit

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/config-fit.ts"
```

It checks the repository's `.config/jig.yaml` against the plugin's
configuration schema (`${CLAUDE_SKILL_DIR}/config-schema.yaml`) and against the
repository: unknown, refused and deprecated fields, wrong types, what the
skills' own validation rejects, commands and paths that do not exist, required
checks that never run, a tracker that cannot be reached, declared values the
repository contradicts, and settings its shape suggests. Each finding has an id
(`config/<id>`). Exit 1 means at least one error; it is a finding, not a reason
to stop. Without network access or `gh`, add `--offline`; the forge and
tracker questions are then reported as unchecked, never as passing.

It judges the repository's file alone: the user file (`~/.jig/jig.yaml`) and
`JIG__*` variables belong to whoever runs the audit. What they add on this
machine is reported as facts (`fact:user-layer`, `fact:environment-layer`),
and a user file that sets a field only a repository may set is a warning
(`fact:user-layer-refused`).

If it warns `fact:newer-plugin-installed`, stop and tell the user: this
session runs an older plugin than the one installed, and a session keeps the
version it started with. Audit again in a new session.

Keep its **Facts** section: the integration branch, its protection and the
required checks are evidence for steps 2 and 3, and the profile facts (people
committing in the last 90 days and the last year, automation counted apart;
CI files that name deploy, release or publish work; documents whose path or first
heading names a compliance regime; and the `suggested_profile` they support,
also as `profile_facts` in the `--json` output) are what step 3 suggests a
profile from. Save its `--json` output to
the scratch folder as well (`config-fit.ts --json > <scratch>/fit.json`): the
audit sheet shows it. When the repository has no configuration file, or the
check suggests settings, the report includes a starter configuration
(`config-fit.ts --draft` prints it alone).

## 2. Surveys and stack

Run the survey prompts in `${CLAUDE_SKILL_DIR}/references/survey-prompts/`
as read-only surveys, each with `00-shared-preamble.md` prepended. Run them in
parallel subagents where the harness has them; otherwise one after another,
with the same evidence rules. Detect the stack and the repository host's
enforcement as `references/methodology.md` step 2 says. Never print a
credential you find.

## 3. Score the criteria

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/score.ts" --draft <scratch>/jig-audit.next.yaml
```

Write the draft outside the repository (a temporary folder). It holds one entry
per criterion of every module, with the criterion and its pass bar as comments
and the prior audit's answer when there is one. Criteria whose probe found the
precondition missing are already scored `absent`; a probe that could not read
a file is marked unchecked and left for you. The format of criteria and probes
is in `${CLAUDE_SKILL_DIR}/criteria/README.md`.

Fill every `score: null` with `absent`, `convention`, `advisory`,
`mechanical` or `expected-absent`, and every `evidence` with file paths (and
the host query, for settings outside the checkout). Score from the survey
results; read the files yourself where a survey did not settle a criterion. A
probe's `absent` stands unless you find what the probe could not see; then
score it and replace the evidence with your own. Evidence beginning `probe: `
marks a score the probe decided, and the sheet credits the probe only for
that, so never begin your own evidence with it. Set `shape` (library, application,
service, monorepo, documentation, …): it is what makes `expected-absent`
defensible.

Set `profile`, the maturity the team aims for (`${CLAUDE_SKILL_DIR}/profiles.yaml`:
`solo-lite`, `team-standard`, `regulated-strict`). Keep the prior record's.
On a first audit ask the user; when they do not know, leave it `null` and
suggest one in the report: take step 1's `suggested_profile` as the report's
`profile` with `source: "suggested"`, and write its `why` from the facts the
suggestion lists. Compliance documents never make the suggestion
Regulated/Strict: say they were found and ask the user to consider it. List in
`profile_conditions` the conditional targets the user says apply (for
example `M12` when several agents work the repository in parallel
workspaces), and set `heading_to` when the user says where the project is
growing (a prototype becoming a product, a product entering a regulated
market).

Stay proportionate: the profile is the user's dial, not yours. When you
suggest one, suggest the lightest that the facts you observed support, and
never Strict by default. If the facts suggest the project has outgrown its
profile (more contributors, a deploy environment that appeared, a compliance
document), list each in the report source's `profile.signals` with its
evidence (step 5): the sheet shows them beside the profile as reasons to
revisit the dial, never as findings.

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" check <scratch>/jig-audit.next.yaml
```

Repeat until it reports the record complete.

## 4. Compare with the last audit

When `.config/jig-audit.yaml` exists:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" compare .config/jig-audit.yaml <scratch>/jig-audit.next.yaml
```

It lists criteria fixed, regressed, still open, new, and added by Jig since the
prior audit's plugin version; configuration fields added since; and each
declined recommendation as **held** (do not recommend it again; check its
`revisit_when` condition yourself, and when it now holds, set the entry's
`revisit_after` to today in the draft record and say why in the summary: that
makes it due, and the sheet accepts the recommendation; when the entry
names a `config/` finding, also save the fit report again against the draft,
`config-fit.ts --json --record <scratch>/jig-audit.next.yaml > <scratch>/fit.json`
(with `--offline` if step 1 used it), since step 1's report still holds that finding back), **due** (its revisit date has passed: recommend it again), **resolved**
(every criterion it names now passes, and it names no configuration finding:
drop the entry) or **stale** (a criterion it names no longer exists: ask the
user). The comparison refuses a draft that `record.ts check` finds incomplete.
`config-fit.ts` already leaves out the configuration findings the record
declines, except errors, which no decline hides.

## 5. Report: the audit sheet

Write the report source, `<scratch>/jig-audit.json`, as
`${CLAUDE_SKILL_DIR}/references/report-sheet.md` describes: the summary, what
was examined and what could not be checked, the stack, the recommendations
(each with an id, the refs the record would use to decline it, the finding,
the action in the repository's own tools, evidence, leverage and effort), the
drift findings and the terms a newcomer needs. Rank recommendations by
leverage × effort; `record.ts summary <scratch>/jig-audit.next.yaml` gives
each module's level and, with a profile, its target and gap. Recommend toward
the target: the sheet groups what lies beyond it as *as you grow* (needed for
`heading_to`) or *optional*, so write those only where they are worth knowing
about. Give a recommendation a `lighter` option wherever a lighter way gets
most of the benefit, usually writing the rule down before building a gate.
Every gap within the target (a criterion there that does not meet its bar)
should be moved by some recommendation's refs or left on purpose:
`report.ts validate <scratch>/jig-audit.json --record <scratch>/jig-audit.next.yaml --fit <scratch>/fit.json`
warns of each gap no recommendation covers, and the sheet lists them. Add a
recommendation for each, or say in the summary why it is left.

On a re-audit, the trend needs the older records, which the committed
record's history holds. List the commits that changed it, and write the
record at each (the most recent is `.config/jig-audit.yaml` itself, the
`--prior`):

```bash
git log --format=%H -- .config/jig-audit.yaml
git show <commit>:.config/jig-audit.yaml > <scratch>/jig-audit.<commit>.yaml
```

Then:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/report.ts" render <scratch>/jig-audit.json \
  --record <scratch>/jig-audit.next.yaml --fit <scratch>/fit.json \
  [--prior .config/jig-audit.yaml [--history <scratch>/jig-audit.<commit>.yaml]…] \
  --out <folder>
```

It refuses a recommendation whose refs the record does not know or the team
declined, and history it cannot order: a record dated after the prior, or two audits of one day (the same date, commit and scores are one audit, whatever decisions were recorded since). It writes `jig-audit-<date>.html`, the audit sheet, and
`jig-audit-<date>.md`, the same report as text. Give the user the sheet's
path: they read it in a browser, mark each recommendation **accept**,
**refine**, **decline** (with a reason and a condition for revisiting) or
**this is wrong**, and paste the copied decisions back (step 7). Write both
files outside the repository unless the user names a folder: they list paths
and settings a team may not want published. Print a short summary in the
conversation as well: the levels, the three moves that matter most, and the
sheet's path.

## 6. Record

Copy the completed draft over `.config/jig-audit.yaml`. Do not commit or push
unless the user asks; when they do, the record goes in its own commit.

## 7. Record the team's decisions

When the user pastes an `audit_feedback:` block, save it to the scratch
folder and run:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" apply-feedback <scratch>/decisions.yaml \
  --report <scratch>/jig-audit.json
```

(`--dry-run` shows the plan without writing.) It refuses a block written for
another repository, commit or report, accepted or refined work on a
criterion the record holds declined, a `profile_conditions` module that is
not a conditional target of the profile that will apply (or of
`heading_to`'s), and a `scores` entry naming a criterion the record does not
hold. Otherwise it adds each decline to the record's `declined` list with
its reason and revisit condition (a decline of refs the record already
declines renews that entry), sets the profile when the team changed it,
replaces `profile_conditions` with the team's list when the block has one
(removing it when the list is empty), and prints the accepted and refined
work, ranked as the sheet's Start here ranks it. Offer to apply that list
together (step 8), or to file it as tracker items. For each **this is
wrong** on a recommendation, and each entry under `scores` (the team says a
criterion's score itself is wrong), it prints a calibration note and leaves
the score as it is: re-examine the criterion with the team's note, correct
the score and its evidence in the record if they are right, and tell the
user the audit misjudged it: that is a defect in Jig's criteria or probes,
worth reporting.
A decline the user gives in conversation instead goes under `declined` by
hand, with the same fields (`revisit_after`, a date, is optional).

## 8. Apply recommendations (only when asked)

Applying is a separate step, never part of an audit. For `apply <ref> …`:

1. Read each recommendation from this session's report source, or from a
   saved sheet the user names (`report.ts extract <sheet.html>`). The record
   holds scores and declined recommendations, not the recommendations
   themselves, so without a report run the audit first (steps 1–5).
2. Group them into as few pull requests as possible: one, unless part of
   the work needs its own decision by a person or the change would exceed the
   repository's size budget; then split by area, never one pull request per
   recommendation. Recommendations of one audit touch the same few files (the
   instruction file, the changelog, the configuration), so separate pull
   requests conflict with each other at every merge. Put new practice detail
   in the document it belongs to and link it from the instruction file,
   rather than growing the instruction file.
3. Leave the audit record's scores of existing criteria as they are: the
   record scores the commit it audited, and the next audit scores the change.
   Name in the pull request description the criteria each recommendation
   targets. A change that adds, renames or removes a criterion updates those
   criteria's entries in the record too, scored against the audited commit.
4. Create a branch and plan each pull request with `do-item`'s policy:
   `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/pr-plan.ts" open` (and
   `branch` first when the change belongs to a tracker item). Follow what it
   prints: base, draft or Ready, labels, title convention, template.
5. Make the change, run the repository's gates, and open the pull request.
   Offer `/jig:drive-pr` on it.

## 9. Several repositories

For `portfolio`, use the records the repositories already committed; audit a
repository again only when its record is missing or older than the commit
being compared. Then:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" portfolio <name>=<path> <name>=<path> …
```

and follow `${CLAUDE_SKILL_DIR}/references/portfolio-methodology.md` with
`references/portfolio-report-template.md`.

## Rules

- No finding without file-path evidence, or the search that found nothing.
- A setting you could not read is **unchecked**, never assumed.
- Do not repeat a declined recommendation while it is held.
- Read-only: the audit writes `.config/jig-audit.yaml` and nothing else in
  the repository; the sheet and its text go outside it unless the user names
  a folder.
