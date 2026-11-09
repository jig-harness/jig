# De-scarring lint

Enforces the [de-scarring rule](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/templates/WIKI-SCHEMA.md): an
**approved** doc (or one with another status the repository promotes; see
[Which statuses are promoted](#which-statuses-are-promoted)) is a clean statement of current truth, carrying no trace of the
review that produced it. This lint is the rule's mechanical half: a practice
that is only cultural erodes, so the rule is written down *and* given a gate.
The judgment half — scars a pattern cannot recognize — is the
[`/jig:descar`](../../../descar/SKILL.md) skill.

## What counts as a scar

Scanned only in promoted docs (`status: approved` unless the repository lists
more; drafts are in flight — scars are fine there):

- **Strikethrough** — `~~corrected text~~` showing what was changed;
- **Resolution phrasing** in a list/quote item — "addressed", "fixed as
  suggested", "done as suggested", "good catch", "as per review", "as
  requested", "resolved per review";
- **Reviewer dialogue / attribution** in a list/quote item — a reviewer or
  review bot named and followed by a colon (`Reviewer:`, `CodeRabbit:`,
  `Codex:`, `Copilot:`, `shadow reviewer:`);
- **A reviewer attribution in a table's first cell** (`| Reviewer: … |`, any
  of the names above), or **opening a plain paragraph** (`Reviewer: …`, and
  `shadow reviewer:`). A bold or italic name (`**CodeRabbit**: …`) is a label
  that heads a tool comparison, not a trace; a reviewer named without the colon
  (a role in a table of who may approve) is not a scar either;
- **A review bot's account name** in the text: `coderabbitai[bot]`,
  `copilot[bot]`, `codex[bot]`, or a name containing `review` followed by
  `[bot]`.

Nothing in a document's frontmatter block counts under the last three shapes
(`reviewed_by: coderabbitai[bot]` is a field, not a trace).

Where the finding belongs instead: the review thread, the tracking issue,
git/PR history, or a light `## Version history` section recording *what
changed* — never reviewer names, an "addressed" ledger, or struck-through text.

## Which statuses are promoted

`approved`, unless the repository sets `docs.promoted_statuses` in
`.config/jig.yaml`
([configuration reference](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md#procedure-skills)):

```yaml
docs:
  promoted_statuses: [approved, active]
```

A repository with a second corpus whose lifecycle ends in another status lists
it, so that corpus is held to the same rule. The `PROMOTED_STATUSES`
environment variable (space-separated) does the same for one run and wins over
the configuration. A repository that sets neither scans `approved` alone, as
before.

## Why it's low-false-positive

- **Code is masked first** — fenced blocks and inline `` `code` `` spans are
  blanked before scanning, so a doc that *documents* scar syntax (like this
  one) isn't flagged.
- **Phrases are anchored to list/quote openings** — "addressed" only flags when
  it opens a bullet, so ordinary prose using the word in passing is safe.
  Reviewer names are anchored the same way: followed by a colon in a list or
  quote item, or plain at the start of a table row or a paragraph.
- **Two opt-outs** — a path allowlist (`$ALLOWLIST`) for docs whose subject
  *is* the review process, and a `descar_allow: true` frontmatter key
  (frontmatter-only by design; an in-prose marker couldn't be distinguished
  from documentation of the marker).

The script uses the shared [`../lib/docs.ts`](../lib/docs.ts) reader; keep the
skill's folder layout as it ships and run the script with Bun, by its absolute
path, from the root of the repository it checks.

## Usage

```sh
# explicit files (in CI, restrict to the branch diff so the approved corpus
# isn't swept every run)
bun exec "ALLOWLIST='docs/WIKI-SCHEMA.md docs/review/' bun check-descarring-scars.ts docs/a.md"

# no args: scan approved docs in the tree
bun exec "DOCS_DIR=docs bun check-descarring-scars.ts"
```

`ALLOWLIST` is a space-separated list; a file is skipped when its path
contains any entry. The match is on a fragment of the path, not the whole path,
on purpose: `docs/review/` covers every document of that folder, which is how a
repository exempts the pages whose subject is the review process, and a single
file is named by its path. Exit codes: 0 no scars, 1 scars found, 2 an unreadable file, a malformed `docs.promoted_statuses`, or a configuration that cannot be read.

## Named files that are not scanned

A file named on the command line that is not promoted (its `status` is not
one of the promoted statuses) is not scanned, and the lint says so instead of reporting it
clean. "Not scanned" and "scanned, no scars" must read differently: a caller
checking a draft before promoting it would otherwise take `OK` as evidence.

| Named files | Output | Exit |
| --- | --- | --- |
| none promoted | `NOT SCANNED — N named file(s) were not scanned for scars …; this is not evidence they are clean`, then the files | 0 |
| some promoted, no scars | `OK — no scars in approved docs` (the promoted statuses, joined with `or`), then `NOTE — N of the named file(s) were not scanned …` and the skipped files | 0 |
| scars found, some not promoted | the scar report, then the same `NOTE` | 1 |

A run over the whole tree (no files named) reports plain `OK`: drafts there
are out of scope by design, not something the caller asked about.

## Enforcement posture

Start **advisory** (`continue-on-error` in CI) while precision is proven on your
corpus, then promote to blocking once the false-positive rate is low and
existing scars are swept. Run the paired self-test
([`check-descarring-scars.test.ts`](https://github.com/jig-harness/jig/blob/main/plugin/skills/docs/__tests__/check-descarring-scars.test.ts),
from a pinned Jig checkout) as a **blocking** CI
step regardless — proving the gate still catches scars is what lets you trust an
advisory scan. The Strict criterion in [the maturity criteria](../../../audit/criteria/M4-docs-governance.yaml)
is the blocking version tied to promotion into `approved`.

## Files

The lint is `check-descarring-scars.ts`: code masking, then anchored scar
detection. Its self-test and fixtures are in the skill's `__tests__/`, which a
plugin install leaves out:

| File in `__tests__/` | Role |
|------|------|
| `check-descarring-scars.test.ts` | paired self-test, asserting the output as well as the exit code |
| `fixtures/scar-lint/` | clean, scarred, draft, documents-syntax and descar_allow docs, a promoted status other than `approved`, and the table-cell, paragraph and bot-handle attributions |
