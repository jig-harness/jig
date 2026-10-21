---
title: "ADR-0008: Windows cancellation uses captured process identities"
type: adr
status: approved
description: "Captured process identities and registered runners are sufficient for cooperative drive passes; Windows cancellation accepts the late-spawn race and provides no complete-tree containment guarantee"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-20
owner: maintainers
decision_date: 2026-10-20
supersedes: ~
superseded_by: ~
related:
  - ADR-0001-bun-typescript-toolchain.md
tags: [adr, windows, process-control]
---

# ADR-0008: Windows cancellation uses captured process identities

**Status:** Approved · **Date:** 2026-10-20 · **Deciders:** Jig's maintainers, through pull-request review

## Context

Stopping a drive must cancel its active pass and the commands Jig launched
for it. A process identifier alone is insufficient: the operating system
can reuse it after a process exits, and a descendant can outlive the parent
that connected it to the pass.

Jig captures process identifiers together with creation times, retains
observed descendants, and registers managed runners before their launch
handoff completes. Its cancellation code rechecks identities before force,
then reads the process table to confirm their disappearance. Unreadable
identities, unresolved registrations and missing completion evidence keep
cleanup unconfirmed. These are observations of managed work, not an
operating-system boundary around all possible descendants.

Windows [Job Objects](../../GLOSSARY.md) can group processes for termination.
Membership normally passes to children created with `CreateProcess`, subject
to breakaway settings; indirect creation through `Win32_Process.Create`
does not inherit membership. Closing the last job handle with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates associated processes.
[Microsoft's Job Objects reference](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
describes these limits.

## Decision

Use captured process identities and the runner registry for the current
cooperative `drive-pr` and `do-item` passes on Windows. Accept this mechanism
for their present cancellation scope and add no Job Object implementation.

Accept the remaining race explicitly: an unregistered descendant can be
created after capture and lose its observable parent link before another
capture. Cancellation can confirm that its captured identities disappeared
while that unseen descendant remains alive. A successful `stop()` is
evidence about the observed and registered work under this cooperative model;
it is not proof that every descendant is gone, or containment of arbitrary
pass commands. The record a confirmed cleanup leaves in the runner
registry says no more than that: it confirms the observed and registered
work only.

Windows currently waits through the grace interval and then forces known
targets. It does not send a graceful console break event. Generating
`CTRL_BREAK_EVENT` would require a process group and shared console;
descendants with a different console would not receive it.
[Microsoft's console-control reference](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)
defines that delivery scope.

Revisit this decision when a supported pass demonstrates an escaping
descendant in normal use, or a consumer needs cancellation with an
operating-system membership guarantee. That work must define which launch
paths belong to the job and test their native Windows lifecycle before
claiming stronger evidence.

## Alternatives considered

- **Job Objects through [`bun:ffi`](https://bun.sh/docs/runtime/ffi):**
  calling native libraries avoids shipping a helper executable. Jig would
  own native handle lifetimes, Windows structure layouts and function
  signatures, plus launch, streams, exit status and console integration.
  Bun documents manual memory management and alignment requirements. Job
  assignment before a child runs needs a native launch protocol, such as
  creating a suspended thread, assigning the job and resuming execution
  ([Windows creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)).
  This is a maintenance cost, not an unavailable capability.
- **A vendored native helper:** it could own launch and job handles, but
  would add builds for each supported architecture, verification of their source,
  distribution and signing decisions, and an interface carrying arguments,
  environment, streams, exit status and cancellation. No validated helper
  exists in Jig to move into this role. Its additional delivery cost is not
  justified by the current cooperative scope.
- **A parent-identifier tree kill alone:** it cannot recover a descendant
  after its parent connection disappears, and command success cannot
  confirm disappearance. Keep the captured identities and registry.

## Consequences

### Benefits

- Keep the existing Bun process runner and plugin distribution, with no
  additional native artifact or launch implementation.
- Preserve ownership evidence for managed runners after launcher exit and
  retain uncertainty when a known registration cannot be reconciled.

### Costs

- Late unregistered descendants can escape observation and cancellation,
  even for a cooperative command that happens to launch during shutdown.
- There is no graceful Windows console-break delivery, no operating-system
  record of which processes belong to the pass, and no automatic job-close
  termination if the driver crashes.
- A stronger cancellation requirement needs a separately validated native
  launch implementation; more snapshots cannot eliminate the race.

## Implementation and evidence

The drive's [`proc.ts`](../../plugin/skills/drive-pr/scripts/lib/proc.ts)
delegates Windows stop to
[`windows-process.ts`](../../plugin/shared/windows-process.ts), which uses
the shared process tree and registry code.

[`process-tree.test.ts`](../../plugin/shared/__tests__/process-tree.test.ts),
[`process-registry.test.ts`](../../plugin/shared/__tests__/process-registry.test.ts)
and [`windows-process.test.ts`](../../plugin/shared/__tests__/windows-process.test.ts)
cover retained ownership, uncertain reads, deadlines, handoff, completion
authority and retries.
[`windows-process-tree.test.ts`](../../plugin/skills/drive-pr/__tests__/windows-process-tree.test.ts)
launches a registered runner outside the pass's tree and checks that its
observed descendants disappear after cancellation.

These suites run in the repository's native Windows nightly jobs. Passing
them on macOS exercises the shared algorithm and managed-runner scenario;
it supplies no native Windows Job Object or console-control evidence. Their
coverage does not prove absence of unseen descendants.

## Extraction (decisions-become-checks)

Jig has no decision-rules catalog. No catalog is introduced for this record.
The ownership and uncertainty behavior above has tests, but the scope
decision is semantic: reviewers must check that changes preserve unknown
results, and that they never describe "every captured identity
disappeared" as "every descendant is gone". A text pattern cannot
establish that distinction.
