# Skill-authoring check — skills that load the way they were written to

A [skill](../../../../GLOSSARY.md) loads in three steps: its name and
description in every session, its `SKILL.md` when it is invoked, and each of
its [references](../../../../GLOSSARY.md) when `SKILL.md` sends the agent to
one. Each step depends on the one before. A negative trigger written only in
the body cannot stop a wrong pick, because the body is read after the pick. A
reference reached only through another reference is often read in part, or
not at all. Ids of old incidents fill every invocation's context, and
phrasing tied to a date goes stale. None of this breaks a test, so it goes
unnoticed until an agent acts on the gap.

This check counts what a script can see of the
[skill-authoring rules](../../README.md#skills), per rule and per file. It
reports structure, not whether the instructions are right; review judges
that. It is one self-contained file using only Bun's built-ins: copy it, or
run it from a pinned Jig checkout.

## The rules it counts

| Rule | Counts | In |
|------|--------|----|
| `reference-depth` | each reference `SKILL.md` does not name: not by a link, not by a skill-relative path (`${CLAUDE_SKILL_DIR}/references/…`, `<skill-dir>/references/…`, `references/…`) and not by a folder under `references/` holding it (naming the skill's own folder, or one above, names no reference). Cross-links between references `SKILL.md` names add no hop | references |
| `reference-toc` | a reference over 100 lines that does not open with a contents section: a heading named "Contents" (or "Table of contents"), preceded by at most the file's level-1 title, followed by a link outside fenced code to a heading in the same file | references |
| `issue-density` | each issue or pull-request id past 5 per 100 prose lines, blank lines included (by default a tracker key such as `ENG-123`, or `#123`; standard and record ids such as `SHA-256`, `UTF-8`, `RFC-9110` and `ADR-0007` are not counted) | `SKILL.md` and references |
| `time-sensitive` | each marker that goes stale with the calendar: "as of" a date, "at the time of writing", "recently added", "coming soon", a month and year, "nowadays". "As of v2.3" names a version and is not counted | `SKILL.md` and references |
| `negative-trigger` | a body with a "When not to use" or "Not this skill" heading under a description with no clause that opens as an exclusion: a scope ("not for", "not suitable for", "except when", "unless"), a prohibition on the skill itself ("do not use it for", "never use this skill"), or a redirect under a scope ("for X, use Y instead"). A clause starts the description, follows sentence punctuation, or follows a comma. Negative or contrastive wording inside a clause ("do not use deprecated APIs", ", rather than writing them by hand", "instead of") is not an exclusion; write one of the forms instead | `SKILL.md` |

A skill's files are `<skills-dir>/<skill>/SKILL.md` and every Markdown file
under its `references/`. Fenced code is not prose and is never counted; a
time-sensitive phrase inside an inline code span, delimited by one backtick
or several, is an example and is not counted. The time-sensitive patterns catch the common markers only, so a
sentence such as "today the only option is X" still needs a reviewer.

## Usage

```sh
bun check-skill-authoring.ts [--json] [--strict] [--ids <regex>] [--density N] <skills-dir>...
```

- With no option it lists each finding as `<file>:<line>: <rule>: <message>`
  and a total per rule, and exits 0: the counts are debt to bring down, not a
  failure.
- `--json` prints `{"counts": {"<rule>": {"<file>": n}}}` and nothing else,
  the shape [M1's ratchet](../../../M1-gates-enforcement-ladder/reference/ratchet/README.md)
  reads as a `json` counter.
- `--strict` exits 1 on any finding, with or without `--json`, for a
  repository that starts at zero and has no ratchet.
- `--ids` replaces the id pattern; `--density` the allowance per 100 prose
  lines.

Exit 2 means the check could not measure: no skill in a folder, a folder that
does not exist, unterminated or invalid frontmatter, a `SKILL.md` with no
description, an empty body, or a usage error. Under `RATCHET_HISTORICAL=1`,
which M1's ratchet sets when it measures the merge base, a skills folder
that does not exist yet, or holds no skill, measures as no findings: a
repository can add its first skills and this counter in one change.

Try it on the fixture, a skill that follows every rule:

```sh
bun check-skill-authoring.ts fixtures/skills
```

## Holding the counts so they only fall

Existing skills carry debt the day the check is turned on. Run it as a
counter of M1's ratchet, compared per file, so that no change adds to any
skill file's count for any rule while the existing debt falls as skills are
edited. The counts are taken from the merge base at run time, so there is no
baseline file to commit or to refresh. Jig's own wiring in
[`tools/quality/ratchet.jsonc`](../../../../tools/quality/ratchet.jsonc):

```jsonc
{
  "name": "skill-authoring",
  "format": "json",
  "per": "file",
  "command": ["bun", "<path>/check-skill-authoring.ts", "--json", "plugin/skills"]
}
```

List the script under the wiring's `support` too, so the base is measured
with the head's version of it; a later change to the script that finds less
in the base, or charges a finding to another file, is then caught as a
loosening. The script imports nothing from the repository, so copying it
alone is enough. Compared per file, a skill file
renamed or split while it carries debt counts as new findings: bring the
debt down as part of that change.

## Files

| File | Role |
|------|------|
| `check-skill-authoring.ts` | The check; its header comment states each rule and what it leaves out |
| `check-skill-authoring.test.ts` | Self-tests: each rule's counted and uncounted forms, the options, the output shapes and every exit-2 input |
| `fixtures/skills/` | A skill with a reference, a negative trigger in its description and its body, and no finding |
