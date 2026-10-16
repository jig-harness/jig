# Prose-facts checks — commit-nothing freshness (rung 2)

Prose sometimes states facts that a script could compute: `12 guides total`,
"see `tools/setup.md`". Hand-written, these copies [drift](../../../../GLOSSARY.md)
silently — the count goes stale when a file is added, the path rots when a
file moves — and readers (human or agent) then act on the stale copy.

The obvious fix — generate the fact into a committed include file — trades
one liability for another: every parallel branch that touches the inputs
regenerates the include, and every merge becomes a conflict on the generated
file. The better answer is **rung 2 of the drop > check > commit
ladder** (see the [module README](../../README.md)): a CI job re-derives the
fact *in memory*, compares it to what the prose claims, and fails on
mismatch. **Nothing generated is ever committed** — no cache at rest means
nothing to conflict on, and nothing to go stale.

## Which numbers may stay

The test for a number in prose is whether it **constrains** the content or
merely **describes** it:

- A number that constrains stays: a limit, a budget, a retry count, a
  threshold (`≤ 8000 chars`, `3 retries`, `at most 5 per batch`). Dropping
  it would change what the text means.
- A number that [tallies](../../../../GLOSSARY.md) an adjacent list
  (`the 6 passes`, `120 skills`, a count beside the list it counts) is a
  cache of that list written by hand. It is either **dropped**, letting the
  list speak, or **registered** as a fact and checked against its source by
  a commit-nothing check on every run.

The design rules:

- **Flag drift, not presence.** The exact checks never punish a dropped
  number: if the prose states no copy of a fact, there is nothing to check,
  and dropping it (rung 1) is the preferred outcome. The one carve-out is the
  presence lint below, which exists because a tally nobody registered has no
  source to compare with; it is advisory by construction, never a required
  check, and a finding is a prompt to drop, register or mark.
- **Be conservative in extraction.** Stated copies are matched by the
  phrasings the registry lists ("N guides total", "a total of N guides"), so
  incidental prose ("spawn 3 workers") never matches; path extraction skips
  URLs, placeholders, globs, and bare words. For an exact check a false
  negative is acceptable; a false positive is not — false positives are how
  teams learn to ignore a gate.
- **Code is never a claim, for the registry check and the lint.** A number
  in a code span or a fenced block is an illustration, and
  `check-registered-facts.ts` and `lint-derivable-counts.ts` skip it. The
  other two read code on purpose or by age: `check-referenced-paths.ts`
  skips fenced blocks but checks a path in a code span, and
  `check-stated-counts.ts` reads every line, code included.

## Files

| File | Role |
|------|------|
| `check-registered-facts.ts` | `[--root <dir>] <registry.yaml> <prose-file>...`: re-derives each fact the registry declares and fails when a stated copy, in any of the fact's phrasings, disagrees. A fact derives by `files` (globs over the repository's files, with an optional `exclude`) or by `command` (run in the root; its output is the count). A phrasing is literal text with one `N` for the number, standing alone or beside punctuation (`(N) guides`), matched whole-word, in any letter case and spacing, across a line break included; a number two phrasings of one fact both match is one copy. Each `files` glob must match a file present on disk: one that matches nothing is a wrong path, not an empty set. A `command` is one string, run with the deadline of `$JIG_COMMAND_TIMEOUT_SEC` (30 minutes unset) |
| `lint-derivable-counts.ts` | `[--nouns <file>] [--registry <facts.yaml>] <prose-file>...`: advisory; finds a cardinal (digits from 2, or the words two to twelve) before a plural noun a repository counts, with no check behind it. Exempt: a constraint in the candidate's own clause ("at most", "≤", "limit", "per", …), a label ("step 4", "tier 2"), an identifier (a version, a date, an issue key, `#44`, a percentage, "5+"), a list marker or numbered heading, code, a line carrying `<!-- measured -->` (a note may follow: `<!-- measured: ls skills \| wc -l -->`), and, with `--registry`, a stated copy of a registered fact. The built-in noun list is a neutral starter; `--nouns` replaces it with the repository's own, one per line |
| `check-stated-counts.ts` | `<prose-file> <source-dir> <noun>`: the one-fact form, with no registry: fails when a stated count ("N guides total", "available" or "listed") disagrees with the number of Markdown files under the directory, recursively, `index.md` excluded |
| `check-referenced-paths.ts` | `<prose-file>...`: fails when a Markdown link or code-span path in prose resolves to no file. Only references containing a `/` are checked; fenced code (backtick or tilde fences, indented up to three spaces) is skipped, and in code spans so are quoted text (escaped quotes included), words with a quote or a caret (shell fragments) and slash commands (`/review`); a link starting with `/` resolves from the repository root, other links from the prose file's directory, and a code-span path from either that directory or the working directory (a leading `/` included), where a bare folder name (`templates/`) also resolves when a folder of that name holds a repository file anywhere beneath it (the files git lists, so ignored local folders do not count; outside a git checkout, every file outside `.git` and `node_modules`) |
| `fixture/` | An instruction file, its guides directory and a registry (`facts.yaml`) every check passes against, plus one input per failure: `stated-drift.md`, `tallies.md`, `constraints.md`, `registered.md`, the malformed registries, `nouns.txt`, `empty.md` |

