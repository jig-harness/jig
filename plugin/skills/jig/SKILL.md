---
name: jig
description: "Find your way around the Jig plugin in a repository that uses it: which /jig: skill fits a task and what comes next, where a setting or practice is documented, and how to report a Jig bug as a GitHub issue. Not for doing the work; it names the skill that does."
argument-hint: "[question | bug]"
allowed-tools: "Read Bash(bun *) Bash(claude plugin *) Bash(jig doctor*)"
---

# Jig

The Jig plugin's skills each say what they do, one at a time. This skill
says how they fit together, where the plugin's own reference is, and what
to do when Jig itself is wrong. Answer the question from the documents
named here, then hand the work to the skill that owns it; this skill does
none of the work itself.

`${CLAUDE_SKILL_DIR}` below stands for the absolute path of the directory
containing this `SKILL.md`. Claude Code fills it in. In any other harness,
replace it with that path yourself before reading a file or running a
command: a shell would expand the unset variable to an empty string.
`<plugin>` is the installed plugin's root, two directories up
(`${CLAUDE_SKILL_DIR}/../..`).

## Where the reference is

Read the copy that is installed, not the one on GitHub's `main`: it
describes the version that runs. What only Jig's repository holds (the
practice modules, the glossary, the changelog), read at the installed
version's tag, `https://github.com/jig-harness/jig/blob/v<version>/…`.

| The question                                                          | Where to read                                                                                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which skill fits this task, and what comes after it                   | `<plugin>/README.md`: the skills tables, grouped by stage, with a "Works with" column for what starts each skill and what it hands on                                  |
| How one skill works                                                   | `<plugin>/skills/<name>/SKILL.md`, and its `README.md` where it has one                                                                                                |
| Where a value comes from, its default, which skill reads it           | `<plugin>/CONFIGURATION.md`; the values are the user file `~/.jig/jig.yaml`, the repository's `.config/jig.yaml` and `JIG__<SECTION>__<FIELD>` variables, highest last |
| Which version is installed                                            | `jig doctor`, which reports the plugin in each tool and the channel it follows; or `version` in `<plugin>/.claude-plugin/plugin.json` (or `.codex-plugin/plugin.json`) |
| What a version changed                                                | `CHANGELOG.md` at the version's tag                                                                                                                                    |
| What a practice module says (M0, M7, …) or what a term means          | `modules/` and `GLOSSARY.md` at the version's tag                                                                                                                      |
| The `jig` command, and the machine tools (`jig gc`, `jig dispatch`)   | `<plugin>/README.md`: "The `jig` command" (install, upgrade, doctor, status), then the sections named after each tool                                                  |
| A skill missing, a configuration error, old behaviour after an update | `jig doctor`, which names the command that fixes each failure, then `<plugin>/README.md`, section "Troubleshooting"                                                    |
| Where a piece of work stands, and what waits on a person              | `/jig:operator`, which asks the line with `jig ask` and passes a person's command to it with `jig send`; `<plugin>/README.md`, "Asking a station where it stands"      |

## Which skill

The groups below are the README's, in its order; read its tables for what
each skill does and how it hands on. The delivery loop runs `file-issue`,
then `do-item` (or `work-batch`), which opens the pull request and arms
`drive-pr`; a person merges.

- **Find your way:** `jig`, this skill.
- **Deliver a change:** `file-issue`, `do-item`, `work-batch`, `drive-pr`,
  `resolve-review-comments`, `resolve-conflicts`, `fix-ci`, `operator`,
  which says where work stands and what waits on a person.
- **Review a change:** `change-areas`, `review`, `github-actions`.
- **Understand, decide and record:** `explain`, `decide`, `adr`, `red-team`,
  `design-brief-builder`.
- **Learn from the work:** `reflect`, `review-reflections`,
  `promote-memory`, `descar`.
- **Inspect and analyse:** `audit`, `code-stats`, `docs`, `changelog`,
  `programmatic-execution`.

