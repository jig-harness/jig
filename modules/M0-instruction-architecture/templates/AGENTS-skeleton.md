<!--
  TEMPLATE — copy this file to your repo root as AGENTS.md and fill in the
  <placeholders>. Delete these authoring comments as you go.

  Principles this skeleton encodes (see the M0 module README):
  - This is the ONE universal instruction file. Tool-specific files
    (CLAUDE.md, .cursorrules, …) carry only their runtime's delta and point
    back here — never a second copy of anything below.
  - Keep it small: aim for ≤ ~150 lines. Long content (full workflows,
    per-area rules) belongs in per-directory files, conditional rules, or
    skills — linked from here, not inlined.
  - Every guardrail should name the failure it prevents. Rules without a
    "why" get ignored or cargo-culted.
-->

# <Project> Agent Instructions

Context for AI coding agents working on <Project>. Compatible with
Claude Code, Codex, Cursor, GitHub Copilot, and others.

**<Tool> users**: see `/<TOOL-FILE>.md` for tool-specific features.
<!-- One pointer line per runtime that needs a delta file, e.g.:
     **Claude Code users**: see `/CLAUDE.md` for tool-specific features. -->

**Runtime-specific capabilities** (a slash command, a built-in tool, a tool
the host injects) are named with their fallback: a skill's `SKILL.md` beside
its `/<name>`, a plain-text question where no question tool exists.
<!-- Equivalents per runtime:
     https://github.com/jig-harness/jig/blob/main/modules/M0-instruction-architecture/mappings.md#runtime-specific-capabilities-and-their-fallbacks -->

**Domain glossary**: before writing any spec, issue, code comment, or PR
description that reasons about domain concepts, skim [`/GLOSSARY.md`](GLOSSARY.md).
Use the canonical terms; flag the **_Avoid_** aliases when teammates or
earlier code use them. It is short by design — read it once per major task.

## Project overview

**<Project>** is <one-sentence product description>.

<Monorepo/single-app layout in 2–3 lines: build tool, package manager,
main languages, where the apps and packages live.>

## Default disposition

When multiple approaches are viable, default to the disciplined, systematic
one — follow the established workflow, mechanize checks, fix root causes.
Full behavioral defaults and the conditions under which each flips:
[`docs/dispositions.md`](docs/dispositions.md).
<!-- Copy templates/dispositions.md from module M0 to that path. -->

## Critical guardrails

These rules prevent recurring failures. Violating any causes bugs, security
issues, or broken builds.

### 1. <Guardrail name> (MANDATORY)

<One sentence: the rule. One sentence: the failure it prevents.>

```<lang>
// ✅ CORRECT
<minimal correct example>

// ❌ WRONG — <what breaks>
<minimal wrong example>
```

### 2. <Guardrail name>

<Rule + why. Link the ADR or doc that decided it, if one exists.>

### 3. No hand-counted tallies in prose

A number that constrains stays (`3 retries`, `≤ 8000 chars`). A number that
counts an adjacent list (`the 6 passes`, `120 skills`) is a cache that
drifts when the list changes: drop it and let the list speak, or register
it as a fact a CI check derives (`<facts-check command>`); mark a counted
number that is a real measurement with `<!-- measured -->`.

<!-- Add guardrails sparingly: each one is context every agent pays for on
     every task. If a rule only applies to one area of the repo, make it a
     path-scoped conditional rule instead (see templates/rules-README.md). -->

## Quality gates (MANDATORY before commit)

All must pass simultaneously. After fixing one issue, re-verify the others.

```bash
<format command>       # formatting
<lint command>         # linting (0 errors/warnings)
<typecheck command>    # type checking
<test command>         # all tests pass
<build command>        # build succeeds
```

## Git workflow

- Target branch for PRs: `<branch>`. <Any locked branches.>
- Commit style: <e.g. Conventional Commits: `feat:`, `fix:`, `docs:`, …>
- Branch naming: `<pattern, e.g. feature/<slug>>`.

## Workspace context

Each directory can have its own instruction file. A nested file **extends**
this one with local conventions; it never contradicts it:

| Directory | Key focus |
|-----------|-----------|
| `/<apps/backend/>` | <backend stack, service patterns> |
| `/<apps/web/>` | <frontend stack, UI rules> |
| `/<packages/*/>` | <package-specific patterns> |

## Standards scope by artifact class

Each standard governs only the classes of file it names. Applying one
outside them produces false findings. A file's class is what it does, not
where it lives: a file under `scripts/` that starts a long-lived server or
listener is runtime code.

| Class | What it is | Standards that govern it |
|-------|------------|--------------------------|
| Runtime code | services, workers, route handlers | <standards, linked> |
| One-shot tools | command-line scripts that exit after their work | <standards, linked> |
| Tests | test files, fixtures, test helpers | <standards, linked> |
| Instruction files | `AGENTS.md`, rules, skills | <standards, linked> |

<!-- Example: an injected-clock rule
     (https://github.com/jig-harness/jig/blob/main/modules/M14-testing-strategy/README.md#core-pieces)
     governs runtime code only. A script that exits after its work takes the
     instant as a parameter, which gives the same testability; a test's own
     setup and polling deadlines are outside it too. -->

## Standing review stances

Settled positions a reviewer must not reopen. Each line points to the one
place the stance is written, never restates it; a finding that contradicts
one is closed as rejected with a link to that source.

- **<Stance name>** → `<docs/adr/ADR-NNNN-….md>`
- **<Stance name>** → `<docs/policy.md#section>`

<!-- A pointer may say what a reviewer needs to decide whether to raise a
     finding ("applies to runtime code only"); what is done with the finding
     belongs to the source. See
     https://github.com/jig-harness/jig/blob/main/modules/M0-instruction-architecture/README.md#invariant -->

## Key references

- **Architecture**: `<docs/ARCHITECTURE.md>`
- **Decision records**: `<docs/adr/>`
- **Skeleton files**: `<.config/skeleton.yaml>` — read it before modifying
  anything it lists. Those files hold the architecture's contracts and are
  read-only for agents: stop and ask a person, who updates the inventory or
  names an approved decision record. Everything else is yours to change.
- **Delivery lifecycle**: [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md) — the
  stages work moves through, who owns each and what it hands on; read it to
  see what comes next (template: M6's `LIFECYCLE.md`). Link it as Markdown, so
  the lifecycle map gate can see it.
- **Glossary**: `/GLOSSARY.md`
- <Other single-source-of-truth files agents must consult, one line each.>
