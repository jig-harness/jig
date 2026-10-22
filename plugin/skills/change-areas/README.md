# `/jig:change-areas`: what a change touches, and what it owes

Which CI jobs must run for this change? Which reviews are mandatory, which
labels does the issue get, what has to happen after the deploy? Without one
answer to these, every consumer keeps its own list of paths: the CI
workflow has a regular expression, the review checklist a table, the
pre-commit hook a glob list, and each drifts from the others until a change
to a shared library skips the job that would have caught its break. The
[change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
is the one file that names the repository's areas and their paths; this
skill resolves a change against it and prints what the change owes, in the
form each consumer reads. It is the runnable form of module
[M3](https://github.com/jig-harness/jig/blob/main/modules/M3-change-area-catalog/README.md).

## Usage

Run from the repository root. The catalog is the repository's
`drive.change_areas_catalog`
([configuration](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md)),
or the file `--catalog <path>` names.

```bash
# The complete workspace change, including untracked files:
bun "<skill-dir>/scripts/resolve.ts" --worktree --base origin/main

# From git, for a CI event:
bun "<skill-dir>/scripts/resolve.ts" --base main                 # pull request: origin/main...HEAD
bun "<skill-dir>/scripts/resolve.ts" --event push --before <sha>  # every commit the push carried
bun "<skill-dir>/scripts/resolve.ts" --event workflow_dispatch --since origin/last-green

# Check the catalog:
bun "<skill-dir>/scripts/check.ts"
```

An empty list means nothing changed and owes no checks, so a hook must not
feed it the output of a git command that failed. Prefer `--worktree --base`
for workspace changes: it collects each Git result internally and stops on failure.
For saved file lists, `-z` reads the paths separated by null bytes, so a name git would
quote (non-ASCII, a quote, a backslash, a control character) keeps its
bytes and matches its area's globs. Without `-z` the list is one path per
line, kept as written apart from a `\r` line ending; a path git quoted is
refused rather than matched as its quoted form.

`--event` falls back to `$GITHUB_EVENT_NAME` and `--base` to
`$GITHUB_BASE_REF`, so a workflow step triggered by `push`, `pull_request`
or `workflow_dispatch` needs no flags. Any other event (a scheduled run, a
merge queue, `pull_request_target`) exits 2 until `--event`, `--base` or
`--files` says which diff to take. A push resolves every commit it carried,
from the `before` SHA of the event GitHub Actions is running
(`$GITHUB_EVENT_PATH`) or `--before`; without one (outside a workflow, or a
push that created its branch, whose `before` is all zeros) it resolves the
last commit alone. A push payload whose `before` is not a commit SHA, an
empty `--before`, or a ref shaped like an option exits 2 rather than
narrowing the diff. A flag
that belongs to another event's diff (`--base` with a push, `--before`
with a pull request, `--since` without `workflow_dispatch`) is refused
rather than ignored. Whatever the event,
when the commit is a merge, each parent's own files are added: a merge's
first-parent diff can show only documentation while the code arrived
through the other parent. A dispatched run diffs the whole gap since
`--since`, so a run that recovers from a dropped push event covers every
commit since the last verified one; there is no default for it.

| Option | Meaning |
|---|---|
| `--worktree` | Tracked and untracked workspace changes from the merge base; requires `--base <ref>` and refuses event or file-list options |
| `--files <path\|->` | The changed files instead of git; `-` reads standard input |
| `-z`, `--null` | `--files` is separated by null bytes, as Git prints its null-terminated changed-path list |
| `--base <ref>` | A pull request's base branch; implies `--event pull_request` |
| `--event <name>` | `push`, `pull_request` or `workflow_dispatch` (default: `$GITHUB_EVENT_NAME`, else `push`) |
| `--before <sha>` | With `push`: the commit the push moved from (default: the push event's `before`) |
| `--head <ref>` | The commit to resolve (default `HEAD`) |
| `--since <ref>` | With `workflow_dispatch`: the last verified commit |
| `--format <format>` | `json` (default), `gha`, `dorny`, `checklist`, `review-table` or `all` |
| `--output <path>` | Write to a file instead of standard output |
| `--output-gha [path]` | With `json`: also append the GitHub outputs (default `$GITHUB_OUTPUT`; with neither, exit 2) |
| `--no-validation` | With `json` or `all`: plan no validation (`validation: null`), for a catalog read only to classify a change or route its reviews |
| `--area-paths <area>` | Print one area's `paths`, one per line |
| `--catalog <path>` | The catalog file |

## Formats

- **`json`**: `changedFiles`, `seedAreas` (the [seed areas](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): the areas a file
  matches directly), `areas` (the seeds and every area their `impliedBy` closure
  reaches), `flags` (every area: affected or not), `postDeploy`, `review`,
  `reviewSkills`, `linear` (tracker labels and flags), `validation` and
  `generated`.
- **`gha`**: appended to `$GITHUB_OUTPUT` (or `--output`):
  `<area>=true|false` for the closure, then `<area>-seed=true|false` for
  the direct match. A job that stands in for its own path filter gates on
  the seed, or every area that implies it would trigger it too.
- **`dorny`**: a [dorny/paths-filter](https://github.com/dorny/paths-filter)
  spec, each area with the globs of every area that implies it, so a
  workflow `paths:` filter matches exactly when the resolver would. Static:
  it reads no changes.
- **`checklist`**: the affected areas' post-deploy actions as a Markdown
  checklist.
- **`review-table`**: the review gates as a Markdown table, one row per
  area with `review.skills`, its trigger paths the area's own globs and
  those of every area that implies it, as `dorny` lists them. Static.

**Seeds or closure** is decided per projection. The closure answers "what
are the consequences": `flags`, `postDeploy` and the review skills read it,
since a missed mandatory review is a defect and an extra one costs a run.
The seeds answer "what did this change touch": `validation`, `generated`
and the tracker labels read them, since a label is a lasting claim about
the change itself.

## The catalog

```yaml
vocabularies:            # optional: close the open fields
  category: [app, service, library, docs]
  deployTier: [primary, none]
profiles:                # optional: shallowest first; the last is the deepest
  shallow: { localChecks: ["npm run format"], verificationChecks: ["npm run format:check"] }
  deep:
    localChecks: ["npm run format", "npm test"]
    verificationChecks: ["npm run format:check", "npm test"]
areas:
  web-app:
    title: "Web App"
    category: app
    paths: ["apps/web-app/**"]
    workspace: ["apps/web-app"]
    impliedBy: [core-lib]
    deployTier: primary
```

Each area needs `title`, `category` (a grouping tag), `paths` (the globs
that define membership), `workspace` (owning directories, `[]` for none),
`impliedBy` (the areas whose change also implies this one, read in that
direction only) and `deployTier`. Optional blocks:

| Field | Shape | Read by |
|---|---|---|
| `notes` | text | people |
| `validation` | `{ profile?, ownTests?, notes? }` | the validation plan |
| `generated` | list of `{ outputs, source, command, check, notes? }`, M2's [inventory format](https://github.com/jig-harness/jig/blob/main/modules/M2-generated-artifact-freshness/README.md) | the validation plan, `generated` |
| `review` | `{ skills, notes? }` | `review`, `reviewSkills`, the review table |
| `postDeploy` | list of `{ action, when, envs, notes? }` | `postDeploy`, the checklist |
| `tracker` | `{ labels?, flags? }`; `linear` is its older spelling, not both | `linear` |
| `agent` | text | the agent routing of [do-item](../do-item/SKILL.md) |
| `labels` | list of text | drive-pr's reader |
| `ci`, `deploy`, `scaffolding`, `owner` | any | the repository's own tooling |

An unknown field is an error, so a misspelt one cannot mean nothing in
silence. `category`, `deployTier`, `agent`, tracker flags, post-deploy envs
and the profile names take any text unless `vocabularies:` closes them.

**The validation plan** unions the profiles the seed areas select (an area
without a profile takes the deepest), in declared order, and the deepest
whenever a changed file matches no area: a file no area claims is a
coverage gap, so it is validated fully. Each seed area's generator commands
run before the profile's local checks (a regenerated file is formatted and
tested in its fresh state) and its freshness checks after the verification
checks; its `validation.ownTests` runs in both. `generated` sources seed
their area even when they live under another area's paths, so an edit to a
generator's source runs the generator's check. A change that selects a
profile `profiles:` does not define, or any change in a catalog that
defines none, has no plan to make (and a catalog whose deepest profile, the
fail-closed fallback, lists no check is refused) unless `--no-validation` asks for none: `json` exits 2 rather than print a plan
with no checks. A catalog used only to classify changes reads the other
formats, or its composer supplies the plan.

`check.ts` also refuses an area keyed `<other>-seed` beside an area
`<other>`, whose GitHub outputs would share a name, and a workspace that is
not a directory or holds a file its own area's paths do not match.

## A composer

A repository whose catalog needs more than the generic mechanism (its own
fields, its own validation policy, extra GitHub outputs) writes a small
script that calls the library with its values, its
[composer](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):

```ts
import { runMain } from "<skill-dir>/../../shared/cli.ts";
import { runCli } from "<skill-dir>/scripts/lib/cli.ts";
import { defaultValidation, hasUnmatchedFile } from "<skill-dir>/scripts/lib/emit.ts";

runMain("change-areas", () =>
  runCli(process.argv.slice(2), {
    catalogPath: "tools/change-areas/catalog.yaml",
    fields: { area: { reviewRisk: ["high"] }, validation: { remote: "boolean" } },
    defaults: { since: "origin/last-green" },
    ghaOutputs: (ctx) => [`code=${hasUnmatchedFile(ctx.changedFiles, ctx.catalog) || ctx.resolved.has("api-service")}`],
    validation: (ctx) => ({ ...defaultValidation(ctx), localChecks: ["make precommit"] }),
    reviewTable: { comment: ["<!-- Generated: run make review-table -->"] },
  }),
);
```

- `fields` declares the extra area and `validation` fields, each
  `"boolean"`, `"string"`, `"string[]"` or a list of allowed values; their
  values stay on the parsed areas.
- `ghaOutputs` adds lines after the per-area outputs; `validation` replaces
  the default plan; `defaults.since` is the dispatched run's since-ref when
  `--since` is not given; `reviewTable` supplies the comment, preamble,
  footer and catalog name around the table.
- `lib/emit.ts` exports the plan's building blocks (`orderedUnion`,
  `shellQuote`, `hasUnmatchedFile`, `selectedProfiles`, `foldGenerated`,
  `foldOwnTests`, `defaultValidation`), and `lib/resolve.ts` the resolver
  (`seedGlobs`, `matchSeedAreas`, `applyImpliedClosure`, `resolveAreas`,
  `transitiveImpliedBy`, `changedFilesFromGit`), so a composer rebuilds its
  own policy in its own order.
- `runCheck(argv, { catalogPath, fields, checks })` in `lib/cli.ts` runs the
  check with the composer's fields and its own invariants;
  `lib/check.ts` exports `checkCatalog(catalog, { root, trackedFiles })` and
  `uncoveredFiles(files, catalog)` for a policy that every file belongs to an
  area.

Jig's own
[`scripts/change-areas.ts`](https://github.com/jig-harness/jig/blob/main/scripts/change-areas.ts)
builds on the library rather than calling `runCli`: it keeps its own command
line and outputs, and reads its catalog through the library's schema,
resolver and checks, with `reviewRisk` as its field.

## Exit codes

| Code | `resolve.ts` | `check.ts` |
|---|---|---|
| 0 | resolved | the catalog is valid |
| 1 | the resolution could not be made (a git command failed) | a problem, each printed |
| 2 | a usage error (an event with no diff here, or a flag for another event's diff, included), a catalog that is missing, unreadable or invalid in its schema, its `impliedBy` graph or its output names, or a validation plan its profiles cannot make | a usage error, a catalog that is missing or cannot be parsed, or a repository whose files cannot be listed |

A git failure never reads as an empty change, so a pre-push gate built on
the resolver [fails closed](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md);
an empty `--files` list is the one empty change, and means nothing changed.
