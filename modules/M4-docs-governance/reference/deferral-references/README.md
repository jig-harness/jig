# Deferral references

Part of [M4 Docs-as-wiki governance](../../README.md).

A document sometimes defers work: "the remaining risks are tracked to
closure", "a follow-up will be filed", "the migration is tracked separately".
Each such sentence is a promise that the work exists somewhere a person will
find it. A promise that names no item is wishful: nobody can look it up, and
nobody is accountable for it. A promise that names an item is only as good as
that item: when the item is closed, the document still reads as if the work
were pending, while the tracker says it is finished, abandoned or merged into
something else. Left alone, a document ends up carrying many such promises,
all pointing at items that closed long ago, and a reader trusting the
document believes in work that nobody is doing.

This is the same drift [M2](../../../M2-generated-artifact-freshness/README.md)
catches for generated files, applied to a reference: the document and the
tracker are two copies of one fact, and nothing makes them agree unless
something checks.

## The rule

> A deferral names an existing item, and the item it names is still open.

Two checks hold it, because they need different machinery:

| Half | Question | Needs | Runs |
| --- | --- | --- | --- |
| Static | Does every deferral name an item? | The documents only | Pre-commit hook and every pull request, on the lines the change adds; `--all` for a full sweep |
| Live | Is the item a deferral relies on still open? | The tracker, with a credential | On a schedule, on the default branch, never on code from a pull request |

The sentence "tracked under `ENG-42`" reads the same whether `ENG-42` is live
or closed last spring. Only the item's current state tells them apart, so the
static half cannot stand in for the live one, and the live one cannot run where
a pull request's code could read the credential.

## The static half

```bash
bun check-deferrals.ts --staged                          # pre-commit
bun check-deferrals.ts --range=origin/main...HEAD        # pull request
DIFF_RANGE=origin/main...HEAD bun check-deferrals.ts     # the same, from the environment
bun check-deferrals.ts --all                             # every document
```

Run it from inside the repository; it reads `.config/deferral-references.yaml`
unless `--config <file>` names another.

It reads each document as blocks of prose: a paragraph, a list item with its
continuation lines (and, in a loose list, its indented later paragraphs), a
table row, a heading. Frontmatter and fenced code are skipped. In each block:

1. If the block holds none of the **marker phrases**, it is not a deferral.
2. Otherwise the block must also hold an **item reference**: text one of the
   configured `items` patterns matches. If it does not, that is a finding.

The rule is stated as "a deferral names an item" and not as "a promise to file
an item is forbidden" on purpose. A promise can be worded without end ("we
will raise a ticket", "a new issue under the epic", "to be raised"), so
recognising unfiled promises by their wording is a list that stays one
counterexample behind. A reference has one shape per tracker, set once in the
configuration. The marker list only decides which blocks are looked at, and a
phrase it misses costs one unchecked block, never a false failure.

What a green run means: no block that carries a marker lacks an item. It does
not mean the item is the right one (a block that names an unrelated item beside
a deferral passes; review reads that), and it does not mean the block is
worded as a deferral at all, only that wording the list knows is covered.

### Which lines are judged

| Mode | Judged | Why |
| --- | --- | --- |
| `--staged` | The blocks that hold a line the staged change adds, or lie beside a deletion | A hook should fail on what this commit made, not on the backlog |
| `--range` / `DIFF_RANGE` | The same, for a pull request: the old side is the merge base for `A...B` and `A` for `A..B` or a single ref; the new side is the working tree | Same reasoning, and a pull request checkout is the merge commit |
| `--all` | Every block of every document in scope | Adoption sweep, and the input of the live half |

A change that edits a block brings the whole block under the check, so
deleting the line that carried the item, or rewording around it, is caught.
A renamed document is judged whole.

`--ci` with no range prints `SKIP` and exits 0: a check that compared nothing
says so. A range that is given but malformed (an unset base variable makes
`$BASE...HEAD` into `...HEAD`) is an error in every mode.

### Waiving a block

Some blocks say the words without making the promise: this very page, a style
guide on how to word a deferral. Put a comment in the block:

```markdown
Say "tracked to closure" only beside an item. <!-- deferral-ok: states the rule -->
```

The reason is required; a `deferral-ok` comment with none is a finding. A waived
block is set aside in both halves. Comments are stripped before a block is
read, so an item or a phrase hidden in a comment counts for nothing.

## The live half

The live half is three steps, so that the step holding a credential is a few
lines a person can read:

```bash
# 1. The items the documents' deferrals rely on. No credential.
bun check-deferrals.ts --all --list-keys > keys.txt

# 2. Their states, from the tracker. The only step with a credential.
<provider> < keys.txt > states.json

# 3. The verdict. No credential, no network.
bun check-deferrals.ts --all --states states.json
```

`--all` is required: the answer is about every document, not about a diff.

**The provider** is any command that reads item keys on standard input, one per
line, and prints a JSON object from each key to `open`, `closed` or
`not_found`:

```json
{ "ENG-12": "open", "ENG-40": "closed", "ENG-99": "not_found" }
```

