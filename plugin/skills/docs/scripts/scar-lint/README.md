# De-scarring lint

Enforces the [de-scarring rule](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/templates/WIKI-SCHEMA.md): an
**approved** doc is a clean statement of current truth, carrying no trace of the
review that produced it. This lint is the rule's mechanical half: a practice
that is only cultural erodes, so the rule is written down *and* given a gate.
The judgment half — scars a pattern cannot recognize — is the
[`/jig:descar`](../../../descar/SKILL.md) skill.

## What counts as a scar

Scanned only in `status: approved` docs (drafts are in flight — scars are fine
there):

- **Strikethrough** — `~~corrected text~~` showing what was changed;
- **Resolution phrasing** in a list/quote item — "addressed", "fixed as
  suggested", "done as suggested", "good catch", "as per review", "as
  requested", "resolved per review";
- **Reviewer dialogue / attribution** in a list/quote item — a reviewer or
  review bot named and followed by a colon (`Reviewer:`, `CodeRabbit:`,
  `Codex:`, `Copilot:`, `shadow reviewer:`).

Where the finding belongs instead: the review thread, the tracking issue,
git/PR history, or a light `## Version history` section recording *what
changed* — never reviewer names, an "addressed" ledger, or struck-through text.

## Why it's low-false-positive

- **Code is masked first** — fenced blocks and inline `` `code` `` spans are
  blanked before scanning, so a doc that *documents* scar syntax (like this
  one) isn't flagged.
- **Phrases are anchored to list/quote openings** — "addressed" only flags when
  it opens a bullet, so ordinary prose using the word in passing is safe.
- **Two opt-outs** — a path allowlist (`$ALLOWLIST`) for docs whose subject
  *is* the review process, and a `descar_allow: true` frontmatter key
  (frontmatter-only by design; an in-prose marker couldn't be distinguished
  from documentation of the marker).

The script uses the shared [`../lib/docs.ts`](../lib/docs.ts) reader; run it
from the skill's folder as it ships, with Bun.

## Usage

```sh
# explicit files (in CI, restrict to the branch diff so the approved corpus
# isn't swept every run)
bun exec "ALLOWLIST='docs/WIKI-SCHEMA.md docs/review/' bun check-descarring-scars.ts docs/a.md"

# no args: scan approved docs in the tree
bun exec "DOCS_DIR=docs bun check-descarring-scars.ts"
```

`ALLOWLIST` is a space-separated list; a file is skipped when its path
contains any entry (so `docs/review/` covers that directory). Exit codes: 0 no scars, 1 scars found, 2 an unreadable file.

## Named files that are not scanned

A file named on the command line that is not promoted (its `status` is not
`approved`) is not scanned, and the lint says so instead of reporting it
clean. "Not scanned" and "scanned, no scars" must read differently: a caller
checking a draft before promoting it would otherwise take `OK` as evidence.

| Named files | Output | Exit |
| --- | --- | --- |
| none promoted | `NOT SCANNED — N named file(s) were not scanned for scars …; this is not evidence they are clean`, then the files | 0 |
| some promoted, no scars | `OK — no scars in approved docs`, then `NOTE — N of the named file(s) were not scanned …` and the skipped files | 0 |
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
| `fixtures/scar-lint/` | clean, scarred, draft, documents-syntax, and descar_allow docs |
