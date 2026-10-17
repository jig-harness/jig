---
release: minor
---

Jig's gate set runs cheapest first and to the end, M1 covers the supply chain of application dependencies and secrets, and the enforcement ladder gains the agent-runtime rung, with a plugin hook on it: the turn-budget guard.

### Added

- M1 core piece 7 states the practice for application dependencies and
  secrets: a [release cooldown](../GLOSSARY.md) held by the updater and by
  every package manager at install time, with exact-name exemptions; an
  [install-script allowlist](../GLOSSARY.md) whose packages the updater never
  auto-merges; one policy file every installer and the updater repeat, held
  in step by a lockstep gate that runs before any install could run a script
  ([`reference/supply-chain-lockstep/`](../modules/M1-gates-enforcement-ladder/reference/supply-chain-lockstep/README.md),
  with fixtures and a self-test); the updater's self-check; and layered
  secret scanning, where the CI layer scans exactly the change's commits
  and fails on an empty range. The templates
  [`supply-chain-policy.yaml`](../modules/M1-gates-enforcement-ladder/templates/supply-chain-policy.yaml)
  and [`secret-scan.yml`](../modules/M1-gates-enforcement-ladder/templates/secret-scan.yml)
  ship with it;
  [`mappings.md`](../modules/M1-gates-enforcement-ladder/mappings.md) maps
  each value onto Renovate, Dependabot, Bun, pnpm, npm and yarn, and the
  secret scanners per layer. The gate requires Bun's `trustedDependencies`
  even when empty and never `null` (omitted, Bun trusts its own built-in
  list), refuses every
  pnpm setting besides `onlyBuiltDependencies` that can grant a build (in
  `.npmrc` too), reads the cooldown from
  `pnpm-workspace.yaml` (an `.npmrc` only beside it), and holds Renovate's
  exemption and guard rules to package names alone. Jig states its own
  policy in `.config/supply-chain-policy.yaml`, runs the gate first among
  the repository checks in `bun run gates` and before CI's install, sets
  an empty `trustedDependencies` in each install root's `package.json` and
  the cooldown in each install root's `bunfig.toml`,
  and installs with scripts off in every CI install.
- M1 core piece 8 names [agent-runtime hooks](../GLOSSARY.md) as the rung
  between convention and git hooks, with their rules: local files only,
  bounded cost, three outcomes that fail open loudly, one registration in
  every runtime, and a self-test per hook that one runner discovers in CI.
  [`mappings.md`](../modules/M1-gates-enforcement-ladder/mappings.md#agent-runtime-hooks)
  maps the rung onto Claude Code's and Codex's hook systems, and
  [`templates/hook-self-tests.sh`](../modules/M1-gates-enforcement-ladder/templates/hook-self-tests.sh)
  is the runner, self-tested beside it.
- The plugin ships an agent-runtime hook, the turn-budget guard
  ([`hooks/turn-budget-guard.ts`](../plugin/hooks/turn-budget-guard.ts),
  registered by `hooks/hooks.json` before every tool call): it counts the
  session's agentic turns off the transcript and hands the agent a wrap-up
  instruction within 50 turns of the runtime's cap of 1000, so an unattended
  session writes its handoff before the runtime aborts it. `JIG_TURN_BUDGET`
  (`0` turns it off), `JIG_TURN_BUDGET_MARGIN` and `JIG_TURN_BUDGET_REFIRE`
  change the thresholds
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#environment-variables)).
  Codex runs a plugin's hooks only once trusted, and its transcript is not
  in the format the guard reads
  ([plugin/README.md § Codex notes](../plugin/README.md#codex-notes)).
- New M1 criteria, `since: next`: `dependency-release-cooldown`,
  `install-scripts-allowlisted`, `supply-chain-policy-lockstep`,
  `updater-self-checked`, `secret-scan-blocks-in-ci`,
  `secret-scan-local-and-forge-layers` and
  `agent-runtime-hooks-self-tested`; Jig's audit record scores them against
  the commit it audited.

### Changed

- `bun run gates` runs its cheap stages first (the context budget, format,
  lint, types and the repository checks) and runs to the end: every stage
  reports, the run closes with the list of what failed, each line the
  command that reruns that stage alone, and it exits 1 when a stage found
  violations and 2 when the only failures could not check (a stage that
  cannot start included). Each stage's name quotes its arguments and its
  status follows as a shell comment, so the line pastes into a shell as it
  is. `--fast` keeps
  its meaning. [CONTRIBUTING.md](../CONTRIBUTING.md#quality-gates) lists
  the stages in the new order, and M1 core piece 1 states the practice.
- drive-pr's reference on the turn budget and its `SKILL.md` say the plugin
  ships the counter, instead of asking each repository to install one.
