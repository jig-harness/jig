---
title: "ADR-0014: An address is derived from records, and a request is a record"
type: adr
status: draft
description: "Every station of the execution line on a piece of work has an address that is derived from the records the station leaves, never declared or held; asking reads those records and telling writes one record the line already acts on, so no resident agent, daemon or queue holds an address or a request"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-05
owner: maintainers
decision_date: 2026-11-05
supersedes: ~
superseded_by: ~
tags: [adr, records, addresses, dispatcher, drive, dark-factory]
---

# ADR-0014: An address is derived from records, and a request is a record

**Status:** Draft · **Date:** 2026-11-05 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's execution line runs one work item through a row of
[stations](../../GLOSSARY.md) (pick-up, drive, follow-up), and each leaves
records where it works: a claim on the tracker, a ledger and claims on the
pull request, launch records and an outcome log on the machine that
dispatched it ([ADR-0013](ADR-0013-records-not-a-daemon.md)). Where a piece
of work stands is read from those records by several readers, each its own
way, and a person steers the line with a different gesture for each case: an
assignment, a label, an `answer` comment, a mailbox directive.
[design/addresses.md](../../design/addresses.md) gives every station on a
piece of work one name, an [address](../../GLOSSARY.md)
(`drive@jig-harness/jig#456`), which `jig ask` answers and `jig send`
writes to.

A name that can be asked and told invites a resident holder: an agent per
station kept alive to answer, or a queue an interface posts requests into
and a daemon drains. These constraints weigh against it.

- **A station is held only while a launch runs.** A drive pass lives
  minutes, a pick-up's session an hour; between them the station is empty,
  and a person may ask about it at any time. An answer that needed a live
  session would need one kept alive, compacted and replaced for every
  station of every piece of work.
- **The records already say it.** Who holds a launch, how it ended, what a
  park asks and who answered are each in a record some reader already acts
  on. A second store of the same facts would be one more thing to keep in
  step, and the first to drift.
- **The readers already act on records.** The dispatcher's tick starts a
  pick-up from an assignment, arms a drive from a label, re-arms one from an
  answer; the driver obeys a mailbox directive. A request that is one of
  those records reaches its reader at its next run with no new path to it.

## Decision

An address is derived from the records its station leaves, never declared:
the station is one of a closed list in code, the repository and the key name
the piece of work, and nothing registers an address or keeps one. An address
nobody holds is still valid, and answers with its last outcome or with the
fact that nothing was recorded under it.

Asking an address reads those records and writes nothing. Telling one
writes one record of a kind the line already reads (a tracker assignment, a
dispatch label, an `answer` comment, a mailbox directive), through the
writer of the component that owns that record, and its reader acts on it at
its next run. No resident agent holds an address, and no daemon, queue or
inbox holds a request.

## Alternatives considered

- **A resident agent per station.** Rejected: it answers only while it
  runs, so it has to be kept alive, compacted and replaced, and what it
  says is a summary of the records rather than the records.
- **A queue or an inbox that a daemon drains.** Rejected: a request must
  outlive its sender, so the queue is a durable store beside the records the
  readers already act on, and the daemon is the resident process
  [ADR-0013](ADR-0013-records-not-a-daemon.md) declines.
- **Addresses a repository declares.** Rejected: the list of stations is the
  line's, so an address means the same in every repository, and a declared
  one could name a station that leaves no records to answer from.

## Consequences

### Benefits

- Any session on any machine can ask or tell, and one that ends loses
  nothing: what it knows it has just read.
- An interface that shows or steers the line reads one answer and writes
  through one command, with the same checks for every request.
- A request is checked by the reader that acts on it, under that reader's
  own rule for whose record counts, so asking or telling adds no authority.

### Costs

- An answer is as fresh as its records: another machine's launch is known
  only as far as its claims on the forge say, and a request waits for its
  reader's next run.
- Each answer reads the records again; the forge reads are conditional, so
  an unchanged pull request costs nothing against the forge's limit, but a
  changed one does.

## When to reopen

Reopen this when a question about a station comes up often enough to name
that no record can answer, or when a request must reach a running session
sooner than its reader's next run. Then record what is missing as a record
its owner writes, rather than adding a holder.

## Extraction (decisions-become-checks)

The stations are a closed list in `plugin/shared/address.ts`, and `jig ask`
reads only through the exports of the components that own each record. That
`jig ask` writes no record is held by its tests, which run it against a
forge that answers reads only and find every forge call a read; that no
command keeps a store of addresses or requests is review's to hold.
