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
`mechanical` (a CI job, a required check or a review gate enforces it for
every change; for a criterion about a hook itself, the hook runs it). Two
scores sit off the ladder:

- `expected-absent`, which counts as met: the repository's shape rules the
  practice out for good (no deploy pipeline in a library). A practice that
  presupposes another module's practice the repository has not adopted yet
  scores what the repository does without it, never `expected-absent`: it
  can still come, and the gap is real. With no CI, a derived-file check
  nobody runs is `absent`, and one run by hand or by a local hook is
  `advisory`.
- `not-examined`, which meets no bar and is never a gap: the audit chose not
  to examine a criterion beyond the profile's target. Only
  `score.ts --draft --profile <id>` writes it, with the evidence
  `not examined: beyond the <profile name> target`; never score a criterion
  inside the target with it.

The shape is one of `library`, `application`, `service`, `monorepo`,
`documentation` or `infrastructure` (infrastructure as code for hosts, where
deploying is scripts and timers rather than a pipeline), or the repository's
own word where none fits. It is what makes `expected-absent` defensible.

The `requires` field is the *pass bar* and takes only `convention` or
`mechanical`: a criterion needing `mechanical` is **not** met by an `advisory`
observation (that is precisely a gate to promote). A repository attains a
maturity level when every criterion at that level *and below* is observed at
or above its `requires`. `requires: mechanical` criteria are what separate
Standard and Strict from documentation theater.

Cases that recur:

- **A check that runs only in a local git hook** scores `advisory` on a
  criterion that asks for the check to be enforced: anyone can skip it
  (`--no-verify`, a checkout where the hooks are not installed), so it does
  not run for everyone. It reaches `mechanical` when CI or a required check
  runs it too. A criterion about the hook itself (a pre-commit hook that
  re-stages what it fixed) is met by the hook.
- **A hook manager's configuration** shows a hook is configured, not that it
  is installed in every checkout: the hooks run only where the manager was
  installed (often by installing dependencies). Score the configuration, and
  say in the evidence when nothing installs it on its own.
- **A practice that covers part of its scope** scores the rung the whole
  reaches: the highest rung that holds for every part of the scope, which
  is the rung of the weakest part, however few parts fall short. The
  evidence says the coverage ("2 of 3 jobs declare a timeout"). There is no
  partial score: a criterion about every job is met when every job meets
  it. For example, for "every CI job declares a timeout", where two of
  three jobs set one in the workflow and the third sets none: with no
  written rule, the third job is `absent`, so the criterion is `absent`;
  when the contributing guide asks every job to set one, every job is
  covered at least by that rule, so it is `convention`; it is `mechanical`
  only once the third job sets one too.
- **A host plan that cannot require checks** (branch protection that the
  plan does not offer for a private repository): score what runs, usually
  `advisory`, say the host's limit in the evidence, and recommend a local
  pre-push hook as the honest ceiling on that plan, beside the plan change
  that would allow `mechanical`.

## Probes

A probe is a *necessary condition* the audit's `score.ts` tests against the
repository's tracked files: when it does not hold, the criterion cannot be met
at any rung, so the script scores it `absent` with its search as the evidence,
beginning `probe: ` (`probe: no tracked file matches AGENTS.md, …`). That mark
is how the audit sheet tells a probe's score from the agent's, so only the
script writes it.
When it holds, it proves only the precondition; the files it matched are
evidence the agent still weighs, and a probe never decides a pass. A probe's
`absent` stands unless the agent finds what the probe could not see, or the
shape rules the practice out for good, which makes it `expected-absent`; the
agent then writes its own evidence in place of the probe's.
Give a criterion a probe only when its statement names a fact a file search
can rule out: a fact that may live under any name, such as an instruction
file "or equivalent", gets none. A probe's list is closed, so make it cover
every form the fact takes; where the agent finds one it misses, the agent
scores the criterion and the list gains it.
Every form means every ecosystem's common names (each CI provider's
configuration file, each hook manager's), never the file names of one
repository. A fact whose syntax the probe reads for some providers only (a
cancelling concurrency group in GitHub-style workflows) is probed by an `any`
that also holds on the configuration file of every other provider, so it
decides only where it can read the syntax. A criterion that presupposes
another practice (CI, a hook manager, decision records) can take that
practice's search as its probe. A file too large to search leaves the probe
unchecked, never `absent`.

Where the other practice is what enforces the criterion rather than what it
is about (CI running a check that could also run by hand or in a local
hook), its absence rules out only the enforced rung. Write that search as a
rung's probe, `mechanical: <probe>`: when it does not hold, the criterion is
not scored but left open with the comment `# probe capped: <search>; at most
advisory` and the field `at_most: advisory`, and the agent scores what it
observes up to that rung: `record.ts fill`, `merge` and `check` refuse a
score above it. A
criterion about the other practice itself (CI runs the gates on every pull
request, a lint over the CI configuration) keeps a plain probe: without CI
there is nothing to observe. A rung's probe stands at the top of a
criterion's probe or as one of the conditions of its top-level `all`, beside
plain conditions that still rule every rung out (`all: [<decision records>,
mechanical: <CI>]`).

| Form | Holds when |
|------|------------|
| `files: [<glob>, …]` | a tracked file matches one of the globs |
| `grep: { files: [<glob>, …], pattern: <regex> }` | a tracked file matching the globs contains the pattern |
| `any: [<probe>, …]` | one of the probes holds |
| `all: [<probe>, …]` | every probe holds |
| `mechanical: <probe>`, `advisory: <probe>` | always: when the probe does not, the score is capped at the rung beneath |

Globs ignore letter case, and a glob without `/` matches at the repository
root only (`AGENTS.md`); write `**/GLOSSARY.md` to match anywhere. Test
fixtures, templates and vendored dependencies (`fixtures/`, `templates/`,
`testdata/`, `vendor/`, `node_modules/`) are never probed: an example of a
practice is not the practice. A YAML anchor shares one probe between criteria
of the same file; an anchor cannot reach across files, so the lists several
files carry (the CI providers, the hook managers) are copies of the one in
`M1-gates-enforcement-ladder.yaml`, and `__tests__/criteria-anchors.test.ts`
fails when a copy differs from it.

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
