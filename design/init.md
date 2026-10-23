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
built, one command in a fresh clone leaves behind a committed, checked
configuration and says what to run next; the audit stays the measurement it
is.

This is the design of [plan.md](plan.md) item 26. Nothing of it is built. The
detection it rests on exists inside the audit's configuration-fit script
(`plugin/skills/audit/scripts/config-fit.ts`, with the draft in its `lib/draft.ts`),
which prints a starter configuration and never writes one.

## Where it ends and the audit begins

The two skills share one detector and divide the rest by what they write.

| | `/jig:init` | `/jig:audit` |
|---|---|---|
| Question | What are this repository's values, and is it ready to run a skill? | Where does this repository stand against its [profile](../GLOSSARY.md), and what should it do next? |
| Reads | the repository, the plugin's installation on this machine | the repository, its host settings, its tracker, the last record |
| Writes | `.config/jig.yaml`, `.gitignore`, the host's project-level plugin enablement | `.config/jig-audit.yaml`, the sheet |
| Never | scores a criterion, recommends a practice, writes a gate | writes the configuration, asks a setup question |
| Ends with | a configuration that passes the audit's configuration fit, and the next command | a sheet of decisions |

The boundary rule: **init derives and writes the [consumer overlay](../GLOSSARY.md); the audit measures the repository and judges the overlay.** When the audit's configuration fit finds something init can fix (a missing field the repository implies, a stale value after a plugin release), its remedy is "run `/jig:init --refresh`", not a second copy of the fix. When init is done, it names the audit as the next step for a team choosing a profile, and `/jig:do-item` for a team that wants to run one item first.

## How it works

### One detector, shared

The detection in `config-fit.ts` (gate command from the package scripts or
the instruction file, review bots from recent pull-request comments, the
issue-key prefix from branch names and commit subjects, the change-area
catalog, the changelog file, the label taxonomy, the integration branch, the
title convention) moves to `plugin/shared/detect.ts` with its tests, and
both skills call it. Each fact comes back with its evidence
(`{field, value, evidence: [path or command]}`), the shape the audit's
report source already uses for its stack table. Moved, not copied
([plugin/AGENTS.md](../plugin/AGENTS.md)): a detector that lives twice drifts
the day one skill learns a new lockfile.

### The run

1. **Preconditions.** The plugin is installed and current for the agent
   running it (`tools/plugin/setup.ts --check` in a checkout; the plugin's own
   manifest version in the cache), Bun, Git and the host's command-line
   client are on the path, the working directory is inside a repository, and
   the checkout is on its integration branch. A failed precondition is
   stated with the one command that fixes it, and init stops.
2. **Mode.** No `.config/jig.yaml`: a first setup. One present: refresh
   mode, which re-derives and shows a diff, adds what a newer plugin reads,
   and never removes or rewrites a field a person set.
3. **Derive.** Run the detector. Every derived value is written with its
   evidence as a comment beside it, and nothing equal to a default is
   written ([what is derived, not declared](../plugin/CONFIGURATION.md#what-is-derived-not-declared)
   stays derived at run time and is not written at all).
4. **Ask only what cannot be derived.** A question is allowed only for a
   field that has no derivation and no safe default, in the order the
   skills need them: the tracker team key when no issue key appears in the
   history, whether the reviewer reviews drafts when no reviewer is found,
   and whether pull requests may stack. Each question shows the derived
   answer it could not confirm, where there is one. Asked the way
   [plugin/AGENTS.md](../plugin/AGENTS.md) requires: the host's question tool
   where it exists, numbered plain text elsewhere, and with nobody to answer,
   stop and state the questions. The budget is five questions; a sixth is a
   design error and a field that should have a derivation.
5. **Write.** `.config/jig.yaml`; `.context/` into `.gitignore` when the
   repository has no entry; and the project-level enablement that gives
   everyone who clones the plugin (for Claude Code, `enabledPlugins` and the
   marketplace entry in `.claude/settings.json`; for Codex, whatever its
   project-level equivalent is at the time, and a line in the output when it
   has none). Each file is shown before it is written in an interactive
   session.
6. **Check.** Run the audit's `config-fit.ts` on the result and sort its
   findings three ways. A finding about a field init derived or wrote is
   init's bug, and the run reports it as one: init's contract is that it
   leaves none of those. A finding about a field a person set, which init
   preserves, is reported with that field's line and the fix, and init does
   not change the field. A finding about the world outside the file (a
   checkout behind its remote, a required check the base branch does not
   have, a tracker that cannot be reached, a host that contradicts the
   repository) is reported with its remedy, since no overlay can fix it.
7. **Hand on.** Print what was written, what was asked, and the next
   commands: commit the files, `/jig:audit` to choose a profile and see the
   gaps, or `/jig:do-item <key>` to run one item.

### Refresh after a plugin release

A change note that adds a configuration field names it `since: next`; the
release writes the version. `/jig:init --refresh` compares the plugin version
the file was written under (a comment line init writes, `# jig: <version>`)
with the installed one and lists the fields added since, deriving the ones it
can. The audit's configuration fit reports a file older than the plugin's
last field-adding release with the same remedy.

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
   `scripts/init.ts` (derive, ask, write, check), tests that run it from a
   plugin copy against fixture repositories with and without a configuration,
   the lifecycle-map row, the README table row.
3. **The pointers.** Adoption pages, setup's next step, the audit's remedy
   marker and the sheet's command.
4. **Project-level enablement.** The host settings files, once the test
   fixture can show the plugin loading from them.

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
