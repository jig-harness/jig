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
| Select the work for a change | One resolver job reads the change-area catalog and writes job outputs; every other job reads them with `needs:`. Never `on.pull_request.paths` on a workflow whose checks are required: a workflow that does not run never reports | `rules: changes:` per job, with the patterns generated from the catalog rather than copied into each job |
| One required verdict | An aggregator job that `needs:` every selected job, runs on `if: ${{ !cancelled() }}`, fails when a selected job failed or was cancelled, and is the only required check. A skipped required job counts as passing, so the skips are judged here | "Pipelines must succeed" already judges the whole pipeline; a job left out by `rules:` is not run and not counted |
| Bound every job | `timeout-minutes:` on each job, about two to three times its slowest healthy run and at most 60 minutes ([M13](../M13-pipeline-economy/README.md#4-bound)) | `timeout:` on each job |
| Format → lint → types → build | Sequential steps in one job (one runner setup) | One job with sequential `script:` lines, or one stage per gate |
| Tests in parallel | Second job, own runner | Job in the same stage as the build job |
| Advisory (non-blocking) gate | `continue-on-error: true` on the job/step | `allow_failure: true` |
| Blocking merge (the authority) | Branch protection → required status checks | Merge-request setting "Pipelines must succeed" |
| Run summary | `$GITHUB_STEP_SUMMARY` | Job log / MR widget (no direct equivalent; a comment bot if needed) |
| Shadow job for a replacement tool | A job with `continue-on-error: true` that runs both tools on the same tree and writes the parity counts to `$GITHUB_STEP_SUMMARY`; not a required check | A job with `allow_failure: true` that writes the counts to its log or a report artifact |
| A skipped or cancelled job | The aggregator job (above) counts a selected job that was skipped or cancelled as not passed, and accepts a skip only for a job the resolver did not select | A job left out by `rules:` is not run and not counted: keep a job that must run free of `rules:` that can skip it |
| Commit-msg marker re-check | Step iterating `git rev-list` over PR commits (see template) | Same script; diff range `$CI_MERGE_REQUEST_DIFF_BASE_SHA..HEAD` |

## Cheapest first, every independent gate reports

The gate set runs its cheap stages before its slow ones and runs to the end:
a failing stage does not stop the stages that do not depend on it, and the
run closes with the list of what failed. The first half is the order the
stages are written in; each runner has a switch for the second.

| Runner | Keep going after a failure | Note |
|--------|----------------------------|------|
| A runner script of your own (Jig's `scripts/gates.ts`) | Collect each stage's status and decide at the end | Name each stage by the command that reruns it alone, so the closing list is a list of commands |
| make | `--keep-going` (`-k`) | A target that depends on a failed one is still left out |
| turbo | `--continue=dependencies-successful` | A task whose dependency failed is left out; every other task runs |
| lefthook | The default: every command of a hook runs and the hook fails at the end; `piped: true` stops at the first failure | Keep `piped` for a sequence whose later commands need the earlier ones' output |
| GitHub Actions | A step after a failed step runs only with `if: ${{ !cancelled() }}`; `strategy.fail-fast: false` keeps a matrix's other jobs running | Separate jobs are independent already; the aggregator job (above) judges them together |
| GitLab CI | The jobs of one stage run independently of each other; a job in a later stage runs after a failure only with `when: always` | `allow_failure` is for an advisory gate, not for keeping the run going |

## Actionable findings in CI

A finding names its rule, its place, its problem and its fix in the log on
every platform. In CI it is also written in the form the platform shows on the
changed lines; the gate detects the platform from its environment.

| | GitHub Actions | GitLab CI |
|---|---|---|
| Detect | `GITHUB_ACTIONS=true` | `GITLAB_CI=true` |
| Mechanism | A workflow command printed to standard output: `::error file=<path>,line=<n>,title=<rule>::<problem> Fix: <remedy>` (`::warning` for an advisory gate) | No log command: the job writes a Code Quality report, a JSON array of `{description, check_name, fingerprint, severity, location: {path, lines: {begin}}}`, and declares it as `artifacts: reports: codequality: <file>` |
| Escaping | In the message, `%` → `%25`, carriage return → `%0D`, line feed → `%0A`; in a property value also `:` → `%3A` and `,` → `%2C` | Ordinary JSON; `path` is relative to the repository with no leading `./`; `fingerprint` is stable for the same finding (a hash of rule, path and text) |
| Where it shows | The run's summary and the pull request's changed files | The merge request's Code Quality widget |
| "Could not check" | `::error title=<gate>: could not check::<reason>`, with exit 2 | The job fails with exit 2 and the reason in its log; a report entry needs a file to point at |

GitHub shows only a limited number of annotations per step and per job and
drops the rest, so the log, not the annotations, is the complete list of
findings: a gate always prints every finding there.

Jig's helper [`lib/findings.ts`](../../lib/findings.ts) formats findings and
writes the GitHub form; the [grep-gate reference](reference/grep-gate/)
uses it. A repository adopting the reference gate either runs it from a
pinned Jig checkout or vendors `lib/` with it (it imports `lib/cli.ts`,
`lib/files.ts` and `lib/findings.ts`); see
[Non-JavaScript repositories](#non-javascript-repositories). The GitLab report
is not written by the reference gate yet.

## Exceptions that prune themselves

| Exception form | Reason the gate checks | Stale when |
|---|---|---|
| Inline token (`todo-exempt: <reason>`) | Non-empty text after the token | The line no longer has what the rule flags (the TODO is gone, or already cites an issue) |
| Line-based allowlist (Jig's `scripts/glossary-allowlist.txt`) | Each group of entries opens with `#` lines giving its reason | No checked file uses the entry, or the rule already accepts it |
| Allow pattern (Jig's `!` lines in `scripts/tracker-key-patterns.txt`) | `#` lines above the pattern | It matches nothing on a line the rule flags |
| Structured list in the gate (`{ path, match, reason }`) | `reason` non-empty, checked when the list is read | No finding matches the entry in this run |

## Retries

A retry is classified before it is taken ([README, core piece 3](README.md#core-pieces)):
only an error the step has classified as transient is retried, anything
else aborts at once with the command's own message, and the classifier is
tested against messages recorded from the real tool. The reference wrapper
is [`reference/retry-classified/`](reference/retry-classified/).

| | GitHub Actions | GitLab CI |
|---|---|---|
| Step-level retry | None built in: the step runs the reference wrapper, or its own loop, around the command | `retry:` on the job, with `when:` naming the failure classes the runner itself tells apart (`runner_system_failure`, `stuck_or_timeout_failure`, `api_failure`); never `when: always`, which retries a permission error as readily as a dropped connection |
| What the classifier reads | The command's standard error and output, matched line by line against the pattern list, each pattern under its reason | The runner's failure class; a distinction the runner cannot make (a rate limit against a missing permission, both `script_failure`) still needs the wrapper inside the script |
| The classifier's test | A test that feeds `--classify` the messages kept in `fixtures/recorded/` and asserts the answer for each | The same, for the patterns the wrapper reads |
| What a retry must never hide | The original message and exit status: the last attempt's output is printed as the command wrote it, and an error outside the transient set ends the step on its first attempt | The same; `retry:` keeps each attempt's log |

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

Unused code and duplication are measured by tools that read the import graph
from entry points: fallow (Jig's, through `entry` in `.fallowrc.jsonc`) and
knip (`entry` in its configuration) for JavaScript and TypeScript. Both take a
list of entry points: list the files run by path (a script a hook, a workflow
or a skill runs) one by one, from where they are invoked, rather than a folder
pattern.

For source-file size, the portable `file-lines` counter counts excess physical
lines above a configured limit across source and tests, including untracked files Git does not ignore.
[Biome’s `noExcessiveLinesPerFile`](https://biomejs.dev/linter/rules/no-excessive-lines-per-file/js/)
can enforce an absolute limit, but its one diagnostic per oversized file
does not increase when that file grows further. Counting its diagnostics
would miss that growth. Fallow’s `health.maxUnitSize` limits function lines;
its `--max-file-size` option skips large files during discovery. Neither
substitutes for a file-size ratchet that measures excess lines.
Jig’s [wiring](../../tools/quality/ratchet.jsonc) uses a limit of 1,000 physical
lines for source and tests alike. Lowering the limit tightens the rule; raising
it is a loosening that requires a person to request the existing
`Ratchet-Loosen` acknowledgement.

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

## Release cooldown

The cooldown is one number stated in the policy and repeated by the updater
and by every installer, each in its own unit; the policy's exemptions are
exact names everywhere. The
[lockstep gate](reference/supply-chain-lockstep/README.md) reads every row
whose note does not say otherwise.

| Tool | The cooldown | The exemptions | Note |
|------|--------------|----------------|------|
| Renovate (`renovate.json5`) | `minimumReleaseAge: "3 days"`, with `internalChecksFilter: "strict"` set explicitly, so no branch and no green pull request exists before the age check passes | One package rule with `matchPackageNames: [<names>]`, `minimumReleaseAge: "0 days"` and no other selector: without the names it exempts everything its other selectors match, and another selector exempts only some updates of the names | `vulnerabilityAlerts` is the security path and may set `minimumReleaseAge: null` with `schedule: ["at any time"]`; a registry without release timestamps needs `minimumReleaseAgeBehaviour: "timestamp-optional"` on its rule, or its updates never clear |
| Dependabot (`.github/dependabot.yml`) | `cooldown: { default-days: 3 }` on each `updates` entry; `semver-major-days` (and minor, patch) for a longer wait per update type | `cooldown.exclude: [<names>]` | `cooldown.include` narrows the cooldown to the names it lists, which the gate refuses; security updates skip the cooldown |
| Bun (`bunfig.toml`) | `[install] minimumReleaseAge = 259200` (seconds) | `minimumReleaseAgeExcludes = [<names>]`, exact names only | Applies when `bun add` or `bun update` resolves a version; a frozen-lockfile install resolves nothing |
| pnpm (`pnpm-workspace.yaml`) | `minimumReleaseAge: 4320` (minutes) | `minimumReleaseAgeExclude: [<names>]` | Current pnpm reads only authentication and registry settings from `.npmrc`, so the workspace file is the one the gate requires; for a version that still reads `.npmrc`, the gate also checks `minimum-release-age=4320` and one `minimum-release-age-exclude[]=<name>` line per name there. No effect under `--frozen-lockfile`; a deliberate lockfile refresh passes `--config.minimum-release-age=0` for that one run |
| npm (`.npmrc`) | `min-release-age=3` (days); older releases have only `before=<date>`, a fixed date rather than a rolling age | `min-release-age-exclude[]=<name>` | Not read by the gate yet |
| yarn (`.yarnrc.yml`) | `npmMinimalAgeGate: 3d` | `npmPreapprovedPackages: [<names>]` | Not read by the gate yet |

## Install-script allowlist

| Installer | The allowlist | Every other package | Which packages want scripts |
|-----------|---------------|---------------------|-----------------------------|
| Bun (`package.json`) | `trustedDependencies: [<names>]`. A list that is set is the only list, an empty one included; omitted, Bun's built-in list of trusted packages applies (`bun pm default-trusted` prints it), so the gate requires the field even when the policy allows none | Scripts blocked at install | `bun pm untrusted` lists the blocked ones; `bun pm trust <name>` adds one to the list |
| pnpm (`pnpm-workspace.yaml`) | `onlyBuiltDependencies: [<names>]`; every other setting that grants builds (`dangerouslyAllowAllBuilds`, `neverBuiltDependencies`, `onlyBuiltDependenciesFile`, `allowBuilds`) can let packages outside it run scripts, and the gate refuses each, in `.npmrc` too | Scripts blocked at install | `pnpm approve-builds` lists them and adds the chosen ones |
| npm (`.npmrc`) | None: `ignore-scripts=true` blocks every dependency script, and each allowed package is built on purpose with `npm rebuild <name> --ignore-scripts=false` after the install, since `npm rebuild` honours the setting too | Blocked by the same setting | `npm query ":attr(scripts, [postinstall])"` and the other script names |
| yarn (`.yarnrc.yml`, `package.json`) | `enableScripts: false` in `.yarnrc.yml` blocks every build, and `dependenciesMeta: { <name>: { built: true } }` in `package.json` re-enables one | Scripts blocked at install | `yarn install` reports the packages it built |

The updater never auto-merges a package on the list:

| Updater | The rule |
|---------|----------|
| Renovate | One `packageRules` entry with `matchPackageNames: [<the allowlist>]`, `automerge: false` and `groupName: null` (its own pull request, not diluted in a weekly group), selecting by nothing else, so every update of those packages is covered, and last in the list, because a later rule overrides an earlier one |
| Dependabot | Dependabot has no auto-merge of its own; the workflow or branch rule that auto-merges its pull requests leaves the allowlist's packages out |

## Policy lockstep

One policy file ([`templates/supply-chain-policy.yaml`](templates/supply-chain-policy.yaml))
states the cooldown, its exemptions and the allowlist; the
[lockstep gate](reference/supply-chain-lockstep/README.md) holds each
installer's and updater's file to it. The gate judges which packages may run
scripts, so it runs before any install that could run one: before the
install step (it needs no installed dependency), or after an install with
scripts off.

| Installer | Install with scripts off |
|-----------|--------------------------|
| Bun | `bun install --frozen-lockfile --ignore-scripts` |
| pnpm | `pnpm install --frozen-lockfile --ignore-scripts` |
| npm | `npm ci --ignore-scripts` |
| yarn | `yarn install --immutable --mode=skip-build` |

## The updater checks itself

| Concern | Renovate | Dependabot |
|---------|----------|------------|
| Range-valued overrides (a security floor, a major cap) | A rule with `matchDepTypes: ["overrides", "pnpm.overrides", "pnpm-workspace.overrides"]`, `matchCurrentValue: "!/^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.+-]*)?$/"` and `enabled: false`: anything that is not an exact version is left alone, and a floor is raised by hand, with the advisory | Overrides are not updated; nothing to exclude |
| Custom extraction (a pin in source code, a workflow variable) | `customManagers` with `customType: "regex"`, `managerFilePatterns` and `matchStrings`; a repository check parses those patterns out of the configuration (never a copy of them) and re-applies each to the tree, failing unless exactly one file and one match come back, with the expected dependency name and a value of the expected shape | None: a pin it cannot read is not updated, so list such pins in a scheduled stale-pin check |

## Layered secret scanning

Each layer catches what the one before let through; the CI layer is the
blocking one. A hook that finds no scanner installed says so and passes,
since CI blocks.

| Layer | gitleaks (and its forks) | trufflehog | The forge |
|-------|--------------------------|------------|-----------|
| Pre-commit hook, over the staged changes | `gitleaks git --pre-commit --staged --redact --config <file>` as a hook-manager command | `trufflehog git file://. --since-commit HEAD --fail` | — |
| CI, over exactly the change's commits | `gitleaks git . --log-opts="<base>..<head>" --redact --exit-code 1`, from a full-history checkout; the range and its empty-range refusal are in [`templates/secret-scan.yml`](templates/secret-scan.yml) | `trufflehog git file://. --since-commit <base> --branch <head> --fail` | — |
| Push protection | — | — | GitHub: secret scanning with push protection, a repository or organization setting; GitLab: secret push protection |
| A known false positive | An inline `gitleaks:allow` comment, or an allowlist rule in the scanner's configuration, each with a reason beside it | `--exclude-paths <file>`, or a detector left out, with a reason | The forge's bypass, which asks for a reason and logs it |

## Agent-runtime hooks

A hook is one script, registered in each runtime's own file in the same
shape: an event, an optional matcher on the tool name, and a command the
runtime runs with a JSON payload on standard input. The two runtimes below
share the payload's and the output's field names, so one hook and one
`hooks.json` serve both.

| | Claude Code | Codex |
|---|---|---|
| A repository's hooks | `hooks` in `.claude/settings.json` | `.codex/hooks.json`, or `[hooks]` tables in `.codex/config.toml`; read only in a trusted project |
| A plugin's hooks | `hooks/hooks.json` at the plugin root, or a `hooks` field in the manifest; the command reaches the plugin's files through `${CLAUDE_PLUGIN_ROOT}` | `hooks/hooks.json` at the plugin root, or a `hooks` field in the manifest; `PLUGIN_ROOT`, and `CLAUDE_PLUGIN_ROOT` for the same path |
| Trust | A plugin's hooks run once the plugin is enabled | A hook runs only once its current definition is trusted (`/hooks`); a plugin's hooks are skipped until then, and an edited hook is trusted again |
| Events | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` (matcher `startup`, `resume`, `clear`, `compact`), `PreCompact`, `Stop`, `SubagentStop`, among others | `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`, `SubagentStart`, `SubagentStop`, `Interrupt` |
| The payload | JSON on standard input: `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `tool_name` and `tool_input` before a tool call; `agent_id` when the call is a subagent's | The same names; `transcript_path` names Codex's own transcript, whose records differ from Claude Code's |
| Clear | Exit 0 with nothing on standard output | Same |
| Clear, with context | Exit 0 and `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "…"}}` on standard output | Same |
| Deny | Exit 2 with the reason on standard error, or `permissionDecision: "deny"` with `permissionDecisionReason` | Same |
| Timeout | `timeout` in seconds per command, default 600; a hook that runs before every tool call sets a short one | Same default |

Two behaviours are validated under Claude Code only. A hook exit other
than 0 and 2 lets the action proceed, and the transcript shows a hook error
with the hook's standard error, which is how a could-not-check notice
reaches the agent. Hooks fire inside subagents too, with `agent_id` set.
Under Codex both are open ([README.md § Status](README.md#status)).

The hooks the practice has validated, each run before a tool call:

| Hook | What it does | Ships as |
|------|--------------|----------|
| Turn-budget guard | Counts the session's round-trips off the transcript since its last call and hands the agent a wrap-up instruction within a margin of the runtime's turn cap | The plugin's [`hooks/turn-budget-guard.ts`](../../plugin/hooks/turn-budget-guard.ts) |
| Shell-syntax guard (matcher: the shell tool) | Denies a command that is valid in one shell but a hard error in the shell the tool runs (an unquoted glob that matches nothing, a word starting with `=`, an unquoted variable holding a command and its arguments), each with a one-line correction; anything its lexer does not model passes | An example, written against the repository's own shell |
| Test-output filter (matcher: the shell tool) | Rewrites a bare test-runner command, and only one with no shell metacharacter, to a wrapper that prints a summary when the run passes and the whole output when it fails, keeping the run's exit code | An example |
| Refocus after compaction | Re-injects a session's intent after a compaction and on later prompts | Future: it waits on the comparison in [ROADMAP.md](../../ROADMAP.md#later) |

## Where each piece lands

| M1 piece | This module ships | You install it at |
|----------|-------------------|-------------------|
| Hook layer shape | `templates/lefthook.yml` | Repo root (or manager equivalent above) |
| Grep-gate framework | `reference/grep-gate/` | `scripts/check-<rule>.ts` + Bun tests + fixtures, wired into pre-push and CI |
| CI gate set | `templates/ci-pr-gates.yml` | `.github/workflows/` or `.gitlab-ci.yml` per the table above |
| Suppression registry | `templates/suppression-registry.md` | Your docs tree, one page, linked from the instruction file |
| Commit-msg marker | `reference/commit-msg-marker/` | `scripts/` + the manager's commit-msg hook + a CI re-check |
| Classified retry | `reference/retry-classified/` | Around a command a CI step or a hook retries, with the pattern list and its recorded messages beside the workflow |
| Ratchet gate | `reference/ratchet/` | A wiring file of counters and configuration files (Jig's: `tools/quality/ratchet.jsonc`), run by a package script in the gate set; CI checks out full history so the merge base exists |
| Supply-chain policy | `templates/supply-chain-policy.yaml` | One file every reader can see (Jig's: `.config/supply-chain-policy.yaml`), repeated by the updater and each installer per the tables above |
| Policy lockstep gate | `reference/supply-chain-lockstep/` | A wrapper script naming the policy and the repository's installer and updater files (Jig's: `scripts/check-supply-chain-lockstep.ts`), in the gate set and as a CI step before the install |
| Secret scan | `templates/secret-scan.yml` | `.github/workflows/`, with the scanner's configuration at the root; the hook layer in the hook manager, push protection in the forge's settings |
| Agent-runtime hook | The plugin's `hooks/turn-budget-guard.ts`, registered by its `hooks/hooks.json` | Installed with the plugin; a hook of the repository's own goes in the runtime's hook file per the table above, with its test beside it |
| Hook self-test runner | `templates/hook-self-tests.sh` | A CI step in the required set, naming the hooks directory |

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
