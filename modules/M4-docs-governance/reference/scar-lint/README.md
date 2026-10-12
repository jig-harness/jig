# De-scarring lint

Enforces the [de-scarring rule](../../templates/WIKI-SCHEMA.md): an
**approved** doc is a clean statement of current truth, carrying no trace of the
review that produced it. This lint is the rule's mechanical half: a practice
that is only cultural erodes, so the rule is written down *and* given a gate.
The judgment half — scars a pattern cannot recognize — is the
[`/jig:descar`](../../../../plugin/skills/descar/SKILL.md) skill.

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

The script uses the shared [`../docs.ts`](../docs.ts) reader. When adopting
these files, keep that helper in the parent directory and run them with Bun.

## Usage

```sh
# explicit files (in CI, restrict to the branch diff so the approved corpus
# isn't swept every run)
ALLOWLIST="docs/WIKI-SCHEMA.md docs/review/" bun check-descarring-scars.ts docs/a.md

# no args: scan approved docs in the tree
DOCS_DIR=docs bun check-descarring-scars.ts
```

`ALLOWLIST` is a space-separated list; a file is skipped when its path
contains any entry (so `docs/review/` covers that directory). Exit codes: 0 no scars, 1 scars found, 2 an unreadable file.

## Enforcement posture

Start **advisory** (`continue-on-error` in CI) while precision is proven on your
corpus, then promote to blocking once the false-positive rate is low and
existing scars are swept. Run the paired self-test
([`check-descarring-scars.test.ts`](check-descarring-scars.test.ts)) as a **blocking** CI
step regardless — proving the gate still catches scars is what lets you trust an
advisory scan. The Strict criterion in [`../../maturity.yaml`](../../maturity.yaml)
is the blocking version tied to promotion into `approved`.

## Files

| File | Role |
|------|------|
| `check-descarring-scars.ts` | the lint; code-masking + anchored scar detection |
| `check-descarring-scars.test.ts` | paired self-test |
| `fixtures/` | clean, scarred, draft, documents-syntax, and descar_allow docs |
