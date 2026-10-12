# M1 per-ecosystem mappings

The module's pieces are tool-independent; this page maps each onto the common
hook managers and CI providers. Terms of art: see
[GLOSSARY.md](../../GLOSSARY.md) (*git hook*, *CI*, *grep gate*).

## Hook managers

All three managers can run the same Bun commands; they differ in where the
wiring lives and what conveniences exist. The reference scripts in this
module (`reference/grep-gate/`, `reference/commit-msg-marker/`) run with Bun and Git under any of them.

| M1 piece | lefthook (`lefthook.yml`) | husky (`.husky/*` shell files) | pre-commit framework (`.pre-commit-config.yaml`) |
|----------|---------------------------|--------------------------------|--------------------------------------------------|
| Pre-commit fix-and-stage | `pre-commit:` command with `stage_fixed: true`; `glob:` scopes it | `.husky/pre-commit` script; re-stage manually with `git add` after the fixer | Hook entry with `stages: [pre-commit]`; auto-fix hooks fail the run and leave fixes unstaged by design — re-run to commit |
| File-pattern scoping | `glob:` per command | Manual (`git diff --cached --name-only \| grep …`) | `files:`/`types:` regex per hook |
| Pre-push grep gates | `pre-push:` commands, one per rule, `parallel: false` for fail-fast ordering | `.husky/pre-push` calling each `bun scripts/check-*.ts` in order | Hook entries with `stages: [pre-push]`, `entry: bun scripts/check-<rule>.ts`, `pass_filenames: false` |
| Heavy build/test phase | Last `pre-push:` command | Last line of `.husky/pre-push` | `stages: [pre-push]` entry with `always_run: true` |
| Commit-msg marker | `commit-msg:` command; message file path is `{1}` | `.husky/commit-msg`; path is `$1` | Hook with `stages: [commit-msg]`; the framework passes the message file as the filename argument |
| Per-command timeout | `timeout:` per command | Not built in — wrap with `timeout(1)` or equivalent | Not built in — wrap in the script |
| Escape hatch | `git commit/push --no-verify` (all managers — it is a git feature, not a manager feature) | same | same, plus `SKIP=<hook-id>` to skip one hook by name |

## CI providers

| M1 piece | GitHub Actions (`templates/ci-pr-gates.yml`) | GitLab CI (`.gitlab-ci.yml`) |
|----------|----------------------------------------------|------------------------------|
| Run on every PR | `on: pull_request` | `workflow: rules:` with `$CI_PIPELINE_SOURCE == "merge_request_event"` |
| Concurrency-cancel superseded runs | `concurrency:` group keyed on PR number + `cancel-in-progress: true` | `interruptible: true` on jobs + "Auto-cancel redundant pipelines" (project setting, on by default) |
| Cheap grep gates + self-tests | Steps at the top of the first job, before toolchain install | An early `gates` stage of small `script:` jobs |
| Path filters / detect-changes | Inline `git diff --name-only` step writing a job output (portable), or the `paths` filter action | `rules: changes:` per job (native) |
| Format → lint → types → build | Sequential steps in one job (one runner setup) | One job with sequential `script:` lines, or one stage per gate |
| Tests in parallel | Second job, own runner | Job in the same stage as the build job |
| Advisory (non-blocking) gate | `continue-on-error: true` on the job/step | `allow_failure: true` |
| Blocking merge (the authority) | Branch protection → required status checks | Merge-request setting "Pipelines must succeed" |
| Run summary | `$GITHUB_STEP_SUMMARY` | Job log / MR widget (no direct equivalent; a comment bot if needed) |
| Commit-msg marker re-check | Step iterating `git rev-list` over PR commits (see template) | Same script; diff range `$CI_MERGE_REQUEST_DIFF_BASE_SHA..HEAD` |

## Custom lint rules and the ratchet

A project-specific rule (a pattern the repository has decided against) is
written in the linter's own extension mechanism where it has one, so it runs
with the linter's other rules and its severity decides whether the ratchet
holds it. The [ratchet gate](reference/ratchet/README.md) reads Biome's JSON
report, compiler output and plain-text patterns; a tool outside them is counted through a `grep` counter or a new
format added to the gate.

| Ecosystem | Custom rule mechanism | Ratchet counter |
|-----------|-----------------------|-----------------|
| Biome (Jig's own wiring) | GritQL plugins listed under `plugins` in `biome.json`, each with its own `includes` | `biome-json`: `biome lint --reporter=json`; a plugin's findings are named by the `<scope>/<name>:` prefix of its message |
| TypeScript compiler | Compiler flags in a separate project file (Jig's `tsconfig.ratchet.json`) | `tsc`: `--pretty false` output, or `bun check --no-pretty` |
| ESLint | A local plugin of custom rules | Not read directly: a `grep` counter, or a new format for `--format json` |
| Any language | Structural search rules (ast-grep, Semgrep) | Not read directly: a `grep` counter, or a new format for the tool's JSON output |
| Suppression comments | — | `grep`: one pattern per suppression marker |

## Immutable third-party automation and updates

Pinning and updating are one mechanism with two halves:

| Provider | Immutable reference | Maintenance path |
|----------|---------------------|------------------|
| GitHub Actions | `uses: owner/action@<full-commit-sha> # v<release>` | Configure Renovate's `github-actions` manager, Dependabot's `github-actions` ecosystem, or an equivalent updater to propose new commits through the normal PR gates |
| GitLab CI components/includes | Pin a component release or project include to the provider's immutable commit form; do not follow a default branch | Configure a dependency updater that understands the include syntax, or keep a machine-readable registry plus a scheduled stale-pin check |
| Containerized CI tools | Pin the image digest and retain the human-readable release in a comment or variable | Let the updater propose digest changes, then run the same gate/self-test contract before merge |

Keep compatibility restrictions next to the updater policy with a reason,
owner, review date, tested range, and removal condition. A permanently ignored
update or unexplained version ceiling is hidden maintenance debt.

## Where each piece lands

| M1 piece | This module ships | You install it at |
|----------|-------------------|-------------------|
| Hook layer shape | `templates/lefthook.yml` | Repo root (or manager equivalent above) |
| Grep-gate framework | `reference/grep-gate/` | `scripts/check-<rule>.ts` + Bun tests + fixtures, wired into pre-push and CI |
| CI gate set | `templates/ci-pr-gates.yml` | `.github/workflows/` or `.gitlab-ci.yml` per the table above |
| Suppression registry | `templates/suppression-registry.md` | Your docs tree, one page, linked from the instruction file |
| Commit-msg marker | `reference/commit-msg-marker/` | `scripts/` + the manager's commit-msg hook + a CI re-check |
| Ratchet gate | `reference/ratchet/` | A wiring file of counters and configuration files (Jig's: `tools/quality/ratchet.jsonc`), run by a package script in the gate set; CI checks out full history so the merge base exists |

## Non-JavaScript repositories

The invariant is that a gate has one reproducible implementation, independent
of the application's language. Jig chooses a mise-managed Bun pin: run the complete pinned checkout with its `mise.toml` active,
install `bun.lock` with `bun install --frozen-lockfile`, and invoke `bun <gate.ts>`.
The consumer's application can remain Python, Go or any other stack.

Standalone executables from `bun build --compile` are supported by Bun, but a
binary release matrix waits until distribution needs it. Source plus a
runtime pin keeps fixtures and dependencies together and avoids a second
packaging contract. Layout and adoption details:
[tools/README.md](../../tools/README.md).
