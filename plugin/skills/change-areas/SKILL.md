---
name: change-areas
description: "Resolve a change against the repository's change-area catalog: which areas a diff touches, which checks, reviews, labels and post-deploy actions it owes; check the catalog's invariants; add or edit an area. Use before hand-writing a path glob that classifies files, when editing the catalog, or when asked what a change must run or who must review it."
argument-hint: "[impact | validate | author | consume]"
allowed-tools: "Read Bash(bun *) Bash(git *)"
---

# Change areas: what a change touches, and what it owes

A [change-area catalog](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
maps the repository's paths to named areas, and each area to what a change
there owes: the checks to run, the reviews to invoke, the tracker labels to
apply, the actions to take after a deploy. This skill resolves a change
against it and checks it. It is the runnable form of module
[M3](https://github.com/docomply/jig/blob/main/modules/M3-change-area-catalog/README.md).
The human's page is [README.md](README.md).

**The rule the catalog exists for:** a path's classification is stated
once, in the catalog, and everything else reads it. Before you write a glob
or a regular expression that decides whether a file is code, docs, a
migration or an API, ask the resolver instead (§ Consume).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository. The catalog is the
repository's `drive.change_areas_catalog`
([configuration](https://github.com/docomply/jig/blob/main/plugin/CONFIGURATION.md));
`--catalog <path>` names another. When neither is set the scripts exit 2 and
say so: ask the user where the catalog is, do not guess. A repository with
its own wrapper around these scripts (a composer, see the README) runs that
wrapper instead; use it when the repository's instructions name one.

## Impact: what does this change touch, and what must happen because of it?

Resolve the working tree's change against the base branch, untracked files
included (leaving them out under-reports a new file, often the one most in
need of a gate):

```bash
set -o pipefail
BASE=$(git merge-base origin/main HEAD) &&
  { git diff -z --no-renames --name-only "$BASE" &&
    git ls-files -z --others --exclude-standard; } |
  bun "${CLAUDE_SKILL_DIR}/scripts/resolve.ts" --files - -z
```

Use the repository's base branch for `origin/main`. An empty list means
nothing changed, and owes no checks: `pipefail` makes a git command that
fails fail the pipeline instead of handing the resolver an empty list, and
`-z` passes the paths separated by null bytes, so a name git would quote (non-ASCII,
a quote, a backslash) still matches its area's globs; a line-per-path list
that holds a quoted path is refused. Other entry points:
`--base <branch>` (a pull request's diff, `origin/<branch>...HEAD`), `--event
push` (every commit since the push event's `before`, or `--before <sha>`;
the last commit without one), `--event workflow_dispatch --since <ref>`
(every commit since `<ref>`). A flag that belongs to another event's diff is
refused. The JSON:

| Field | Meaning |
|---|---|
| `seedAreas` | Areas a changed file matches directly: what the change touched |
| `areas` | The seeds plus every area their `impliedBy` closure reaches: the consequences |
| `reviewSkills` | The review skills to invoke, each once (`review` says which area asked) |
| `postDeploy` | Actions after the deploy, by area |
| `linear` | Tracker labels and flags, from the seeds only |
| `validation` | The checks to run (§ Validate) |
| `generated` | The seed areas' generators: outputs, source, command, check |

Report the seed and affected areas, the review skills, the post-deploy
actions and the labels. Invoke every skill in `reviewSkills`. Copy
`postDeploy` into the pull request description under `## Post-Deploy
Actions`.

## Validate: what must run before commit and push?

The `validation` block of the same JSON. It derives from the seeds, never
the closure: a docs edit that implies a downstream service keeps the docs'
depth.

- Run every `validation.localChecks` command, in order, before committing.
- Run every `validation.verificationChecks` command to verify the
  committed tree: before pushing, and after a review fix.
- Treat the plan as a minimum. The repository's hooks and its required CI
  still run (`repositoryHooksRequired`, `githubCiRequired`).

A changed file that matches no area fails closed to the deepest profile. An
expensive plan for a cheap-looking change usually means a coverage gap:
look for the file no area claims before suspecting the resolver.

## Author: add or edit an area

Read the catalog first, then the field reference in the
[README](README.md#the-catalog). An area:

```yaml
  api-service:                    # kebab-case id
    title: "API Service"
    category: service             # a grouping tag, never a build lane
    paths: ["apps/api-service/**"]
    workspace: ["apps/api-service"]  # must exist and be covered by paths
    impliedBy: [core-lib]         # areas whose change implies THIS one
    deployTier: primary
    validation: { profile: deep, ownTests: "npm test --workspace api-service" }
```

The rules that are wrong more often than not:

1. **`impliedBy` is one directed relation.** Listing B in A's `impliedBy`
   means "a change in B implies A". Never add the mirrored edge: that is a
   cycle, and `check.ts` refuses it.
2. **Never under-trigger.** When unsure whether one area depends on
   another, add the `impliedBy` edge: a redundant job is cheap, a skipped
   review is not. Overlapping `paths` are fine: a file may belong to several
   areas.
3. **A file matching no area fails closed to the deepest profile.** Adding
   coverage is how a change gets cheaper; leaving a path uncovered is safe
   but expensive.
4. **A generator belongs to the area that owns its output.** Its `generated`
   entry lists the `outputs` (literal paths, inside the area's own `paths`),
   the `source` paths or globs whose change calls for a regeneration (they
   seed the area even from another area), the `command` that regenerates and
   the `check` that fails when stale.
5. **Profiles are declared shallowest first** under `profiles:`, each with
   its checks; the last is the deepest and the default for an area without
   one, and lists at least one check (the catalog is refused otherwise). A
   shallower profile may list no checks: that is a deliberate "nothing to
   run" tier, and a change selecting only it gets a plan of just its areas'
   regeneration checks and own tests, possibly empty. A change that selects
   a profile `profiles:` does not define (or any change, in a catalog with no
   `profiles:`) gets no validation plan: the JSON exits 2 rather than plan
   nothing, unless the repository's composer supplies its own plan or the
   caller passes `--no-validation` because it reads only the routing
   (`reviewSkills`, `postDeploy`).
6. **No area is keyed `<other>-seed`** when `<other>` is an area too: the
   GitHub outputs would collide.

Then check the catalog, and fix every problem it prints:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/check.ts"
```

Exit 0 is valid, 1 a problem (each printed), 2 a catalog that cannot be
read, or a repository whose files cannot be listed.
It checks the schema (an unknown field is an error, so a typo cannot pass
silently), the `impliedBy` graph, the GitHub output names, each workspace
(a directory, every file in it matched by its own area's paths), and each
generator's outputs and sources against the repository's files.

## Consume: wire a job, a hook or a skill to the catalog

Read the resolver's output instead of restating its globs:

- In CI, `--format gha` appends `<area>=true|false` (the closure) and
  `<area>-seed=true|false` (the direct match) to `$GITHUB_OUTPUT`; a job
  gates on the area's name. `--format json --output-gha` writes both from one
  git run. The per-area outputs say nothing about a changed file that
  matches no area, which should select every job: a repository adds that
  signal through its composer's `ghaOutputs` (a `code=` line from
  `hasUnmatchedFile`, as Jig's own script writes one), or keeps every file
  covered with a coverage check (`uncoveredFiles`).
- For a workflow `paths:` filter, which runs before any script can,
  `--format dorny` prints each area's globs with those of every area that
  implies it: the filter matches exactly when the resolver would.
- `--area-paths <area>` prints one area's `paths`, one per line (not its
  generators' sources).

Reference an existing area by name; add the missing area to the catalog
when none fits. Hand-write a path list only when nothing can run the
resolver first, and say why beside it.

## Fail closed

A resolution that cannot be made (a git command that fails, a missing base
or since ref, a CI event with no diff here, a git command past its
deadline) exits non-zero, never an empty change. An invalid catalog, in its
schema, its `impliedBy` graph or its output names, is refused with every
problem named and exit 2, as is a validation plan its profiles cannot make. An empty `--files` list is the
one empty change: it means nothing changed, so never feed it the output of a
git command that failed. Report such an error to the user as it is;
do not work around it.
