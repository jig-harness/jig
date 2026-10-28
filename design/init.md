# Setting a repository up for Jig: design

**What problem this solves.** A repository adopts Jig today by reading the
[configuration reference](../plugin/CONFIGURATION.md) and writing
`.config/jig.yaml` by hand, or by running the audit and copying the starter
configuration out of the audit sheet. Nothing owns the first hour: checking
that the plugin and its tools are installed, deriving the values the
repository already states, asking the few it does not, writing the file,
ignoring the working folder, enabling the plugin for everyone who clones, and
checking the result the way the audit will. A team that wants to try one
skill is sent through a measurement of its whole repository first. With this
built, one command in a fresh clone leaves behind a checked configuration
ready to commit and says what to run next; the audit stays the measurement it
is.

This is the design of [plan.md](plan.md) item 26. The shared detector it
rests on (step 1 of the build order) is built:
[`plugin/shared/detect.ts`](../plugin/shared/detect.ts), which the audit's
configuration fit calls to print a starter configuration, never writing one.
The skill itself, its pointers and the project-level enablement remain open.

## Where it ends and the audit begins

The two skills share one detector and divide the rest by what they write.

| | `/jig:init` | `/jig:audit` |
|---|---|---|
| Question | What are this repository's values, and is it ready to run a skill? | Where does this repository stand against its [profile](../GLOSSARY.md), and what should it do next? |
| Reads | the repository, the plugin's installation on this machine | the repository, its host settings, its tracker, the last record |
| Writes | `.config/jig.yaml`, `.gitignore`, the host's project-level plugin enablement | `.config/jig-audit.yaml`, the sheet |
| Never | scores a criterion, recommends a practice, writes a gate | writes the configuration, asks a setup question |
| Ends with | a checked configuration and the next command (step 6 of the run) | a sheet of decisions |

The boundary rule: **init derives and writes the [consumer overlay](../GLOSSARY.md); the audit measures the repository and judges the overlay.** When the audit's configuration fit finds something init can fix (a missing field the repository implies, or a file written under a plugin older than the last release that added a field), its remedy is "run `/jig:init --refresh`", not a second copy of the fix. A value already present is a person's to change: init reports a present field whose derived value differs, or that the schema marks deprecated, and the audit's finding for it names the edit, not init. When init is done, it names the audit as the next step for a team choosing a profile, and `/jig:do-item` for a team that wants to run one item first.

## How it works

### One detector, shared

