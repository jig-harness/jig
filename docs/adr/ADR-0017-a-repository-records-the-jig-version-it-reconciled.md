---
title: "ADR-0017: A repository records the Jig version it last reconciled with"
type: adr
status: draft
description: "A consumer repository states the Jig version it last reconciled with as jig.reconciled in its committed .config/jig.yaml; the value only moves forward, the repository's own change sets it, and the check that reads it never writes it"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-12
owner: maintainers
decision_date: 2026-11-12
supersedes: ~
superseded_by: ~
tags: [adr, consumer-actions, configuration, releases]
---

# ADR-0017: A repository records the Jig version it last reconciled with

**Status:** Draft · **Date:** 2026-11-12 · **Deciders:** Jig's maintainers through pull-request review

## Context

Some of Jig's changes ask something of the repositories that use it: a
renamed configuration key, a runbook that now describes the old behaviour, a
newer plugin source on a machine. Each such change declares a
[consumer action](../../GLOSSARY.md) in its change note, and
the release step derives the record of every action from the changelog
([design/consumer-actions.md](../../design/consumer-actions.md)). A check
then tells a [consumer repository](../../GLOSSARY.md)
which of those actions it still owes.

To answer, the check needs to know where the repository stands: which
releases' actions it has already taken or dismissed. Without a recorded
starting point it would report every action since the record began on every
run, and a person would triage the same history again each time. The
starting point has to be the same on every machine that drives the
repository, survive the loss of any one of them, and say what the
repository itself has done, not what a machine once reported.

## Decision

**The repository records the version.** A consumer repository states the
Jig version it last reconciled with as `jig.reconciled` in its own
`.config/jig.yaml`: a version string, committed, so it travels with the
repository to every machine that drives it. For the actions at the
repository's own levels (`configuration` and `instructions`), the check reads
only the releases after it. Without the field it reads from the record's
first release, that release included. Actions at the `machine` level describe
one host and are never recorded in the repository: they are judged against
each host's state on every run, whatever the field says.

**The repository's own change sets it, never the check.** The value is the
repository's statement that it has taken or dismissed every
repository-level action up to that version. It is set by a change to the
repository, made and reviewed like any other, typically the one that takes
the actions. The check reads the field and never writes it.

**It only moves forward.** The value is compared as a version. A change sets
it only when that moves it forward ("unless it already names a later
version"), so two such changes merged out of order never move it back, and it
is never set past a release whose actions are still open. A dismissed action
is recorded beside it, with its reason, in the same change.

## Alternatives considered

- **Only the last audit record as the baseline.** Audit records go stale,
  and the audit does not run on a schedule; an audit says how mature a
  repository is, not that a release's actions were taken. The audit's plugin
  version is shown beside the check's report as context, never used as the
  baseline.
- **A record on the machine only.** It differs from host to host, is lost
  with the host, and cannot say what the repository has taken. The machine
  keeps a record of what it reported and what needed nothing, as a cache,
  not as the source of truth.
- **The check writes the field.** A tool that moves a repository's own
  statement would claim actions nobody took; the field would then record
  that a check ran, not that the repository changed.

## Consequences

- A repository's history shows when it reconciled and in which change, and
  every machine that drives it reads the same starting point.
- A repository that never sets the field is told about every action since the
  record's first release, which is bounded: the record starts at the release
  that ships it.
- `jig.reconciled` and the list of dismissals are fields of the configuration
  schema, added with the check that reads them.
- Machine-level actions keep no baseline, so a host whose state is stale is
  reported even after another host's repository moved past the action.

## When to reopen

Reopen if repositories routinely reconcile in pieces that a single version
cannot describe (most actions of a release taken, one long-running one
open), so that the list of taken and dismissed actions grows faster than the
version moves; or if a consumer repository cannot commit to its own
`.config/jig.yaml`.
