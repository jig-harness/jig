---
title: "ADR-0002: The plugin is the plugin/ directory, and every change to it ships as a version"
type: adr
status: amended
description: "Agent tools install only plugin/ from main; everything a skill needs lives there, and each change is a tagged version"
lifecycle: permanent
version: "1.5"
last_updated: 2026-10-18
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

### 2026-10-17 — One version for each release run, by construction (v1.3)

Settles the 2026-10-16 amendment as the rule for every release run, not a
case it handles. A run releases the newest commit of `main` it checks out,
and a version exists once the run's one atomic push puts its release commit
and its tag on `main`. By then every waiting merge has landed, so the commit
the version goes on top of holds all of their code. The earlier commits of
`main` that hold only some of those merges stay in its history, but a version
cannot be added to one of them: its release commit and tag have to land on
`main`'s newest commit, not on an older one. A run that wrote one version for
each waiting merge would push a chain of release commits, each numbered and
described for one merge while sitting on a tree that holds the later ones
too, and none of them would get a run of the gates of its own. A run therefore writes at most one version, and the release step has no
per-merge mode. It writes one when at least one waiting note asks for a
release, at the largest bump any asks for; notes that ask for none go under
Unreleased without moving the version, and a run with no notes waiting
writes nothing.

### 2026-10-17 — A template or gate a skill uses lives in the skill (v1.4)

Touches the Costs section's "such as the maturity criteria": the rule that
material a skill reads lives under `plugin/` is now stated for every kind of
asset, not for the criteria alone. A template or a gate (a script with its
self-test) stays in its module until a skill reads or runs it, then moves into
that skill (`templates/`, `scripts/`, `__tests__/`), moved and not copied, and
the module's README links it there. Nothing moves ahead of a skill that uses
it. The module contract in [modules/AGENTS.md](../../modules/AGENTS.md)
no longer requires `templates/` and `reference/` in every module directory,
and the licence gate (`scripts/check-licences.ts`) lists templates in a skill
(`plugin/skills/*/templates/`) as it lists those in a module. Rejected:
moving the plugin to the repository root (its `package.json` would make each
agent tool install the development dependencies on every machine), and a
copy of the asset in the skill (it drifts from the module's).

### 2026-10-18 — A version's tag follows its release commit's gates (v1.5)

Touches the third amendment's "a version exists once the run's one atomic
push puts its release commit and its tag on `main`". The run's push carries
the release commit alone; the tag is made on that commit once its gates pass
([ADR-0004](ADR-0004-change-notes-released-after-the-merge.md)'s third
amendment). A version therefore exists on `main`, and reaches machines that
install from it, as soon as its release commit lands, and a machine pinned to
a tag receives it once the tag exists. The rest of that amendment holds: the
release commit still lands on `main`'s newest commit, so one run still writes
at most one version.