A skill is run as `/jig:<name>` in Claude Code, or by name in Codex ("use
the jig:<name> skill"); reading its `SKILL.md` works in any tool.

## When Jig is wrong

### Is it Jig's

It is Jig's when a plugin skill, script, hook or `jig` command does what
its own `SKILL.md`, README or `CONFIGURATION.md` says it does not, or stops
with an error from inside the plugin copy, while the repository's
configuration is valid by `CONFIGURATION.md`. Otherwise it goes elsewhere:

| What it is                                                                             | Where it goes                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A configuration error (the message names the field and where it was set)               | Fix the configuration in the repository                                                                |
| The repository's own gate, test or code failing                                        | The repository's own tracker                                                                           |
| A tool the README's "Requirements" lists is missing                                    | Install it                                                                                             |
| A plugin copy that is out of date, a scheduled job that does not run                   | `jig doctor` suggests the fix, `jig upgrade` updates the plugin; a crash its receipts show is a bug    |
| A lesson about how the instructions, skills or gates fit this repository, not a defect | `/jig:reflect`, where the configuration has a `reflection` section                                     |
| A question, or an idea not yet a defect                                                | [Discussions](https://github.com/jig-harness/jig/discussions)                                          |
| A security vulnerability                                                               | A [private advisory](https://github.com/jig-harness/jig/security/advisories/new), never a public issue |

In Jig's own repository, file the bug with `/jig:file-issue` instead: it
applies Jig's label taxonomy.

### Report it

A Jig bug is an issue on `jig-harness/jig`, labelled `bug`, in the fields
of its bug form. The tracker is public, and filing is publishing: a person
confirms every report before it is filed.

1. **Reproduce it once** and keep the command, its exit code and its
   output. Write them to a file. Run `jig doctor` first where the `jig`
   command is on `PATH`, and treat its output as evidence, not a verdict:
   its fix is a suggestion, not a diagnosis. A failure is setup only once
   the cause is established (an out-of-date copy, a missing tool); a failed
   run whose receipts (`jig receipts`) show a crash, and any failure the
   suggested fix does not clear, belongs in the report.
2. **Look for it** among Jig's issues, open and closed:

   ```sh
   bun "${CLAUDE_SKILL_DIR}/scripts/report-bug.ts" search "<skill> <words of the symptom>"
   ```

   When an issue already describes it, say so and offer to add the new
   evidence as a comment; a comment is published too, so it waits for the
   person as well. When `gh` cannot search, the script prints the address
   to search by hand.

3. **Find the channel** the plugin was installed from: the `ref` of the
   `jig` entry that `claude plugin marketplace list --json` prints, or the
   `ref` under `[marketplaces.jig]` in Codex's `config.toml`. No ref means
   `main`; a version tag means `tag`; a local path means `local`.
4. **Draft it**, one line, each value in quotes:

   ```sh
   bun "${CLAUDE_SKILL_DIR}/scripts/report-bug.ts" draft --skill "<name>" --symptom "<what went wrong, one line>" --what "<file from step 1>" --expected "<what should have happened>" --channel "<stable, latest, tag, main or local>" --out "<draft file>"
   ```

   Add `--last-working "<version>"` when it worked before, and
   `--tool "<tool and version>"` outside Claude Code; inside it, the script
   reads the version itself, as it reads the plugin version and the
   operating system. The title is `<skill>: <symptom>`. The script replaces
   the repository's path, the home directory, the owner and name in its
   remote's address and its tracker team's issue keys with placeholders,
   lists what it replaced, and prints the draft.

5. **Read the draft as a stranger would.** Remove what the script cannot
   know: a product, customer or person's name, a private host, a token,
   data the output carried. Edit the `title` and `body` in the draft file;
   keep the command, the exit code and the output that shows the fault.
6. **Ask the person** to confirm, showing the title and the body: with
   `AskUserQuestion` in Claude Code where the session can use it, as a
   plain-text question anywhere else. With nobody there to answer (an
   unattended run), stop and leave the draft file's path in the run's
   output; never file it unattended. The draft's stored `url` predates your
   edits, so do not hand it on: step 7's `file` builds the address from the
   edited title and body.
7. **File it** once the person agrees:

   ```sh
   bun "${CLAUDE_SKILL_DIR}/scripts/report-bug.ts" file "<draft file>"
   ```

   It prints the new issue's address; report it. When `gh` is missing or
   its account cannot file there, the script prints the bug form's address
   with the fields filled in: give it to the person instead.

Then carry on with the work. A workaround goes in the repository, with the
issue's address beside it; never edit the plugin copy, which the next
update replaces.
