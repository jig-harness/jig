# Maturity criteria

One file per [module](https://github.com/docomply/jig/blob/main/modules/README.md),
`M<n>-<name>.yaml`, in one format, so the audit scores every module the same
way. Criteria are observable repository facts (a file exists, a CI job is
present, a hook is configured), never judgments of quality, and each is scored
on the enforcement ladder (see the
[glossary](https://github.com/docomply/jig/blob/main/GLOSSARY.md)):
`absent` → `convention` → `mechanical`.

```yaml
module: M1                        # module id
name: gates-enforcement-ladder    # module directory suffix
purpose: >-                       # one plain-language sentence: what the module solves
  Stated rules become checks, ordered from convention to hard gate.
criteria:
  - id: ci-runs-gates-on-pr       # stable slug, unique within the module
    level: lite                   # level where this first becomes required:
                                  #   lite | standard | strict
    requires: mechanical          # minimum score to pass: convention | mechanical
    statement: >-                 # the criterion as one plain-language sentence
      CI runs the gate set on every pull request and a failing run blocks
      the merge.
    observe:                      # what the auditor actually looks for
      - "CI workflow triggered on pull requests runs the gate set"
      - "the workflow's jobs are required checks"
    probe:                        # optional: a precondition a script can test
      files: [".github/workflows/*.yml", ".gitlab-ci.yml", "Jenkinsfile"]
    since: 0.16.0                 # optional: the plugin version that added it
```

## Scoring

Each criterion is *observed* on the enforcement ladder as `absent`,
`convention` (stated in prose or habit only), `advisory` (a check runs
mechanically but cannot block, such as a non-blocking CI step), or
`mechanical` (a hook, CI job, or review gate enforces it). Where the
repository's shape rules the practice out (no deploy pipeline in a library),
the score is `expected-absent`, which counts as met.

The `requires` field is the *pass bar* and takes only `convention` or
`mechanical`: a criterion needing `mechanical` is **not** met by an `advisory`
observation (that is precisely a gate to promote). A repository attains a
maturity level when every criterion at that level *and below* is observed at
or above its `requires`. `requires: mechanical` criteria are what separate
Standard and Strict from documentation theater.

## Probes

A probe is a *necessary condition* the audit's `score.ts` tests against the
repository's tracked files: when it does not hold, the criterion cannot be met
at any rung, so the script scores it `absent` with its search as the evidence,
beginning `probe: ` (`probe: no tracked file matches AGENTS.md, …`). That mark
is how the audit sheet tells a probe's score from the agent's, so only the
script writes it.
When it holds, it proves only the precondition; the files it matched are
evidence the agent still weighs. Give a criterion a probe only when its
statement names a fact a file search can rule out: a fact that may live under
any name, such as an instruction file "or equivalent", gets none. A probe's
list is closed, so make it cover every form the fact takes; where the agent
finds one it misses, the agent scores the criterion and the list gains it. A
file too large to search leaves the probe unchecked, never `absent`.

| Form | Holds when |
|------|------------|
| `files: [<glob>, …]` | a tracked file matches one of the globs |
| `grep: { files: [<glob>, …], pattern: <regex> }` | a tracked file matching the globs contains the pattern |
| `any: [<probe>, …]` | one of the probes holds |
| `all: [<probe>, …]` | every probe holds |

Globs ignore letter case, and a glob without `/` matches at the repository
root only (`AGENTS.md`); write `**/GLOSSARY.md` to match anywhere. Test
fixtures, templates and vendored dependencies (`fixtures/`, `templates/`,
`testdata/`, `vendor/`, `node_modules/`) are never probed: an example of a
practice is not the practice. A YAML anchor shares one probe between criteria
of the same file.

## `since`

A criterion added after the audit skill's first release carries
`since: <plugin version>`. A re-audit reports it as added by Jig since the
prior audit, not as a regression or a new gap the team missed. The pull
request that adds it writes `since: next`, since it cannot know the version
it will ship in; Jig's release step replaces `next` with that version.

## Changing a criterion

Each module's README links its file here. A criterion's `id` is its key in
every audit record (`M<n>/<id>`): renaming it makes earlier records report it
as removed and the new name as new, so rename only when the meaning changes.
`bun plugin/skills/audit/scripts/score.ts --check` checks the format and that
every module carries criteria.
