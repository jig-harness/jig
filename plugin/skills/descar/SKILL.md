---
name: descar
description: "Remove the historical layers (review traces, struck corrections, superseded statements) from a promoted docs page so it states only what is true now; use before promoting a document or to sweep a docs subtree."
argument-hint: "[path/to/doc.md | docs/subtree/] [--apply]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
---

# De-scarring a promoted document

Removes the archaeology from a document so its body is a live statement of what
is true now. [De-scarring](https://github.com/docomply/jig/blob/main/GLOSSARY.md) is the rule in Jig's
docs-governance module ([M4](https://github.com/docomply/jig/blob/main/modules/M4-docs-governance/README.md)):
an approved document carries no trace of the review or the edits that produced
it. M4 gives the rule and a lint for its mechanical part; this skill is the
operating procedure for the part a lint cannot do.

The rule itself, with the scar classes S1 to S4, the keep test, the table of
where removed content goes and the closure invariant for registers, is in
[`references/scar-classes.md`](references/scar-classes.md)
(`${CLAUDE_SKILL_DIR}/references/scar-classes.md`). Read it first. If the
repository's own wiki schema (often `docs/WIKI-SCHEMA.md`, from M4's
template) has a de-scarring section, read that too: where it is stricter or
more specific, it wins.

**Default is dry-run.** Without `--apply` the skill produces a classified
candidate list and a proposed diff, and stops. Never sweep a corpus in one pass
on first use: calibrate on one document with a human reading the diff, then
batch.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository whose documents you are
de-scarring. Never `cd` into the skill directory.

### Repository values

Find these once, at the start:

- **Docs root**: `docs/` unless the repository's wiki schema or instruction
  file names another. The commands below write `docs`; substitute.
- **Promoted status**: `approved` in M4's schema. The repository's
  frontmatter schema may name more (a corpus where `active` is the promoted
  status, say); use all of them.
- **Scar lint**: read `descar.lint_command` from
  `.config/jig.yaml`, a command that takes document paths as
  arguments. When it is absent, look for the lint the repository adopted from
  M4 (`git ls-files '*check-descarring-scars*'`) and run it with `bun` (or the
  interpreter its extension implies). When there is none, there is no lint:
  inventory S1 to S3 by hand as well as S4, and say so in the report.
- **Lint exemptions**: the paths the lint leaves out (M4's lint reads them
  from an `ALLOWLIST` environment variable, usually set in the CI workflow
  that runs it) and the `descar_allow: true` frontmatter opt-out.
- **Activity log**: the wiki's `log.md` (in the docs root in M4's layout), if
  the repository keeps one.

## Not this skill

- **False claims.** A sentence that contradicts the code is a finding, not a
  scar. A scar is true-but-superseded; a false claim is untrue now. You will
  meet both. File the second in the repository's issue tracker (the
  `issue_tracker.file_command` in the overlay, when set); do not quietly
  "fix" it into something plausible.
- **Drafts, with one exception.** Scars are legitimate while a document is
  under review, so a corpus sweep (a subtree, or no target) skips drafts.
  **Exception**: one explicitly targeted document, cleaned up before its
  `status:` is changed to the promoted status. That is this skill's main use:
  de-scar first, promote the status second.

## Phase 1 — Scope and freeze

1. Resolve the target: a path, a subtree, or nothing (then ask; do not guess a
   corpus).
