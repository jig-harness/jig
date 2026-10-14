# Context-budget checks — the always-loaded surface stays deliverable

Some text reaches an agent in every session before it does anything: the
instruction files chained from the repository root, and the name and
description of every skill and agent it can call. That is the
[always-loaded context](../../../../GLOSSARY.md), and each runtime and
reviewer that reads it has a budget for it. What runs past a budget is not
an error anyone sees: Codex keeps the first 32,768 bytes of the instruction
chain and drops the rest silently, and a skill listing over its allowance
loses entries. A rule in the dropped part is a rule the agent never received.

These checks measure that surface from the repository's files, against
the smallest budget of every consumer, and fail when it does not fit. Both use
only Bun's built-ins, so [CI](../../../../GLOSSARY.md) runs them before installing
dependencies, on every change.

## Files

| File | Role |
|------|------|
| `check-instruction-chain.ts` | `[--budget <bytes>] [--config <file>] [root]`: models Codex's `AGENTS.md` chain. For every directory with an instruction file, joins the chain from the root down (one file per directory, the first with content: `AGENTS.override.md`, then `AGENTS.md`, then the configured fallback names; a blank file is passed over) and fails each chain over budget, listing its files. Each chain uses the Codex configuration layered from the root down to its directory. Reports the largest chain |
| `check-discovery-budget.ts` | `--skills <dir>… --agents <dir>… [--namespace <plugin>] [--hard N] [--soft N] [--combined N] [--listing N] [--fail-soft]`: measures each skill's (`<dir>/<skill>/SKILL.md`) and agent's (`<dir>/*.md`) description and the aggregate skill listing |
| `fixtures/` | A small repository with a fallback-named instruction file, and a skills and an agents folder, all within budget |

Each script's header comment states what it measures, what it leaves out and
why. Both exit 0 within budget and 2 on a usage error or an unreadable input:
a missing root instruction file, or a `--config` file that does not exist,
for the chain check; a folder that does not exist, for the discovery check.
They exit 1 over a budget, and the discovery check also exits 1 on
[frontmatter](../../../../GLOSSARY.md) a runtime cannot use, on a skill or agent file its census
found but the measurement did not reach, on a duplicate skill name, and on a
skills folder with no skill in it (an agents folder with no agent is only
noted). Their self-tests sit beside them.

## The budgets

| Budget | Default | Source | Over it |
|--------|---------|--------|---------|
| Instruction chain, root to any directory | 32,768 bytes | Codex's `project_doc_max_bytes` default | fails |
| One description | 1,024 characters | the [agent-skills specification](https://agentskills.io/specification) | fails |
| One description, soft target | 512 characters | Jig's choice: half the hard limit, room to say what the skill does and when to use it, since every character is paid in every session | reported; fails with `--fail-soft` |
| Description plus `when_to_use` | 1,536 characters | Claude Code's per-entry cap | fails |
| Aggregate skill listing | 8,000 characters | Claude Code: about 1% of a 200,000-token window at 4 characters a token | fails |

Where the numbers come from, with the dates they were checked, is in
[mappings.md](../../mappings.md#always-loaded-context-budgets).

The following choices decide what the checks count:

- **Codex's chain, counted conservatively.** The chain check follows Codex's
  rules for which file each directory contributes. Each join between two
  files counts a blank line: a conservative count of whatever separator the
  runtime inserts, not a statement of it. A repository whose instructions
  live only in `CLAUDE.md` files names that file as a fallback in
  `.codex/config.toml` (`project_doc_fallback_filenames = ["CLAUDE.md"]`),
  which is how Codex would read them too. Claude Code's own chain, `CLAUDE.md`
  and what its imports bring in, is not measured: it loads by other rules and
  no byte cut-off is known for it.
- **The smallest consumer wins.** A repository can raise Codex's limit in
  `.codex/config.toml`, but a hosted Codex reviewer ignores that file and
  keeps the default. The chain check reads the configured value and enforces
  the smaller of it and `--budget` (default 32,768), so raising the
  configuration never raises the gate. Codex layers `.codex/config.toml`
  files from the root down to the directory it works in, so each chain takes
  its budget and fallback names from the layers above it, the deepest
  setting winning: a nested layer that lowers the limit is held to it. A
  repository with no consumer that ignores its configuration passes its
  configured value as `--budget`.
- **Count the worst case.** A path-scoped skill joins the listing once a
  matching file is read, so the listing counts every one of them: a listing
  that is green at session start must not go red mid-session. A skill with
  `disable-model-invocation: true` is never listed and costs nothing there.
- **Nothing skipped silently.** Unusable frontmatter fails rather than being
  skipped, each physical file is measured once however many links reach it,
  and an independent census of each skills and agents folder must find no
  `SKILL.md` or agent file the measurement missed, so a skipped definition
  fails instead of shrinking the aggregate. An instruction file,
  configuration layer or definition that is not a regular file (a link to
  nothing, a named pipe, a link to a device) fails as unreadable, and is never
  read.

Left out: Model Context Protocol ([MCP](../../../../GLOSSARY.md)) server
instruction blocks, skills a person or another plugin adds, a person's own
instruction files and the runtime's built-in entries. They are part of the
always-loaded surface, but no repository file shows them, so measure them in
a running session as [mappings.md](../../mappings.md#what-each-runtime-loads)
describes. Legacy command files (`.claude/commands/`) share Claude Code's
listing too; the check leaves them out because the format is superseded by
skills, so a repository still carrying them adds their cost by hand or
migrates them. No runtime documents an aggregate allowance for agent
descriptions, so their total is reported and not gated.

Try it with the pinned Bun runtime:

```sh
bun check-instruction-chain.ts --config fixtures/repo/codex-config.toml fixtures/repo
bun check-discovery-budget.ts --skills fixtures/skills --agents fixtures/agents
```

Rerun the first with `--budget 100` to see a chain fail.

## CI wiring

Run both as a step before dependencies are installed, on every pull request
and without a path filter: an instruction or skill change is often prose
only, which is exactly the change a path-filtered job skips. The recipe is in
[mappings.md](../../mappings.md#ci-recipe-before-dependencies-install).
