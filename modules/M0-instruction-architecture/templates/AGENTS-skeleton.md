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

## Key references

- **Architecture**: `<docs/ARCHITECTURE.md>`
- **Decision records**: `<docs/adr/>`
- **Skeleton files**: `<.config/skeleton.yaml>` — read it before modifying
  anything it lists. Those files hold the architecture's contracts and are
  read-only for agents: stop and ask a person, who updates the inventory or
  names an approved decision record. Everything else is yours to change.
- **Delivery lifecycle**: `<docs/LIFECYCLE.md>` — the stages work moves
  through, who owns each and what it hands on; read it to see what comes
  next (template: M6's `LIFECYCLE.md`).
- **Glossary**: `/GLOSSARY.md`
- <Other single-source-of-truth files agents must consult, one line each.>