2. **Leave out documents that other open pull requests change.** Editing a
   document another pull request is rewriting creates conflicts and review
   noise:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/open-pr-docs.ts" --docs-dir docs
   ```

   It prints the documents under the docs root that other open pull requests
   change, and fails closed: exit 2 means the census could not be taken
   (a `gh` failure or timeout, or a pull request with more changed files than
   `gh` returns), and the pass stops rather than scoping blind. An empty list
   means no other open pull request touches the docs. The script's header
   says how it tells the current pull request from the others.

   Everything in that list is out of scope for this pass. Say which files you
   left out and why: a silently narrowed pass reads as a completed one.
3. Confirm each remaining target is promoted, or, for an explicitly targeted
   single document, is a draft about to be promoted (the exception above; a
   corpus sweep still skips drafts), and is not exempted from the lint by path
   or by `descar_allow: true`.

## Phase 2 — Inventory

**Run the lint for the S1 to S3 shapes it detects, then inventory by hand the
S1, S2 and S3 shapes it does not detect. Do not write a second copy of the
lint's patterns**: a second recognizer drifts from the first, and the gate
stops meaning anything.

```bash
<lint command> docs/path/to/doc.md                    # one or more named documents
<lint command>                                        # M4's lint with no arguments: every promoted document
<lint command> $(git diff --name-only "<base>...HEAD" -- 'docs/*.md')   # what the branch changed
```

`<base>` is `repository.base_branch` from the overlay, or the repository's
default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).

A lint only partly covers S1, S2 and S3 (the "Detectable" column of the scar
classes). Read the lint to see which shapes it matches. M4's reference lint,
for example, matches strikethrough, and resolution phrasing or a reviewer
label only where it opens a list or quote item; it does not see a bare
*"addressed"* in ordinary prose, an unstruck *"Corrected \<date\>"*
paragraph, or a plain `- [x]`, *"N/A"*, *"Superseded"* or *"Covered by …"*
row. Read the document by hand for those shapes: the lint's silence on them is
not evidence they are absent.

**A lint that scans only promoted documents never scans a draft**, including
one you name explicitly. Check how the repository's lint reports such a file:
some print a distinct "not scanned" line, but M4's reference lint skips it
silently and still prints `OK`. For a draft under the pre-promotion exception,
treat the lint as absent and do a full manual S1 to S4 read before promoting
it.

**S4 has no lint and cannot have one.** Build a *reading list*, and treat it as
exactly that: not a verdict, and imprecise by construction:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/reading-list.ts" docs/path/to/doc.md
```

Then read the document end to end. S4 scars that no pattern catches (a
paragraph describing a superseded design in the present tense, a section that
was true two refactors ago) are found only by reading, and they are the ones
that mislead most.

## Phase 3 — Classify

For every candidate, assign exactly one verdict. Apply the **keep test**:
*would a reader who never saw the old state make a wrong decision without this
sentence?*

| Verdict | Meaning | Action |
|---------|---------|--------|
| `scar` | Process residue or a superseded layer | Remove from the body; route per the destination table |
| `keeper` | Guardrail, live drift, or dated commitment | **Keep**, but rewrite it in the present tense as a constraint, not a narrative |
| `relocate` | Carries rationale that must survive elsewhere | Move first, delete second, never the reverse |
| `structural` | The document itself is finished work, or is misfiled | Not a de-scarring case: fix `status` or `lifecycle`, or archive it, with `superseded_by:` only when a real successor document exists, never invented to fill the field |
| `false-claim` | Contradicts the code or configuration it describes | Out of scope: file it, do not rewrite it |

Record the verdict per candidate before editing anything. Deleting a guardrail
is the largest risk in this workflow, and it is unrecoverable in practice: git
keeps it, but nobody searches git for it.

The S3 class subjects every completed-work ledger (a plan or checklist as much
as a future-facing register such as a backlog or obligation calendar) to the
closure invariant: a done row also needs its closure anchor **opened and
confirmed** before the row goes, not merely a closed issue in isolation. Some
registers narrow a row instead of deleting it even when its issue is closed;
follow a register's own stricter rule wherever it has one. Fail closed: no
anchor, the row stays, and the missing anchor is itself the finding to report.

**A completeness register (a maintained statement of current coverage) is not
future-facing, and none of the above applies to it.** Its rows are live
assertions people rely on, not finished-task residue, so an S3 candidate there
is never deleted: a stale row is corrected in place or filed as a
`false-claim`. Recognise the kind from the register's own stated purpose
before applying S3 at all.

## Phase 4 — Rewrite

- One present-tense statement per fact. If two claims about the same thing
  survive the edit, the de-scar failed.
- Do not delete a hedge and leave the surrounding claim unqualified: that turns
  a scar into an overclaim, which is strictly worse than the scar.
- Keep every cross-reference that still resolves. Check every link you touched
  (Phase 6 says why).
- Set `last_updated` to today's date in Coordinated Universal Time. Do not touch `status` unless the verdict
  was `structural`.

## Phase 5 — Route

This phase routes `scar` and `relocate` candidates only; a `keeper` stays in
the body and is never routed. Use the destination table in
[`references/scar-classes.md`](references/scar-classes.md). Review dialogue,
correction traces and a closure-verified S3 row are deleted outright: the
first two because git history already holds them, the third because its
closure anchor already is the durable record. Everything else that is routed
moves: to an ADR's `## Amendments`, to `archive/` with `superseded_by:`, to a
`## Version history` line, to a companion review record, or to an issue.

**Honour Phase 1's freeze for every destination, not only the source
document.** If the destination (an ADR being amended, an archived
predecessor, a companion review record, or the activity log itself) is in the
excluded list, another pull request is rewriting it too. Do not write to it.
Defer that relocation and say so in Phase 7's report: what would have gone
there, and that it waits for the other pull request.

