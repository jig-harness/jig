# Promotion gap report

Part of [M10 Environments & deploy](../../README.md).

Which work items have reached one environment but not the next, computed
from version-control ancestry between the environments' pointers. The answer
is never kept by hand in tracker fields: a field drifts the moment a
promotion is forgotten, while the commits between two pointers cannot.

## Why it exists

Every environment in the four-stage architecture is named by a pointer: the
`verified` pointer post-merge verification advances, the release branch a
promotion fast-forwards, the commit a deploy pinned. So "what is waiting to go
to production?" is the range `production..verified`, the commits `verified`
holds and `production` lacks, and the work items it holds are whatever those
commits name in their subjects and trailers. A
tracker status per environment ("Deployed to staging") answers the same
question only while every promotion remembers to move every item, which is
to say never for long. The report reads the range instead, on a schedule and
whenever a pointer moves, and its count is a metric
([M11](../../../M11-process-observability/README.md)'s registry template
carries it).

`report-promotion-gap.ts` reads the range and prints the items. Looking them
up in the tracker (titles, owners, risk labels) is a seam for whatever
consumes its output, so the script depends on no tracker.

## Usage

```bash
bun report-promotion-gap.ts --pattern '[A-Z]+-[0-9]+' --from production --to verified [--cwd <repo>]
bun report-promotion-gap.ts --pattern '#[0-9]+' --log gap.txt
```

- `--pattern` — the regular expression that matches a work-item key in a
  commit subject or trailer. A repository's key shape is its own, so there is
  no default. `--ignore-case` matches either case and reports keys in upper
  case.
- `--from` and `--to` — as git refs, the pointer of the later environment
  (the one changes are promoted into, `production` above) and of the earlier
  one (the one they are promoted from, `verified`), read in the current
  directory or `--cwd`. The gap is the commits in `<from>..<to>`: those
  `<to>` holds and `<from>` lacks. Git variables that point at another
  repository (`GIT_DIR`, `GIT_WORK_TREE` and the like, which a git hook
  exports) are dropped, so `--cwd` decides which repository is read.
- `--log` — instead of refs, a log collected earlier with
  `git log --format='%H %s%n%(trailers:only,unfold)' <from>..<to>` (`-` for
  standard input), so one job can collect and another report, and a test
  needs no repository. Each commit is a line of its full hash (SHA-1 or
  SHA-256), a space and its subject, then one line per trailer
  (`Token: value`), then a blank line. A commit listed twice is counted once.
- `--max-items <n>` — a bound: more work items than this in the gap exits 1.
  Without it the report only reports.
- `--json` — the report as JSON: `from` and `to` (ref and commit, or `null`
  for a collected log), `commits`, `items` (each key with its commits),
  `unkeyed` (the commits that name no item), `maxItems` and `over`.

The script imports `lib/cli.ts` from the Jig repository, so run it from a
pinned Jig checkout or vendor `lib/` beside it.

## The rule

The commits in the range are the changes the earlier environment (`<to>`)
holds and the later one (`<from>`) lacks, the ones waiting for the next
promotion; the keys the pattern finds in their subjects and trailers
are the gap, each key once, sorted with numbers in order (`SHOP-9` before
`SHOP-10`), each with the commits that name it. A commit that names no key is
listed too, because a change that reaches an environment without a work item
is itself worth seeing.

The gap is a range only while the environments sit on one line. When
`<from>` is not an ancestor of `<to>`, something reached the later
environment that never went through the earlier one (a fix pushed straight to
the release branch, a pointer moved by hand), and `<from>..<to>` would list a
range that hides it. The report refuses to decide; the module's
[divergence rule](../../README.md#the-watchdog-decides-by-cause) says how to
restore the line.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | The gap is reported, and within the bound when one was given | `GAP — <n> work item(s) across <m> commit(s) in <from>..<to>; <k> commit(s) name no item`, then one line per item and per unkeyed commit |
| 1 | More work items than `--max-items` | the same, headed `OVER` |
| 2 | Usage or input error | a message on standard error |

The script fails closed: no pattern, a pattern that is not a regular
expression or that can match an empty string (`[A-Z]*`, `\b`, a bare
lookahead), a ref that names no commit, a `<from>` that is not an ancestor of
`<to>`, a git call that fails, a collected log that is empty (what a failed
collection leaves behind), holds a line that is neither a commit line nor a
trailer, or lists one commit twice with different content, and a bad option
all exit 2. Two
resolved refs with nothing between them are a gap of nothing: exit 0.

## Feeding it

With the pointers fetched, the report runs straight off the refs:

```bash
git fetch origin production verified
bun report-promotion-gap.ts --pattern '[A-Z]+-[0-9]+' \
  --from origin/production --to origin/verified --json > gap.json
jq -r '.items[].key' gap.json   # the keys, for the tracker lookup of your choice
```

An environment whose pointer is not a branch (a deploy pinned by a commit
written into a manifest) gets its ref from wherever the pin lives: resolve the
pinned commit first and pass it as `--from`. Run the report on a schedule and
on every push to a pointer branch; the per-provider wiring is in
[mappings.md](../../mappings.md#environment-hygiene).

## What it leaves to the team

The report lists keys. What a key means (its title, its owner, whether it is
flagged as a promotion risk) comes from the tracker, through whatever client
the repository already has; the gap's count goes to the metrics registry as
the number of items waiting per environment pair. Whether a large gap pages
anyone is the team's bound to set, through `--max-items`.
