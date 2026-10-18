---
name: audit
description: "Audit a repository against Jig's practice modules: check its Jig configuration, score each module's maturity criteria with file-path evidence against the target profile, compare with the last audit's committed record, and report prioritized recommendations as an HTML audit sheet; records the team's decisions when pasted back. Read-only unless asked to apply a recommendation. Use to see where a repository stands, re-check it for drift, or compare several repositories."
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
would expand the unset variable to an empty string. An installed plugin keeps
its skills under the tool's plugin cache, one folder per version (for Claude
Code, `~/.claude/plugins/cache/jig/jig/<version>/skills/audit`); take the
newest version's.

If `bun` fails with a message that the repository's `mise.toml` is not
trusted, `bun` is a mise shim reading the audited repository's
configuration: run `mise trust` there when the user agrees, or call the Bun
binary directly (`mise which bun` prints its path).

Run every command from the root of the repository under audit. Never `cd` into
the skill directory. Use a full clone, not a shallow one: several questions
need history. The method in detail is in
`${CLAUDE_SKILL_DIR}/references/methodology.md`; read it before the first step.

### The scratch folder

The draft record, the fit report and the report source are written to a
folder outside the repository's tracked files, made for this audit alone:

```bash
scratch=$(mktemp -d)
```

In an agent workspace that keeps a gitignored `.context/` folder, make it
there instead, so the files outlive the session, still one per run:

```bash
mkdir -p .context/jig-audit && scratch=$(mktemp -d .context/jig-audit/run-XXXXXX)
```

Never a fixed path, shared (`/tmp/jigaudit`) or per checkout
(`.context/jig-audit/` itself): two audits would overwrite each other's
files. The tools refuse a record whose commit the repository does not hold,
and a report for another repository, but not two audits of one repository.

### Before the first step

The record names one commit, so settle what the audit should describe first:

1. Check out the integration branch, up to date with its remote. Step 1
   warns when the checkout is behind it.
2. When step 1 reports a leftover `groundwork` configuration or other
   errors the user wants fixed, fix them and commit before step 3; the
   audit then scores the fixed configuration.
3. Install the repository's dependencies, so the hooks the audit finds
   configured can run. On macOS `/tmp` is a symlink to `/private/tmp` and
   some install scripts refuse a symlinked path, so make any worktree under
   its real path (`pwd -P`). The temporary worktree `--at` makes already is.

`score.ts --draft` refuses a checkout whose tracked files differ from the
commit; `--at HEAD` scores the commit from a temporary worktree instead,
which stays for the whole audit (§ Score).

### Unattended runs

When nobody can answer during the run (a non-interactive session, or a
request such as "optimize this repository for Jig" made without staying for
the result), never block on a question: take each default this file names,
say which in the report's summary, and make the profile the sheet's first
decision. Applying recommendations without the team's decisions is allowed
only when the request asks for changes, and then only as step 8's
unattended tiers say.

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
repository contradicts, tracker labels its label taxonomy
(`label-taxonomy.yaml`) does not define or a `review.taxonomy.types` that
differs from it (`taxonomy:<field>`), and settings its shape suggests. Each finding has an id
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
CI files that name deploy, release or publish work or run on a release or a
pushed tag, and tracked files that configure a deploy (systemd units, a
top-level deploy or infrastructure directory, a Procfile, a hosting
platform's configuration); documents whose path or first heading names a
compliance regime; and the `suggested_profile` they support, with an
`alternative` beside it: the suggested profile when the record declares
another, regulated-strict when compliance documents sit beside
team-standard; also as `profile_facts` in the `--json` output) are what step 3 suggests a
profile from. Save its `--json` output to
the scratch folder as well (`config-fit.ts --json > <scratch>/fit.json`): the
audit sheet shows it. When the repository has no configuration file, or the
check suggests settings, the report includes a starter configuration
(`config-fit.ts --draft` prints it alone). Render the sheet from an online
fit report where the forge can be read: an `--offline` one makes the sheet
show branch protection and the other host settings as unchecked.

## 2. Surveys and stack