`closed` is every finished state: done, cancelled, duplicate. `not_found` is
"the tracker has no such item", which is a different answer from "the tracker
could not be reached"; the second is the provider failing, not a state. The
[mappings](../../mappings.md#deferral-references) give one per tracker. Jig's
own tracker interface has one: `tracker.ts issue-states` in the
[`do-item` skill](../../../../plugin/skills/do-item/README.md).

**The decision** is made per deferral, not per citation. A deferral fails when
**none** of the items it names is open. A block that cites a closed item as
provenance beside an open one is correct ("tracked under `ENG-77`; origin
`ENG-12`, closed"), and failing it would teach people to stop citing origins.
Nor does the check look for words like "(closed)" next to a key: people write
that four ways, and a recogniser defeated by the fifth is worse than none. It
asks only whether any named item remains open.

When it fails, the fix is one of three, and the finding says so: the work was
done, so say that and drop the promise; the work was dropped, so say that;
otherwise point the promise at an item that is open. Re-opening the item to
silence the check is the one thing it cannot tell from keeping a promise.

### Fail closed

| Situation | Result |
| --- | --- |
| Every deferral still has an open item | Exit 0 |
| A deferral's items are all closed or missing | Exit 1, a finding per deferral |
| The provider failed, or answered for fewer items than were asked | Exit 2: nothing was verified |
| The states file is not JSON, holds a state other than the three, or lacks an item a deferral names | Exit 2 |

A check that cannot reach the tracker must not read as "all items are open".
The workflow that runs it must not translate exit 2 into success either:
treat 0 as clean, 1 as findings, and anything else as a failure of the run.

### Why it runs on a schedule, on the default branch

The tracker credential must never be available to code from a pull request:
anyone able to open one could otherwise read it. So the live half is not a pull
request check. It runs on a schedule, from the default branch's own copy of the
workflow and the documents; a manual run is limited to the default branch for
the same reason (a manual run executes the workflow and every file it checks
out as they exist on the branch chosen). That limit only stops a slip, because
the branch chosen supplies the workflow file and can delete it. What keeps the
credential from other branches is where it is stored: on GitHub, a secret of an
environment whose deployment branches are the default branch alone, not a
repository secret, which any workflow on any branch can read; on GitLab, a
protected variable. The credential is scoped to step 2 alone, so neither the
checkout action nor the verdict step sees it. The
[workflow template](../../templates/deferral-liveness.yml) is that shape.

A scheduled check can itself stop running without anyone noticing. Register it
in the repository's cadence list and heartbeat
([M11](../../../M11-process-observability/README.md)), so a stopped schedule
turns red.

## The configuration

```yaml
# .config/deferral-references.yaml
version: 1
include: ["docs/**/*.md", "*.md"]   # default: ["**/*.md"]
exclude: ["docs/archive/**"]        # default: []
items:                              # required
  - '\b[A-Z][A-Z0-9]{1,9}-\d+\b'
markers:                            # default: the list below
  - tracked to closure
  - a follow-up will be filed
```

- **`items`** is required and has no default: no pattern fits every tracker, and
  a loose one reads `ADR-12` or `CVE-2024-1` as an item. Use the tracker
  team's key (`\bENG-\d+\b`) or a link shape. If a pattern has a capture group,
  group 1 is the key (so the key is not the whole URL); without one, the whole
  match. A pattern that matches the empty string is refused.
- **`markers`** are plain phrases, matched without regard to case, across
  emphasis marks and line breaks, and only on word edges (`will be filed` does
  not match `will be filedx`). The defaults are neutral: `tracked to closure`,
  `tracked separately`, `will be tracked`, `to be tracked`, `will be filed`,
  `to be filed`, `follow-up will`, `follow-up to be`, `deferred to a future`.
  Past tense ("was filed") is deliberately absent: it says the item exists.
- **`include`** and **`exclude`** are globs from the repository root. Archived
  and generated documents belong in `exclude`.

A configuration the gate cannot read (unknown key, a pattern that does not
compile, no `items`) is exit 2, never a pass.

## Adopting it

1. Write the configuration; run `--all` and read the findings. They are the
   backlog of promises that name nothing.
2. Fix them: file the item and name it, or say what is true today. Waive a
   block that only discusses the wording.
3. Add `--staged` to the pre-commit hook and `--range` to the pull request
   check ([CI wiring](../../mappings.md#deferral-references)). Because both
   judge only the lines a change adds, the gate is blocking from the first day.
4. Add the live half on a schedule. A first run against a long-neglected tree
   may report many closed items: start it as a report that fails the run but
   blocks no merge, and fix the backlog before anything depends on it. It never
   blocks a pull request, because it never runs on one.

## What it does not do

- It does not judge that the item named is the right one, or that the work is
  moving. It checks that a named item exists and is open.
- A block that names an unrelated item beside a deferral passes the static
  half. The block is the unit, not the sentence: sentence boundaries cannot be
  recognised reliably in prose, and a rule that guessed them would fail
  correct blocks.
- A deferral worded in a way no marker covers is not looked at. Add the phrase
  to `markers`; the cost of the gap is one unchecked block.
- It reads tracked Markdown. A deferral in a spreadsheet, a slide or an issue
  body is outside it.
- It files nothing and closes nothing.

## Files

| File | Role |
| --- | --- |
| `check-deferrals.ts` | the gate: both halves, one reader |
| `check-deferrals.test.ts` | paired self-test: block boundaries (paragraph, list item, loose list, table row, heading, quote, fence, frontmatter), marker matching, item patterns and groups, waivers, the added-line reader, the live decision (all closed, one open, not found, unanswered, bad state file), the diff modes in throwaway repositories (staged, `A...B`, `A..B`, single ref, `DIFF_RANGE`, malformed ranges, `--ci`, a deletion that exposes a deferral, the staged blob against later edits), configuration and usage errors, and the entry point's exit codes |

The script imports the shared reader [`../docs.ts`](../docs.ts) and uses Bun's
built-in YAML reader; keep the helper in the parent directory when adopting,
and run with Bun. The configuration and the workflow are templates:
[`deferral-references.yaml`](../../templates/deferral-references.yaml) and
[`deferral-liveness.yml`](../../templates/deferral-liveness.yml).
