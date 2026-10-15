---
title: "ADR-0003: A person merges every pull request to Jig"
type: adr
status: amended
description: "Agents open, review and drive Jig's pull requests; only a person merges them"
lifecycle: permanent
version: "1.1"
last_updated: 2026-10-15
owner: maintainers
decision_date: 2026-10-11
supersedes: ~
superseded_by: ~
tags: [adr, pull-requests, hitl]
---

# ADR-0003: A person merges every pull request to Jig

**Status:** Approved · **Date:** 2026-10-11 · **Deciders:** Jig's maintainers

## Context

Agents write most of Jig's changes, and `/jig:drive-pr` drives their review
until no thread is left open. Merging to `main` is the step that publishes a
change: the agent tools install the plugin from `main`, so a merged change
reaches every machine that uses Jig on its next update.

## Decision

A person merges every pull request to Jig. Agents may open a pull request,
review it, resolve its threads and drive it to convergence; they never merge
it. This is a [HITL](../../GLOSSARY.md) (human-in-the-loop) decision in the
sense of [AGENTS.md](../../AGENTS.md).

## Alternatives considered

- **Merge automatically once the review converges**: rejected for Jig
  itself; a converged review shows that no reviewer has anything left, not
  that the change is one Jig should ship to every machine. ROADMAP item 9
  offers this to consumer repositories as a setting; Jig keeps a person.
- **Merge through a queue bot after an approval**: rejected for now; the
  person who would approve is the person who merges, so a queue adds a step
  without adding a check.

## Consequences

### Benefits

- Every change that reaches a machine passed a person's judgment.

### Costs

- A converged pull request waits for a person.

## Extraction (decisions-become-checks)

Not mechanically enforced, by choice: branch protection on `main` requires
the `gates` check and every review thread resolved, and forbids force-pushes
and deleting the branch, but requires no approving review,
since the person who merges is the person who would approve.
`scripts/check-branch-protection.ts` checks that policy by hand (reading the
setting needs an administrator's login, which CI lacks).

## Amendments

### 2026-10-15 — main's rules live in a ruleset, with the release App beside administrators (v1.1)

Touches the Extraction section. The policy it describes is unchanged, but it
now lives in a repository ruleset on `main` instead of branch protection,
and the ruleset lets one more actor past it: the `jig-release` GitHub App,
which pushes the commit that writes a merge's change notes and moves the
version ([ADR-0004](ADR-0004-change-notes-released-after-the-merge.md)).
That commit is not a merge: it writes what a person's merge already
implies, so a person still merges every pull request.
`scripts/check-branch-protection.ts` reads the ruleset.
