---
title: "ADR-0028: A person's profile stays on the host, beside the machine file, and every schedule shares one parser"
type: adr
status: approved
description: "A person's own preferences (time zone, routine, timed override, personal chat delivery) will live in one host-local person profile, $JIG_HOME/person.yaml or the file serve[].profile names, read by one fail-closed reader; serve[] in the machine file stays host authorization and identity; individual priorities stay in a sibling file; every weekly schedule and time zone will go through one shared Temporal schedule primitive with five invariants; a routine never widens autonomy; teams, devices and hub sync stay out"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-27
owner: maintainers
decision_date: 2026-11-27
supersedes: ~
superseded_by: ~
related:
  - docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md
  - docs/adr/ADR-0018-time-is-temporal.md
  - docs/adr/ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md
tags: [adr, dispatcher, configuration, chat, priorities, time]
---

# ADR-0028: A person's profile stays on the host, beside the machine file, and every schedule shares one parser

**Status:** Approved · **Date:** 2026-11-27 · **Deciders:** Jig's maintainers

## Context

Four planned or built features each want to know something about one
person: when they work, which time zone they live in, how they want to be
reached, and what they want worked on. Each has started to choose its own
home and its own way to read a weekly schedule:

- The [machine file](../../plugin/CONFIGURATION.md#the-machines-dispatch-file),
  `$JIG_HOME/dispatch.yaml`, lists
  under `serve[]` the people a [dispatcher](../../GLOSSARY.md) host works
  for: each person's `name`, `forge` logins and `tracker` identities. The
  reader refuses any other key. The [chat design](../../design/chat.md)
  plans `serve[].chat.slack`, the chat user a host maps to a person's forge
  login, and the [priorities design](../../design/priorities-and-overview.md)
  planned an individual `priorities` record under the same entry.
- The individual routine ([#1403](https://github.com/jig-harness/jig/issues/1403)) plans a host-local file with `focus`,
  `loose` and `away` modes and a timed override.
- Before this decision, the chat design planned host-wide `chat.timezone`,
  `chat.quiet`, `chat.direct` and `chat.digest_at`, with `chat.quiet` written
  as a bare `HH:MM-HH:MM` range; decision 2 below replaces that range with
  the weekly-window grammar.
- `autonomy.off_hours.{level, schedule}` is built
  (`plugin/shared/off-hours.ts`): a list of weekly windows,
  `<days> [HH:MM-HH:MM]`, read in the machine's local time zone through
  Temporal ([ADR-0018](ADR-0018-time-is-temporal.md)).

Left alone, the routine, the Slack channel ([#1105](https://github.com/jig-harness/jig/issues/1105)), the digest
([#1106](https://github.com/jig-harness/jig/issues/1106)) and the declared priorities ([#1177](https://github.com/jig-harness/jig/issues/1177)) would each add a home, a parser and a
precedence rule, and the four would disagree about the same person's
evening.

The forces, as the code and the designs stood on 2026-11-27 (the evidence date):

- The machine file is the switch for dispatch itself: `jig install` installs
  the dispatcher only when that file exists. A machine that never
  dispatches must not have to create it to record a time zone.
- The user layer, `~/.jig/jig.yaml`, is a layer of the repository
  configuration: `JIG_USER_LAYER=off` leaves it out, and a syntax error in
  it fails the whole file. A person's evening is not repository
  configuration, and a typo in it must not stop a repository's settings.
- `serve[]` decides whose work a host may start and whose chat clicks it
  turns into writes under its own login
  ([ADR-0022](ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md)).
  That is authorization; it must stay small and strict.
- The [weights file](../../GLOSSARY.md), `$JIG_HOME/weights.local.yaml`,
  already shows the shape that works for a host's own declarations: a
  sibling file, read on every tick, never committed, whose failure stays
  its own.
- [ADR-0016](ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md) and
  the priorities design say a host never transmits its individual
  declarations or identities to the [hub](../../GLOSSARY.md).

## Decision

### 1. A person's profile is host-local, beside the machine file (ruling 1A)

**`serve[]` stays host authorization and identity.** Its keys stay `name`,
`forge` and `tracker`, with `chat.slack` added when the chat design's
mapping from forge login to chat user ships, as the host's login-write
authorization boundary ADR-0022 describes. No
preference moves into it. A machine that does not dispatch will never
create `dispatch.yaml` for a preference, so the file keeps its meaning:
the switch `jig install` reads to include the dispatcher, and the mark
`jig install hub` reads to refuse the dispatcher's user.

**Preferences do not live in the user layer.** `~/.jig/jig.yaml` stays
repository-layered configuration.

**One shared `PersonProfile` schema will hold a person's host-local
preferences**, the [person profile](../../GLOSSARY.md): the time zone, the routine and its timed override
([#1403](https://github.com/jig-harness/jig/issues/1403)),
and personal chat delivery (`direct`, quiet hours). A field is added to the
schema only in the change that ships the feature that reads it.

**Where the profile lives:**

| Machine | Profile | Individual priorities |
| --- | --- | --- |
| Solo or non-dispatch machine, and the interactive skills a person runs at their own keyboard (`operator`, `orchestrate`) | `$JIG_HOME/person.yaml` | `$JIG_HOME/priorities.local.yaml` |
| Dispatch host serving more than one person | The path `serve[].profile` names, per served person | A per-person sibling file or folder beside that profile; a served person with no `serve[].profile` has no individual priorities record, and the host's own priorities apply |

`serve[].profile: <path>` will be an optional, additive key, so no existing
machine file breaks and `serve[].name` gains no new restriction on its
spelling.

**Individual `priorities/v1` records stay in their own file**, mirroring
the weights file, so a typo in a day's routine override never blocks
allocation or breaks the machine file.

**One shared reader will read every person profile, failing closed:** it
resolves the path to its real target (following symbolic links) and fails
when resolution fails, so a dangling link fails rather than reading as
absent; it refuses unknown keys; and it refuses a resolved target that Git
tracks inside a working tree, so a committed profile is never read. It opens
the resolved target first and reads only from that open file. It then
runs the Git check on the resolved path and compares the open file's device
and inode with the resolved path's both before and after that check, so a
link or parent directory swapped at any point up to the end of the Git check
is a refusal, and a swap after it cannot change what is read, since every
byte comes from the already-open file.

The invariant is what is read, not where the path points: every byte comes
from one open file, and the Git check and the identity comparisons are
refusals about that file's identity, not guards on the path. A process that
can write the profile's directory or an ancestor of it can already replace
the profile with any content, so a swap race gives it nothing the write
access did not. The owner-only assumption is therefore checked, not hoped
for: for every profile the reader reads, whether named by `serve[].profile`
or found at `$JIG_HOME/person.yaml`, it refuses when the resolved file, its
directory or any ancestor directory up to the filesystem root is writable by
anyone but its owner or the platform's administrative principal, and when the
file or any of those directories is owned by anyone but the user the reader
runs as or that administrative principal. The administrative principal is
`root` on POSIX systems and, on Windows, the built-in `SYSTEM` and
`Administrators` principals, read from the access-control list instead of mode
bits. The trusted owner is a named, closed set of two, never "whoever owns that
level", so a profile beneath another user's private directory is refused. A
sticky directory (such as `/tmp`) does not count as safe for this purpose.

### 2. One schedule and time-zone primitive (ruling 2A-i)

The weekly-window parser in `plugin/shared/off-hours.ts` will be promoted to
one shared, pure Temporal schedule primitive, `plugin/shared/schedule.ts`,
that takes an explicit [IANA time zone](../../GLOSSARY.md) (`Europe/Berlin`) and defaults to
`Temporal.Now.timeZoneId()`. Every feature that reads a weekly schedule or
a person's time zone will read it there. It will hold five invariants:

1. **Cross-mode overlaps are refused when the schedule is read**, and
   windows of the same mode still combine, as `DEFAULT_OFF_HOURS_SCHEDULE`
   relies on: Friday's overnight window overlaps `Sat-Sun`.
2. **A routine covers the whole week**: it names an explicit `default` mode
   or its windows cover all 7 × 24 hours. No gap is silently uncovered.
3. **A window whose start equals its end is refused.** A whole day is
   written by its day alone (`Mon`).
4. **Transitions are safe across daylight-saving changes**: a
   `nextTransition()` helper computes the next mode change with
   `Temporal.ZonedDateTime` and `compatible` disambiguation, and a timed
   `override.until` is an ISO-8601 instant with `Z` or an explicit offset.
5. **A fixed offset is refused where an IANA time zone is required**:
   `+02:00` would silently ignore daylight saving. `chat.quiet` moves to the
   shared window-list grammar.

**A routine never widens autonomy.** No routine mode, `away` included, will
widen an agent's permissions, start a merge, pass a human gate or switch on
`autonomy.off_hours.level`. `autonomy.off_hours` stays apart from the
person profile and keeps working as it does: it goes on reading the
machine's local time zone, and `autonomy.off_hours.timezone` is not added
until off-hours is validated or a host that runs in UTC needs it.

**Personal quiet hours follow the routine.** A person's chat mentions and
direct messages are held during the routine's modes whose interrupt policy
is `digest` or `none`, or, with no routine, during the profile's explicit
`quiet` window list. The host-level `chat.timezone` and `chat.quiet` remain:
`chat.timezone` keeps the team's shared channels' clock (the digest's date
key among them), and both are the defaults for a person with no profile or
whose profile leaves the field unset.

### 3. What stays out (ruling Q3)

- **Teams and code ownership** are derived, not declared: from
  `CODEOWNERS`, the change-area catalog, `dispatch.person` and the forge's
  and tracker's own permissions ([dispositions](../dispositions.md), derive
  before declaring).
- **Devices and operating systems** are detected on the machine
  (`process.platform`) and enrolled per host on the hub
  ([ADR-0016](ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md),
  [control-plane design](../../design/control-plane.md)).
- **The hub never receives a person's local declarations.** ADR-0016, the
  control-plane design and the priorities design bar it. The hub's one
  identity mapping stays the `chat-link` a person makes with `/jig link`,
  verified by the forge sign-in that `/jig link` runs through the app (ADR-0022). A routine shared across
  hosts through the hub would need an amendment of this record, reviewed
  for its personal-data consequences.

## Alternatives considered

- **Preferences under `serve[]` in the machine file.** Rejected: a
  non-dispatch machine would have to create the file that switches dispatch
  on, an authorization list would carry daily edits, and one typo would stop
  dispatch for everyone the host serves.
- **Preferences in the user layer, `~/.jig/jig.yaml`.** Rejected: it is
  repository configuration, `JIG_USER_LAYER=off` drops it, and a syntax error
  in it fails every repository setting with it.
- **A slug rule on `serve[].name` that derives each profile's path.**
  Rejected: it would break machine files whose names do not fit the rule; an
  explicit `serve[].profile` path breaks nothing.
- **Individual priorities inside the person profile.** Rejected: allocation
  would then fail with any routine typo; the weights file already shows the
  sibling-file shape.
- **A parser per feature.** Rejected: four grammars for one person's week
  would disagree at the edges (overnight windows, daylight saving, gaps).
- **Routine `away` switching on off-hours autonomy.** Rejected: a person's
  absence is no evidence that wider autonomy is safe, and off-hours is not
  yet validated.

## Consequences

### Benefits

- The routine, the Slack channel, the digest and the declared priorities
  start from one contract: one home, one
  reader, one schedule grammar, one precedence rule.
- The machine file stays the dispatch switch and a short authorization
  list.
- A broken routine or profile fails on its own, never taking allocation or
  dispatch with it.
- Schedules behave the same everywhere across daylight-saving changes.

### Costs

- `chat.quiet` changes grammar before the Slack channel ships it, so the chat
  design changes now.
- A multi-person host keeps a profile file per person and names each path.
- The off-hours parser will be refactored into the shared primitive, and its
  tests have to keep the current schedules' meaning.
- Promoting the parser tightens it: a window whose start equals its end,
  which today reads as a whole day from that time, will be refused.

## Implementation

This record changes documents only: the
[priorities design](../../design/priorities-and-overview.md) places the
individual record in its sibling file, and the
[chat design](../../design/chat.md) resolves a person's time zone, quiet
hours and direct messages from the person profile. `schedule.ts`, the
person-profile reader and `serve[].profile` will be built by
[#1403](https://github.com/jig-harness/jig/issues/1403) and the issues that follow it; the Slack channel and the
digest by [#1105](https://github.com/jig-harness/jig/issues/1105) and [#1106](https://github.com/jig-harness/jig/issues/1106).

## Reversal conditions

- **Profiles move into `serve[]`** only if every machine that records a
  preference also dispatches, so the machine file no longer gates anything
  a non-dispatch machine needs.
- **A shared routine across hosts** is reopened only by an amendment that
  reviews its personal-data consequences, after a team asks for one
  person's routine to follow them between hosts.
- **`autonomy.off_hours.timezone` is added** once off-hours is validated,
  or when a host that runs in UTC needs off-hours in a person's zone.
- **A second schedule grammar** is admitted only if a feature needs a
  window the shared grammar cannot express, and then as an extension of
  `schedule.ts`, not beside it.

## Extraction (decisions-become-checks)

The repository has no decision-rules catalog, so each check below is held
by the code that implements it, in its own tests:

- **`serve[]` key strictness**: the machine-file reader
  (`plugin/dispatch/lib/serve-config.ts`) refuses every key but `name`,
  `forge`, `tracker` and, as each ships, `chat.slack` and `profile`. A
  preference key in `serve[]` fails the reader's tests.
- **One schedule parser**: once `schedule.ts` exists, a check fails any
  other module that parses a weekly `<days> [HH:MM-HH:MM]` window or a time
  zone for a schedule; `off-hours.ts` and the chat settings read through
  it. Its tests hold the five invariants above.
- **Fail-closed person-file reading**: the shared reader's tests cover a
  dangling symbolic link, an unknown key, a path Git tracks, and a syntax
  error that leaves the machine file, the weights file and the individual
  priorities file readable.

Review checks the rest, which no pattern can: that a routine mode never
reaches an autonomy level, a merge or a human gate, and that no person
declaration reaches the hub.