Every check exits 0 when it found nothing, 1 on a finding, and 2 when it
could not decide: a usage error, an unreadable input, a registry that does
not parse, a fact whose source cannot be derived. An empty prose file is
undecided (2) for the registry check and the lint;
`check-stated-counts.ts` reads it as stating no count and exits 0. Findings print as
`file:line: [rule] problem` and `fix: remedy` lines, and under GitHub Actions
also as annotations ([`lib/findings.ts`](../../../../lib/findings.ts)).

The scripts import helpers from the Jig repository's `lib/` (`cli.ts`,
`files.ts`, `findings.ts`), so run them from a pinned Jig checkout or vendor
`lib/` beside them, as the toolchain note in
[M1's mappings](../../../M1-gates-enforcement-ladder/mappings.md) describes.

## The registry

One file declares each fact once: its id, its source and the phrasings a
stated copy may take. It is the facts' [generated-file inventory](../../../../GLOSSARY.md):
a stated number with no entry is a tally to drop, and an entry nobody states
is harmless.

```yaml
facts:
  - id: guides
    files: "guides/**/*.md"        # count of repository files matching
    exclude: ["**/index.md"]       # optional, same form
    phrasings:
      - N guides total             # literal text; N stands for the number
      - a total of N guides
  - id: tools
    command: "ls tools | wc -l"    # a command that prints the count
    phrasings: ["N tools listed"]
```

List every phrasing the prose uses, singular and plural included: a copy in
a phrasing the registry does not list is invisible to the exact check (the
lint sees it as an unchecked tally). Keep the registry in a file of its own
beside the inventory of generated files: neither inventory form (a
standalone `generated-files.yaml` or the change-area catalog) admits another
top-level block, so the two are declared side by side, not in one
document.

## Try it

```sh
cd fixture
bun ../check-registered-facts.ts facts.yaml instructions.md          # exit 0
bun ../check-registered-facts.ts facts.yaml stated-drift.md          # exit 1, "7 guides total" against 3
bun ../check-registered-facts.ts facts-no-match.yaml instructions.md # exit 2, a glob that matches nothing
bun ../lint-derivable-counts.ts tallies.md                           # exit 1, four tallies
bun ../lint-derivable-counts.ts constraints.md                       # exit 0, nothing to drop
bun ../lint-derivable-counts.ts --registry facts.yaml registered.md  # exit 0, both copies are checked
bun ../check-stated-counts.ts instructions.md guides guides          # exit 0
bun ../check-referenced-paths.ts instructions.md                     # exit 0
```

The self-tests of the registry check and the lint sit beside them
(`check-registered-facts.test.ts`, `lint-derivable-counts.test.ts`); those
of the one-fact form and the path check are in Jig's
[`scripts/freshness.test.ts`](../../../../scripts/freshness.test.ts).

## CI wiring and the promotion path

Run the exact checks on every pull request. A proven adoption path is to
land them **advisory first** (job failure visible but non-blocking), watch
for false positives for a while, then promote to blocking by deleting one
line — no script change needed:

```yaml
- name: Registered facts (advisory)
  run: bun reference/prose-facts/check-registered-facts.ts <facts.yaml> <instruction-file>...
  continue-on-error: true   # delete this line to promote to blocking
- name: Unchecked tallies (advisory)
  run: bun reference/prose-facts/lint-derivable-counts.ts --registry <facts.yaml> <prose-file>...
  continue-on-error: true   # stays: the lint judges by shape
```

The lint keeps its `continue-on-error`: it judges by shape, and a shape is a
guess. Promoting it to blocking is unproven and stays out until a repository
has run it blocking without teaching its team to add `<!-- measured -->` by
reflex.

GitLab CI and hook-manager variants are in
[`../../mappings.md`](../../mappings.md). Run the checkers' self-tests (each
checker against a known-bad input, asserting exit 1) as a blocking step even
while the checks themselves are advisory, because a fail-open checker is worse
than no checker.