Write the draft record first (step 3's `score.ts --draft`): the surveys
score into copies of it. Run the survey prompts in
`${CLAUDE_SKILL_DIR}/references/survey-prompts/` as read-only surveys, each
with `00-shared-preamble.md` prepended and given `<scratch>/fit.json` (the
host facts step 1 read, so no survey queries the host again) and the draft.
Each returns its synthesis and answers for its own modules' open criteria,
in the format `record.ts fill` reads. Run them in parallel subagents where
the harness has them; otherwise one after another, with the same evidence
rules. A repository of under about 300 tracked files needs no subagents:
survey it yourself, prompt by prompt. Parallel surveys of a mature
repository take a few hundred thousand tokens in all; say so before
starting when the user may not expect it.

Then run the drift pass yourself, once, as `references/methodology.md` says:
drift crosses modules, and surveys that each look for it report the same
contradiction several times. Detect the stack and the repository host's
enforcement as `references/methodology.md` step 2 says. Never print a
credential you find.

## 3. Score the criteria

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/score.ts" --draft <scratch>/jig-audit.next.yaml
```

Add `--profile <id>` (with `--conditions M12,…` and `--heading-to <id>` as
the profile's conditional targets and growth need) to leave the criteria
beyond that profile's target unexamined: they are scored `not-examined`, which
meets no bar, is never a gap, and shows on the sheet as not examined. On a
re-audit the prior record's profile is the default; `--examine-all` scores
everything. On a first audit, pass the profile the user chose or step 1's
`suggested_profile`. A `--profile` other than the prior record's adds its
targets to those of the profile the record declares, which the draft keeps;
it never narrows them.

When the user has chosen the profile, add `--declare`: the draft then
declares it (with `--conditions` and `--heading-to`) as the record's
`profile`, in place of the prior record's, so it need not be set by hand.
Otherwise leave the profile undeclared and make it the sheet's first
decision.

Add `--at <rev>` when the checkout has uncommitted changes. `score.ts` checks
the commit out into a temporary worktree and keeps it: the draft's first
line, `# snapshot: <dir>`, names it. Every survey reads the repository's
files there, not the checkout's, so pass that folder to the surveys. When the
record is done, remove it with `git worktree remove --force <dir>`.

The draft holds one entry per criterion of every module, with the criterion
and its pass bar as comments and the prior audit's answer when there is one
(as a comment, for a criterion the draft leaves `not-examined`).
Criteria whose probe found the precondition missing are already scored
`absent`; a probe that could not read a file is marked unchecked and left for
you. A criterion commented `# probe capped: …; at most <rung>` lacks only what
a higher rung needs (usually CI): it is left for you; score what you observe,
no higher than that rung. Its entry carries `at_most: <rung>`, and `record.ts
fill`, `merge` and `check` refuse a score above it. The format of criteria and probes is in
`${CLAUDE_SKILL_DIR}/criteria/README.md`.

Fill every `score: null` with `absent`, `convention`, `advisory`,
`mechanical` or `expected-absent`, and every `evidence` with file paths (and
the host query, for settings outside the checkout). Write the surveys'
answers into the draft rather than editing it by hand:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" fill <scratch>/jig-audit.next.yaml <scratch>/answers-<n>.txt
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" merge <scratch>/jig-audit.next.yaml <scratch>/part-<n>.yaml …
```

`fill` reads answers, one per line (`M1/ci-runs-gates-on-pr: mechanical | .github/workflows/ci.yml`);
`merge` takes copies of the draft that subagents filled. Both refuse unknown
criteria, a probe's score changed (except a probe's `absent` turned
`expected-absent`, where the shape rules the practice out), and two answers
that disagree, and say what is still unscored. Before accepting a survey's answers, verify a sample
against the files: every `mechanical` score and one claim per module.
Score from the survey
results; read the files yourself where a survey did not settle a criterion. A
probe's `absent` stands unless you find what the probe could not see; then
score it and replace the evidence with your own. Evidence beginning `probe: `
marks a score the probe decided, and the sheet credits the probe only for
that, so never begin your own evidence with it. Set `shape` (library, application,
service, monorepo, documentation, infrastructure, …): it is what makes `expected-absent`
defensible.

Set `profile`, the maturity the team aims for (`${CLAUDE_SKILL_DIR}/profiles.yaml`:
`solo-lite`, `team-standard`, `regulated-strict`). Keep the prior record's
(or pass `score.ts --declare`).
The record holds the team's choice only; a suggestion goes in the report
source, never in both. On a first audit ask the user, without blocking: when
nobody can answer, or they do not know, leave it `null` and
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

Repeat until it reports the record complete. It also warns of evidence
naming a path or line the audited commit does not have. Code identifiers,
the audit's scratch files, files the evidence proposes or says are missing,
and the plugin's own scripts named as the plugin's are not read as paths. `record.ts summary
<record> --profile <id>` shows the targets and gaps under a profile without
changing the record, to explore a suggestion.

## 4. Compare with the last audit

When `.config/jig-audit.yaml` exists, save the committed record to the
scratch folder first, and use that copy as the prior in this step and the
next: step 6 copies the new record over `.config/jig-audit.yaml`, and a
comparison or render after it would compare the record with itself. Read it
at the audited commit, `<commit>` below (`HEAD`, or the `--at` revision):

```bash
git show <commit>:.config/jig-audit.yaml > <scratch>/jig-audit.prior.yaml
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" compare <scratch>/jig-audit.prior.yaml <scratch>/jig-audit.next.yaml
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
user). It reports a criterion that moved into or out of `not-examined` apart, as
examined since or no longer examined, never as fixed or regressed. Against a prior record that examined every
criterion, the criteria a narrower profile leaves unexamined are counted in
one line; their prior scores stay as comments in the draft. The comparison refuses a draft that `record.ts check` finds incomplete.
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
warns of each gap neither covers, and the sheet lists them. Add a
recommendation for each, or list it under the source's `left_on_purpose`
with the reason and when to revisit it. Mark a recommendation only a
repository administrator can carry out (a host setting) `needs: "host-admin"`.
`--profile <id>` on `validate` and `render` shows the report under another
profile without changing the record.

