# Skill-invocation fallback — a slash command says how to run it without one

An instruction that says "run `/release-notes`" works in a runtime that has
slash commands and has discovered that [skill](../../../../GLOSSARY.md).
Read by any other runtime, it names a command that does not exist there, and
the agent either guesses or skips the step. The fix is a
[portable fallback](../../../../GLOSSARY.md) beside the invocation: the
runtime's own skill directory, or the skill's `SKILL.md` read directly, as
[M0's invariant](../../README.md#invariant) asks.

This check finds every bare `/<skill>` for the skills it is given and fails
each one with no fallback for that skill within a window of lines around it.

## Files

| File | Role |
|------|------|
| `check-skill-invocation-fallback.ts` | `(--skill <name> \| --skills <dir>)... [--marker <regex>] [--window <lines>] [--exempt <file>]... [--banner <regex>] [--file-marker <text>] <path>...`: scans the files named and the Markdown under each directory named; prints `file:line` and the fix for each invocation with no marker within the window |
| `fixtures/` | Fixture skills, a document whose invocation names its fallback, one whose invocation does not, and a generated file that carries the exemption marker in its banner |

The script's header comment states what counts as an invocation and what it
leaves out. It exits 0 when every invocation names a fallback, 1 on a
finding, and 2 on a usage error, a path that does not exist, a directory
with no Markdown file, an `--exempt` entry that does not exist or is not
among the files checked, or no skill to check. Its self-test sits beside it.

## What it decides

- **An invocation** is `/<skill>` after the start of a line, a blank, a
  quote, a backtick, an emphasis or strikethrough delimiter (`*`, `_`, `~`),
  a table bar, or an opening parenthesis or bracket, and not continued by
  another name character. A path (`skills/<skill>/`, `/<skill>/SKILL.md`,
  `/<skill>.md`) is not one. Code is read like prose, since a command in an
  example is still an instruction; text inside an HTML comment is not read.
- **A plugin's skills are not checked.** A plugin-namespaced command
  (`/<plugin>:<skill>`) falls back to the installed skill's `SKILL.md`,
  which lies outside the repository this check scans; the plugin's own
  installation notes say where each runtime installs it.
- **A fallback names the skill it falls back to.** By default it is a
  link whose target, resolved from the file's directory, is
  `<skill>/SKILL.md` (a mention that is no link does not count), the
  discovery path `.agents/skills/<skill>`, or a link to an interop document
  (a link whose target holds `interop`), the one marker shared by every
  skill. A link is what a CommonMark renderer (Bun's `Bun.markdown`) shows
  as one: an inline link, or a reference link whose definition may stand
  anywhere in the file. An image, and link syntax inside code or an HTML
  comment, is not a link. `--marker` replaces the default with the repository's own, such as the
  path of the document that says how each runtime runs a skill; `{skill}` in
  it stands for the invoked skill's name. The default window is 10 lines on
  either side.
- **A linked directory is scanned.** A symbolic link to a directory, such
  as a skill mirror's one link per skill, is followed, and each real
  directory is read once.
- **A whole file is exempted only by three facts together**: it is named with
  `--exempt`, it opens with a generated-file banner, and the banner carries
  the file-level marker (`skill-invocation-fallback: exempt-file` by
  default). A marker alone would be an exemption a file grants itself, and
  the list alone would hide a hand-written file. A listed file that does not
  carry both is a finding, and its lines are still checked. There is no
  per-line exemption: a fallback is one link.

Try it with the pinned Bun runtime:

```sh
bun check-skill-invocation-fallback.ts --skills fixtures/skills fixtures/docs/with-fallback.md
bun check-skill-invocation-fallback.ts --skills fixtures/skills fixtures/docs
```

The second run fails on `without-fallback.md` and on `generated.md`, which
passes once named with `--exempt fixtures/docs/generated.md`.

## Wiring it

Name the skills a runtime scans by directory (`--skills .claude/skills`), so
a new skill is checked without a change to the command, and name the
instruction files and skill folders that invoke them. Run it from a pinned
Jig checkout, or vendor the folder with `lib/cli.ts`, `lib/files.ts`,
`lib/findings.ts` and `lib/markdown-links.ts`, keeping their paths relative to it. It uses only Bun's
built-ins, so it can run in the same step as the
[context-budget checks](../context-budget/README.md), before dependencies
are installed. The recipe is in
[mappings.md](../../mappings.md#runtime-specific-capabilities-and-their-fallbacks).