If the repository keeps an activity log, add **one line per document** at the
top, naming what changed and where the removed content went. One line: the
richer record is in git and the issue tracker, and the log gathers scars of
its own when passes write narratives into it. The log is a destination like
any other, so the freeze rule above applies to it too.

## Phase 6 — Validate

1. **Regenerate generated docs files first**, if the repository has them (a
   generated `INDEX.md` from M4's index generator, an orphan list): run the
   repository's command for it before staging. Such a generator writes files
   without staging them, so staging first would leave a real regeneration out
   of the commit.
2. **Stage only the paths this pass touched**, by name: the rewritten
   documents; the activity log only if this pass wrote to it (the freeze may
   have stopped it); any relocation destination; and the regenerated files if
   step 1 changed them. Never `git add -A`: a frontmatter hook that checks the
   staged diff would then check unrelated changes already in the working tree,
   and the commit would mix them in.
3. **Run the repository's frontmatter check**, if it has one (M4's
   frontmatter checker or the repository's own).
4. **Run the lint on the files this pass rewrote, named explicitly**: a run
   scoped to the branch diff compares committed history and misses an
   uncommitted rewrite. A draft is not scanned until its status changes (Phase
   2); rerun after promoting it.
5. **Run the validation the changed files need.** When the overlay sets
   `drive.validation_plan_command`, pass it the paths this pass touched on
   standard input, one per line. It does not validate anything itself: it
   prints the validation plan as JSON. Run every local and verification
   check the plan lists, and every skill on its review-skills list, and
   require each to pass. When it is not set, run `gates.command`. If neither
   is configured, run the checks the repository's instruction file names.

**Check whether the links you touched are covered by any gate.** Many link
checks cover instruction files or a fixed set of folders, not every document
under the docs root. A de-scar rewrites and deletes cross-references, so unless
the repository's link check demonstrably covers the files you touched,
resolve every link you touched by hand. Nothing downstream will catch a link
this pass breaks.

## Phase 7 — Report

State per document: what was removed, what was kept and why (name the keepers
explicitly: this is the part a reviewer must be able to check), where each
relocated fact went, what was deferred by the freeze, and what was left out of
the pass. A pass that reports only removals is not reviewable.

## Calibration

The first run on a new corpus is a dry run reviewed by a human, always. This
workflow is a round of prose edits, and prose edits are where defects get in:
a rewritten claim must be checked again against the code, configuration or
source of truth it describes, not merely against the prose it replaced.

**Which subtree to sweep and which document to calibrate on are different
questions, and they pull opposite ways.** Sweep order is set by yield (below).
The calibration document is chosen for the opposite property: the *least*
consequential document in that subtree, because a human reads its diff line by
line and the workflow's mistakes should land somewhere cheap. Do not calibrate
on the subtree's most valuable document just because it has the most scars.

## Corpus order

Work the corpus in **descending S4 density**, highest first. Derive it each
time rather than trusting an earlier ranking, because the ranking is a
measurement and the corpus moves:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/corpus-order.ts" --docs-dir docs \
  --allow <each path the lint exempts> --promoted <each promoted status>
```

It ranks every top-level folder of the docs root, plus `(root)` for the
documents directly in it, by reading-list hits per thousand lines. The
folders are read from the filesystem, so a new one is ranked without editing
anything. It leaves out `archive/` (superseded material, left out by path
because a moved document's `status:` is not reliably updated) and the raw
layers `retrospection/` and `scratch/`, which are capture, not compiled wiki;
add `--exclude-dir` for any other folder the repository's wiki schema marks as
raw. It counts drafts and promoted documents, and skips documents the lint
exempts (pass the same exemptions with `--allow`) or that carry
`descar_allow: true`. Folders of generated pages are not excluded by default:
pages maintained by hand there gather scars like any other prose.

The number has limits. It is built on the S4 reading list, whose precision is
poor by construction, so a subtree can rank low and still hold the worst
single document. A folder that prints no line at all has no countable document
(none at all, or none that is a draft or promoted and not exempted), which is
not the same as zero density.

**This order is deliberately the reverse of blast radius.** The most value is
where a mistake costs most, so the dry-run-first rule is not a formality
there: it is the safety mechanism, and a deleted guardrail in a security
document reads as a tidy-up in the diff. Phase 1's freeze reinforces it: the
security and policy documents are the ones most often being rewritten under an
open pull request.
