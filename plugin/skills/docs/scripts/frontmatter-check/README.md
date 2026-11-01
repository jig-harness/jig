# Frontmatter checker

Validates each doc's YAML frontmatter against the schema
([M4's schema template](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/templates/frontmatter-schema.yaml)),
so the schema stays the single source of truth for the doc vocabulary and
nothing drifts into invented types or statuses. Native Bun + TypeScript keeps the same check available in local hooks and CI.

## What it checks

Per doc, in [`frontmatter-check.ts`](frontmatter-check.ts):

1. frontmatter present — opens with `---`, closes within the first 60 lines;
2. the frontmatter stays inside the [supported YAML subset](#supported-yaml-subset):
   each construct outside it is a violation with its line number;
3. every required field present (`null`, `~`, an empty or blank value count
   as absent);
4. `description` present for **new** docs (files listed in `$NEW_DOCS`) — the
   one field required on creation but grandfathered for existing docs;
5. enum membership for `type` / `status` / `lifecycle` / `owner`, with a "did
   you mean" hint pulled from the schema's `suggestions:` map — so a common
   wrong value (`completed` → `approved`) is corrected, not just rejected;
6. `last_updated` is a strict `YYYY-MM-DD` date that exists on the calendar
   (`2026-02-30` fails);
7. `tags` is a list, inline (`[a, b]`) or block (one `- tag` line per member),
   each tag in the canonical list, at most 8;
8. ADR-specific fields (`decision_date`, `supersedes`, `superseded_by`) when
   `type: adr` — the bridge to [M5](https://github.com/jig-harness/jig/blob/main/modules/M5-adr-practice/README.md); `~` is a
   value here (no superseded record), while a blank one is still missing;
9. the schema's [path-scoped rules](#path-scoped-rules) for the documents
   under their paths.

Whether `last_updated` moved with the body needs the diff, not the file: that
is the [stale `last_updated` gate](../stale-last-updated/).

The navigation index [`generate-index.ts`](../index/) writes is derived, not
authored, and carries no frontmatter, so the checker leaves it out: the file at
the index's path (`$OUT`, else `INDEX.md` in `$DOCS_DIR`, the same variables
the generator reads) whose first line is the generator's `AUTO-GENERATED`
marker, whether it is named or found in the tree. Anyone can write the marker,
so it exempts nothing at any other path; the generator's `--check` is what
holds the file at that path to the generated content. The orphan report it
writes beside the index has frontmatter and is checked like any document.

The script uses the shared [`../lib/docs.ts`](../lib/docs.ts) reader for
documents; keep the skill's folder layout as it ships and run the script with
Bun, by its absolute path, from the root of the repository it checks. The schema is
a maintainer's file, so it is parsed as full YAML with the js-yaml build the
plugin vendors in `shared/vendor/`: a copy of the gate keeps the plugin's
layout, and the checker exits 2 when the parser does not load. Every
section is read from what the parser returns, so any YAML spelling of it
counts (`required: [title]` as well as one `- title` line per member). A
schema that is not valid YAML, or a section of the wrong shape (a `required`
that is not a list of names, an enum without `values`), is reported as
`FAIL <schema> (the schema cannot be used as written)` with each problem, and
the run stops there with exit 2: no document is checked against a vocabulary
the schema failed to give, since each would only fail that vocabulary's checks
and bury the errors that say what to fix.

## Supported YAML subset

The checker does not use a YAML parser for documents: it reads an explicit
subset and rejects anything outside it with a message, rather than guessing at
a value. A misread value is worse than a rejected one, because the gate then
passes or fails the wrong document. Write frontmatter inside this subset:

**Read:**

- whitespace and line breaks as YAML defines them: whitespace is a space or a
  tab, so U+00A0 and the other Unicode spaces are content (`approved\u00A0#x`
  has no comment, and a trailing U+00A0 stays in the value), and a line ends
  at a line feed, a carriage return and line feed, or a carriage return on
  its own;
- `key: value` plain scalars, one per line, keys at column 0;
- a trailing comment: `#` opens one only outside quotes and at the start of
  the value or after a space, so `"a # b"` and `issue#4` keep their `#`. A
  quote opens a quoted scalar only as the value's first character (in an
  inline list, a member's), so the apostrophe in `the team's guide # note` is
  text and the comment still comes off;
- quoted scalars (`"…"` or `'…'`): the quotes come off and the content is
  never decoded, so do not rely on a YAML escape (`\t`, `''`) meaning anything
  but its literal text. A double-quoted value may still hold only the escapes
  YAML defines (`\q` or `\xZZ` is rejected);
- inline lists `[a, b]`, split on commas outside quotes, a trailing comma
  allowed;
- block sequences: `key:` then one `- item` line per member, indented under
  the key (at least one space) and all at the same indentation;
- block scalars whose header is exactly one of `|`, `>`, `|-`, `|+`, `>-`,
  `>+`, or those with an indentation digit before the sign (`|2`, `|2-`,
  `>2+`, …), read as YAML reads them: indentation past the block's own is
  kept, `|` keeps line breaks, `>` folds lines into spaces (an empty line is a
  break, a more-indented line keeps its own), and the sign sets the ending
  (none: one line break, `-`: none, `+`: every trailing one). A
  whitespace-only line keeps the spaces past the block's indentation, and a
  comment indented less than the content ends the block;
- `null`, `~` and an empty value, read as absent.

**Rejected, with the line number:** a character YAML does not allow anywhere
(a control character, U+0000 to U+001F or U+007F to U+009F, other than tab
and U+0085); a tab in indentation; anchors and aliases
(`&a`, `*a`); explicit tags (`!!str`); explicit keys (`? key`); quoted keys;
flow mappings (`{a: b}`); nested mappings; a plain value continued on the next
line; a plain value containing `: ` (quote it), or starting with a character
YAML reserves (`@`, `` ` ``, `%`, `]`, `}`, `,`) or with `- `; a plain inline-list
member containing `[`, `]`, `{` or `}`; duplicate keys (a YAML parser
keeps the last, a line reader the first, so neither is safe); an unterminated
quoted scalar; text after a closing quote; an empty
list member; block-sequence members at column 0 (YAML allows them, but they
must be indented here) or misaligned; a block scalar as a list member
(`- |`); and any other block scalar header.

The self-test of the reader, [`docs-reader.test.ts`](https://github.com/jig-harness/jig/blob/main/plugin/skills/docs/__tests__/docs-reader.test.ts), is the
exhaustive list: one fixture per construct above, with its message.

## Path-scoped rules

Some subtrees need rules the rest of the tree does not: a runbook directory
whose documents must name the service they operate, or an archive directory
that may only hold archived documents. `path_rules:` in the schema declares
them; a rule applies to a document whose repository-relative path starts with
one of its `paths` prefixes.

```yaml
path_rules:
  - id: archive-holds-archived-docs     # named in every violation
    paths: [docs/archive/]              # normalised, repository-relative prefixes
    message: a document moved under archive/ is archived
    required_fields: [archived_on]      # present, non-blank; a list needs a non-blank member
    allowed_values:                     # narrows a field's values here
      status: [archived]
    forbidden_body_patterns:            # never matched inside fenced code
      - id: no-todo
        pattern: "\\bTODO\\b"           # a JavaScript regular expression
        message: an archived document carries no TODO
```

- `allowed_values` only narrows: for a field with a repository-wide enum,
  every listed value must already be in that enum.
- Body patterns are matched line by line outside fenced code blocks (a fence
  opens with three or more backticks or tildes indented at most three spaces,
  and closes with the same character, at least as long), so a documented
  example of a forbidden pattern does not trip it.
- **Fail closed.** Every rule is checked for shape whether or not it matches a
  document: an unknown key, a value of the wrong type, an empty list, a prefix
  that is not normalised, a field the schema does not know, a value that would
  widen an enum, a pattern that does not compile, or a rule that restricts
  nothing fails the check with a message that the schema cannot be used as
  written. So does a prefix that matches no `*.md` file in the docs tree
  on disk (`DOCS_DIR`) or among the files named, even when the run names only
  a few files: a typo in a prefix never reads as a rule every document passes.
- The template's example rules are commented out: adapt their prefixes and
  fields to your tree, then uncomment them.

Paths are matched against the file's path relative to the working directory,
so run the checker from the repository root.

## Usage

`SCHEMA` names the schema file (default `docs/.frontmatter-schema.yaml`),
`DOCS_DIR` the tree to scan when no files are given (default `docs`), and
`NEW_DOCS` the files that also need `description`, one path per line (so a
name may contain spaces); an entry that names none of the files checked is a
violation, so a list in the wrong shape fails rather than skipping the check. Exit
codes: 0 all docs valid, 1 at least one violation, 2 the check could not run:
a missing or unreadable schema, a schema that cannot be used as written (a
path rule that cannot be evaluated included), or an unreadable file.

```sh
# explicit files (what hooks/CI pass)
bun exec "SCHEMA=docs/.frontmatter-schema.yaml bun frontmatter-check.ts docs/a.md docs/b.md"

# new docs also require `description`
bun exec "NEW_DOCS=docs/new.md bun frontmatter-check.ts docs/new.md"

# no args: scan the whole tree
bun exec "DOCS_DIR=docs bun frontmatter-check.ts"
```

Wire it into a pre-commit hook over staged `docs/**/*.md` for fast feedback and
into CI as the authority (compute `NEW_DOCS` from the PR's added files). See
[M4's mappings](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/mappings.md).

## Files

| File | Role |
|------|------|
| `frontmatter-check.ts` | the checker; reads enums/required/tags from the schema |
| `path-rules.ts` | reads and applies the schema's `path_rules:` |

The self-tests and their fixtures are in the skill's `__tests__/`, which a
plugin install leaves out; they live in Jig's repository:

| File in `__tests__/` | Role |
|------|------|
| `frontmatter-check.test.ts`, `path-rules.test.ts` | paired self-tests |
| `fixtures/frontmatter-check/schema.yaml` | a copy of the template schema for the self-test |
| `fixtures/frontmatter-check/rules-schema.yaml` | the template with its example path rules live |
| `fixtures/frontmatter-check/good/` | valid docs (architecture, ADR, no-description, block forms) — must pass |
| `fixtures/frontmatter-check/bad/` | bad enums/date/tags, ADR missing fields, no frontmatter, constructs outside the subset — must fail |
| `fixtures/frontmatter-check/docs/` | documents under the template's path-rule prefixes, conforming and not |
| `fixtures/frontmatter-check/rules-broken.yaml` | a schema whose path rules cannot be evaluated |

Run them with `bun test plugin/skills/docs/__tests__/frontmatter-check.test.ts plugin/skills/docs/__tests__/path-rules.test.ts` from a Jig checkout.
