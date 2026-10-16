---
title: "ADR-0002: The plugin is the plugin/ directory, and every change to it ships as a version"
type: adr
status: amended
description: "Agent tools install only plugin/ from main; everything a skill needs lives there, and each change is a tagged version"
lifecycle: permanent
version: "1.2"
last_updated: 2026-10-16
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

## Amendments

### 2026-10-15 — The release is written after the merge (v1.1)

Touches the Decision's second half. A pull request that changes `plugin/` no
longer bumps the manifests or adds the version's section itself: it adds a
change note that asks for a release, and after the merge the release step
moves both manifests, writes the section and tags `v<version>` on its own
commit ([ADR-0004](ADR-0004-change-notes-released-after-the-merge.md)). Every
change to `plugin/` still ships as its own version. The changelog gate now
also fails a change under `plugin/` without such a note, which closes the gap
the Extraction section named.

### 2026-10-16 — Merges that wait together ship as one release (v1.2)

Touches the 2026-10-15 amendment's "every change to `plugin/` still ships as
its own version". A machine installs `plugin/` from `main`'s newest commit, and
the release step releases the tree it runs on. When several merges landed
before the step ran, that tree already holds all of their code, so a version
numbered and described for the first merge alone would carry the others'
changes: a breaking change could ship under a patch number, and the next
version would differ from it only in its metadata. Releasing each merge from
its own earlier tree is not available either, since the tag must sit on a
commit of `main` and `main` has no commit with only that merge's code under a
new version.

So the merges waiting when the step runs are one release: the largest bump any
of their notes asks for, with all of their notes in merge order. A merge that
lands while a run is in progress is released by the run queued behind it,
which keeps one version per run and still sends a change to machines within
one release run of its merge. Rejected: releasing each merge from its own tree
(a tag off `main`, or a branch machines never install), and a release pull
request a person merges (a second merge before every change, against ADR-0004).