The detection lives in `plugin/shared/detect.ts` with its tests, and both
skills call it: the gate command (a gate script CI runs, a package script
with the lockfile's package manager, a make target, or a gate script CI does
not run), review bots from
recent pull-request reviews and comments, the repository the forge names,
stacked open pull requests, the issue-key prefix from pull-request titles,
branch names and commit subjects, the change-area catalog, the integration
branch, and the starter configuration drafted from them. Each fact comes back
with its evidence (`{field, value, evidence: [observation]}`, each
observation naming the path or command it was read from), the shape the
audit's report source already uses for its stack table. The audit keeps only
what it says about a fact: whether the configuration contradicts it, and the
finding that offers it. The changelog file, the label taxonomy and the title
convention are not derived yet; they join the detector with the skill
(step 2), each with its own rule for what is written. The title convention
is derived at run time ([what is derived, not declared](../plugin/CONFIGURATION.md#what-is-derived-not-declared)),
so the detector reports it as evidence and nothing writes it. The label
taxonomy is written only when it lives somewhere other than its default
path. A changelog file found is asked about, never written unasked: setting
`changelog.file` turns the changelog skill on, which is an adoption decision
and not a value the repository states. Moved, not
copied ([plugin/AGENTS.md](../plugin/AGENTS.md)): a detector that lives twice
drifts the day one skill learns a new lockfile.

### The run

1. **Preconditions.** The plugin is installed, and the session runs the
   installed version (the check behind the configuration fit's stale-session
   finding), Bun, Git and the host's command-line client are on the path,
   the working directory is inside a repository, and the checkout is not
   behind its integration branch (fetched first). Init writes on the current
   branch. A failed precondition is stated with the one command that fixes
   it, and init stops.
2. **Mode.** No `.config/jig.yaml`: a first setup. One present: refresh
   mode, which shows the fields it would add, adds them, and never removes
   or rewrites a field already present (§ Refresh after a plugin release).
3. **Derive.** Run the detector. Every derived value is written with its
   evidence as a comment beside it, and nothing equal to a default is
   written ([what is derived, not declared](../plugin/CONFIGURATION.md#what-is-derived-not-declared)
   stays derived at run time and is not written at all).
4. **Ask only what cannot be derived.** A question is allowed only for a
   field that has no derivation and no safe default, or whose value turns a
   skill on, in the order the skills need them: the tracker, when the
   history shows keys of the `ABC-123` shape and none is configured (the
   default is GitHub Issues); the tracker team key, for Linear, when none is
   configured and the detector derives none (it derives a team only from at
   least three keys, one team holding a strict majority of them); whether
   the AI reviewer, when one is found, reviews drafts (`drive.reviews_drafts` has no default); and whether a
   changelog file found should turn the changelog skill on. Stacking is not
   asked: it defaults to `none`. Each question shows the derived answer it
   could not confirm, where there is one, and a field filled from an answer
   counts as one init wrote: init checks the answer before writing it. Asked the way
   [plugin/AGENTS.md](../plugin/AGENTS.md) requires: the host's question tool
   where it exists, numbered plain text elsewhere, and with nobody to answer,
   stop and state the questions. The budget is five questions; a sixth is a
   design error and a field that should have a derivation.
5. **Write.** `.config/jig.yaml`, with a `# jig: <version>` line naming the
   installed plugin; `.context/` into `.gitignore` when the repository has
   no entry; and, from build step 4, the project-level enablement that gives
   everyone who clones the plugin (for Claude Code, `enabledPlugins` and the
   marketplace entry in `.claude/settings.json`). Codex has no
   repository-level plugin enablement: a plugin is enabled in each user's
   `~/.codex/config.toml`, or synced for a team by a workspace
   administrator. So init writes no Codex file, and its output says that
   each Codex user runs the plugin's two install commands, which it prints.
   Each file is shown before it is written in an interactive session.
6. **Check.** Run the audit's `config-fit.ts` on the result and sort its
   findings by the fields each is about (the `fields` a finding carries, from
   build step 2: every field it concerns, so a rule tying two fields
   together names both). A finding that names any field init derived or
   wrote is init's bug, and the run reports it as one: init's contract is
   that it leaves none of those, including a written value that contradicts
   a preserved one. A finding whose fields a person set, all of them
   preserved by init, is reported with those fields' lines and the fix, and
   init does not change them. A finding with no field is about the world
   outside the file (a required check the base branch does not have, a
   tracker that cannot be reached, a host that contradicts the repository)
   and is reported with its remedy, since no overlay can fix it.
7. **Hand on.** Print what was written, what was asked, and the next
   commands: commit the files on a branch and open a pull request,
   `/jig:audit` to choose a profile and see the gaps, or `/jig:do-item <key>`
   to run one item.

### Refresh after a plugin release

The field history refresh reads is the configuration schema's own
(`plugin/skills/audit/config-schema.yaml`): a field's entry carries
`since`, the plugin version that added it, except a field older than the
audit skill, which carries none. Such a field predates every version init
can have written, so refresh treats it as older than any `# jig:` line and
never lists it as new. A branch that adds a field
writes `since: next` on its schema entry, and the release step's existing
placeholder replacement writes the version there. `/jig:init --refresh`
compares the plugin version the file was written under (a comment line init
writes, `# jig: <version>`) with the installed one and lists the schema
entries whose `since` is newer, deriving the ones it can. A file without
that line (written by hand, or copied from the audit's starter) has no
version to compare, so refresh lists the fields the file lacks that the
detector can derive or that a skill requires, and derives the ones it can.
In both cases it adds fields and never changes one already present:
without init's own record of what it wrote, a present field is treated as
one a person set. It reports a present field whose derived value now
differs, or that the schema marks deprecated (with the schema's message),
and leaves the edit to a person. It then writes the installed version on
the `# jig:` line, so the next refresh lists only what is newer still. The
audit's configuration fit reports a file older than the plugin's last
field-adding release with the same remedy.

### What it touches elsewhere

- [adoption/brownfield.md](../adoption/brownfield.md) and
  [adoption/greenfield.md](../adoption/greenfield.md): the hygiene list
  before the first audit becomes "run `/jig:init`".
- The audit's configuration-fit findings gain a `remedy: init` marker, and
  the sheet shows the command.
- [plugin/README.md](../plugin/README.md): the install section ends with
  `/jig:init` in the repository; `tools/plugin/setup.ts` prints it as the
  next step.
- [docs/LIFECYCLE.md](../docs/LIFECYCLE.md): a row in the table of skills
  outside the loop: a repository adopts Jig, or updates its configuration
  after a plugin release.

## Configuration

Init reads every field and adds none of its own.

## Build order

1. **The shared detector.** `config-fit.ts`'s detection and draft move to
   `plugin/shared/detect.ts` with their tests; the audit's behaviour is
   unchanged and its tests prove it.
2. **The skill.** `plugin/skills/init/`: `SKILL.md`, `README.md`,
   `scripts/init.ts` (derive, ask, write, check, and refresh from the
   schema's `since` entries), the changelog file, label taxonomy and title
   convention added to the detector, an optional `fields` (the dotted paths)
   on the configuration fit's findings wherever a finding is about the
   configuration, listing every field it concerns, tests that run it from a
   plugin copy against fixture repositories with and without a
   configuration, the lifecycle-map row, the README table row. This step writes no host settings file.
3. **The pointers.** Adoption pages, setup's next step, the audit's remedy
   marker and the sheet's command, and the configuration fit's finding for
   a file written under a plugin older than the last field-adding release.
4. **Project-level enablement.** The host settings files, once the test
   fixture can show the plugin loading from them. The fixture tests assert
   the Claude Code settings written, and no Codex file, with the install
   commands in the output.

## Left out

- **Scoring and recommendations**: the audit's. Init never says a practice
  is missing.
- **Writing gates, hooks or CI**: `/jig:audit apply` and `do-item` do that
  under a person's decision.
- **Writing the instruction file**: the kickoff family
  ([the plan](plan.md), item 3) owns a new repository's `AGENTS.md`; init
  only reads it for the gate command.
- **An interview that asks everything.** Every question init asks is a
  derivation it does not have yet, and the budget is there to keep it so.

## Review

Reviewed on 2026-10-28 at commit `ffd15c2`, by a fresh-context agent
session acting as an adversary, after the first build step and before the
second.
