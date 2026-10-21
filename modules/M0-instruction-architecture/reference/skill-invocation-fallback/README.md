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

- **The file is read as a renderer shows it.** It is rendered once with a
  CommonMark renderer (Bun's `Bun.markdown`), and invocations and links are
  both read from that render, so code, containers, reference definitions and
  escapes are what the renderer makes of them. The text is read as shown:
  inline formatting adds nothing to it, table cells are set off by blanks,
  raw HTML shows only the text between its tags (a tag that is neither
  inline formatting nor `<wbr>`, such as a block or a line break, is a blank),
  and an image only its description. The window is counted in the rendered lines. A finding
  names the invocation's line in the file: the file is rendered again with a
  mark where the invocation may stand, and the place whose mark shows at the
  invocation, the rest of the text unchanged, is its line, so text the render
  does not show never places it. An invocation no mark lands on is reported
  without a line, as is every one left once 100 renders have been spent on
  the file, so placing stays linear in the file's size.
- **An invocation** is `/<skill>` in the rendered text, after the start of a
  line, a blank, a quote, a delimiter the render kept as text, or an opening
  parenthesis or bracket, and not
  continued by another name character. A path (`skills/<skill>/`,
  `/<skill>/SKILL.md`, `/<skill>.md`) and a link's destination are not one.
  Code is read like prose, since a command in an example is still an
  instruction, and comment delimiters inside code are code; text inside an
  HTML comment is not read.
- **A plugin's skills are not checked.** A plugin-namespaced command
  (`/<plugin>:<skill>`) falls back to the installed skill's `SKILL.md`,
  which lies outside the repository this check scans; the plugin's own
  installation notes say where each runtime installs it.
- **A fallback names the skill it falls back to.** By default it is a
  link whose target, resolved from the file's directory, is
  `<skill>/SKILL.md` (a mention that is no link does not count), the
  discovery path `.agents/skills/<skill>`, or a link to an interop document
  (a link whose target holds `interop`), the one marker shared by every
  skill. A link is one the render holds, counted on the line where it is
  used: an inline link, or a reference link whose definition may stand
  anywhere in the file, inside a container or not. An image, a link inside
  an image's description, and link syntax inside code, an HTML comment or
  an HTML tag, is not a link. `--marker` replaces the
  default with the repository's own, such as the path of the document that
  says how each runtime runs a skill; it is tested on the window's rendered
  text, each link followed by its destination in angle brackets, and
  `{skill}` in it stands for the invoked skill's name. The default window is
  10 rendered lines on either side.
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