On a re-audit, the trend needs the older records, which the committed
record's history holds. List the commits that changed it, from the audited
commit back, and write the record at each but the most recent, which is the
prior step 4 saved:

```bash
git log --format=%H <commit> -- .config/jig-audit.yaml
git show <sha>:.config/jig-audit.yaml > <scratch>/jig-audit.<sha>.yaml
```

Then:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/report.ts" render <scratch>/jig-audit.json \
  --record <scratch>/jig-audit.next.yaml --fit <scratch>/fit.json \
  [--prior <scratch>/jig-audit.prior.yaml [--history <scratch>/jig-audit.<sha>.yaml]…] \
  --out <folder>
```

It refuses a recommendation whose refs the record does not know or the team
declined, and history it cannot order: a record dated after the prior, or two audits of one day (the same date, commit and scores are one audit, whatever decisions were recorded since). It writes `jig-audit-<date>.html`, the audit sheet, and
`jig-audit-<date>.md`, the same report as text. Give the user the sheet's
path: they read it in a browser, mark each recommendation **accept**,
**refine**, **decline** (with a reason and a condition for revisiting) or
**this is wrong**, and paste the copied decisions back (step 7). Write both
files to the scratch folder unless the user names a folder, never to a
tracked path: they list paths and settings a team may not want published.
Unattended, the Markdown twin is what the next reader opens; say where both
are. Print a short summary in the
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
worth reporting. A profile the team chooses that reaches criteria the audit
left `not-examined` is refused until they are scored: score them in the
record, then apply the block again.
A decline the user gives in conversation instead goes under `declined` by
hand, with the same fields (`revisit_after`, a date, is optional).

## 8. Apply recommendations (only when asked)

Applying is a separate step, never part of an audit. For `apply <ref> …`,
or a request that asks for the changes in the same session as the audit:

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
   Commit the record before the applied changes, in its own commit. Name in
   the pull request description the criteria each recommendation targets,
   and give each applied recommendation, and each drift entry fixed,
   `status: "applied"` and `applied_in` in the report source, so the sheet
   shows it done rather than open. `applied_in` may name the commit until
   the pull request exists; once it is opened, name the pull request and
   render the sheet again, with the prior step 4 saved. A change that adds, renames or removes a criterion updates those
   criteria's entries in the record too, scored against the audited commit.
4. Create a branch and plan each pull request with `do-item`'s policy:
   `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/pr-plan.ts" open` (and
   `branch` first when the change belongs to a tracker item). Follow what it
   prints: base, draft or Ready, labels, title convention, template. Its
   size leaves the audit record out, and says so.
5. Make the change, run the repository's gates, and open the pull request.
   Offer `/jig:drive-pr` on it.

Unattended (no decisions from the team), apply only the first two tiers,
and list the rest in the pull request as left for a person. Before applying
either, read the repository's own rules on who may change a path: its
`CODEOWNERS` file, and any protected-path or skeleton inventory its
instruction files name (paths whose change needs a decision record, say).
Leave a change to such a path for a person too, naming the rule that
reserves it.

1. **Drift fixes**: a statement the repository contradicts (a stale path, a
   wrong count, a retired tool named), where the repository shows which
   side is right.
2. **Written rules**: documentation-only recommendations, at the
   `convention` rung.
3. **New gates**: code that can block someone's change; only with the
   team's decision.
4. **Host and policy changes** (`needs: "host-admin"`, branch protection,
   reviewers, turning a habit on for everyone, deleting anything): never
   without a person. When the repository's documents and the host disagree,
   either may be right: report it, change neither.

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
  the repository; the sheet and its text go to the scratch folder unless the
  user names a folder.
