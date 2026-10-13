---
title: "ADR-0002: The plugin is the plugin/ directory, and every change to it ships as a version"
type: adr
status: approved
description: "Agent tools install only plugin/ from main; everything a skill needs lives there, and each change is a tagged version"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-13
owner: maintainers
decision_date: 2026-10-09
supersedes: ~
superseded_by: ~
tags: [adr, plugin, release]
---

# ADR-0002: The plugin is the plugin/ directory, and every change to it ships as a version

**Status:** Approved · **Date:** 2026-10-09 · **Deciders:** Jig's maintainers

## Context

Jig's skills reach other repositories as a [plugin](../../GLOSSARY.md) that
Claude Code and Codex install once per machine from this repository's
marketplace files. The rest of the repository (modules, seeds, tests, the
development dependencies) is large and is not needed at run time. A machine
that installed a skill should be able to tell which version it runs, and a
consumer should be able to read what changed before it updates.

## Decision

The marketplace files (`.claude-plugin/marketplace.json`,
`.agents/plugins/marketplace.json`) point at `plugin/`, and the tools install
that directory from `main`. Everything a skill reads at run time lives under
`plugin/`, including the audit's maturity criteria. Every pull request that
changes `plugin/` bumps `version` in both plugin manifests, adds that
version's section to [CHANGELOG.md](../../CHANGELOG.md), and its merge commit
is tagged `v<version>` ([plugin/AGENTS.md](../../plugin/AGENTS.md)).

## Alternatives considered

- **Install the whole repository**: rejected; it copies modules, seeds and
  tests to every machine and makes it unclear which files a skill may rely
  on.
- **A separate repository for the plugin**: rejected; a change to a module
  and to the criteria that score it would need two pull requests in two
  repositories.
- **Release only now and then, batching changes**: rejected; a machine
  receives a change only through a new version, so a change merged without
  one waits for a later release and arrives mixed in with others.

## Consequences

### Benefits

- A skill runs from the plugin cache with the same files it was tested
  with; `tools/plugin/plugin.test.ts` checks the skills from a copy.
- Every change a machine receives has a version and a changelog section.

### Costs

- Material a skill reads, such as the maturity criteria, lives under
  `plugin/` even where it belongs to a module, and the module links to it.
- A documentation-only change under `plugin/` is a release too.

## Extraction (decisions-become-checks)

Partly checked: `tools/plugin/plugin.test.ts` fails when the two manifests
disagree, and the changelog gate (`scripts/check-changelog.ts`) fails when
the current version has no section. Nothing yet fails a change under
`plugin/` that leaves the version unchanged.
