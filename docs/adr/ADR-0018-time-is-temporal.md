---
title: "ADR-0018: Time is Temporal, and a Date is a boundary type"
type: adr
status: draft
description: "Jig's runnable code reads the clock, parses and writes moments and does calendar arithmetic with the Temporal API, through one small helper module; a Date stays only where a library hands one over, and a ratchet counts the rest down"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-12
owner: maintainers
decision_date: 2026-11-12
supersedes: ~
superseded_by: ~
tags: [adr, toolchain, time]
---

# ADR-0018: Time is Temporal, and a Date is a boundary type

**Status:** Draft · **Date:** 2026-11-12 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's runnable code is full of time: records stamped with when they were
written, leases and backoffs compared against the clock, the dispatcher's
weekly and off-hours rules on the host's calendar. JavaScript's `Date` does
this badly. It is mutable, it counts in a host time zone it cannot name,
`Date.parse` guesses at any string it is given (a date alone is UTC, a
date-time with no offset is local, and an invalid string is `NaN` to be
remembered at every call site), and calendar arithmetic is hand-written
millisecond sums that are wrong across a daylight-saving change.

[Temporal](https://tc39.es/proposal-temporal/) replaces it: an `Instant` is a
moment, a `ZonedDateTime` a moment on a named calendar, a `PlainDate` a day,
a `Duration` a length, all immutable. Node 26 and Bun 1.4 ship it without a
flag, TypeScript types it in the `ESNext` library, and the plugin already
requires the Bun version Jig tests
([plugin/README.md](../../plugin/README.md)), so the code that ships to
consumers can use it. Bun's test clock (`setSystemTime`) moves
`Temporal.Now` with `Date`, so tests that pin the time keep working.

## Decision

Runnable code in Jig (the plugin, the tools, the scripts and the reference
gates) reads the clock, parses and writes moments and does calendar
arithmetic with Temporal.

- **One helper module,
  [plugin/shared/time.ts](../../plugin/shared/time.ts).** It holds the
  conversions the rest of the code needs: the current time in epoch
  milliseconds and as an ISO 8601 string, an ISO string from milliseconds, a
  parse of an ISO string. Strings are written with **millisecond precision**,
  as `Date.toISOString` wrote them, because `Temporal.Instant.toString` adds
  nanosecond digits by default and every stored record and every comparison
  against one depends on the width. Parsing is strict about shape and
  lenient only where Jig meets the forms it meets (an offset or `Z`, a
  space for the `T`, a date alone, no offset meaning UTC); a string it does
  not read is `NaN` from `parseMs`, so a caller's finiteness guard still
  holds.
- **A moment is a `Temporal.Instant`** where code passes one around; plain
  epoch milliseconds stay where code only compares and adds, and the
  injectable `Clock` ([plugin/shared/clock.ts](../../plugin/shared/clock.ts))
  keeps reading them. A calendar field comes from a `ZonedDateTime` or a
  `PlainDate`, never from `getUTC*` arithmetic.
- **A `Date` is a boundary type.** One may arrive from a library (a YAML
  timestamp, a file's modification time) and is converted at once; none is
  built inside Jig's own logic.
- **Reference gates stay self-contained.** A module's `reference/` script is
  copied into other repositories, so it uses Temporal directly and keeps its
  own tiny conversions, rather than importing the plugin's helper.
- **Browser code stays on `Date`** (the dashboard and the website's client
  scripts) until the browsers its readers use all ship Temporal.
- **Generated code is not migrated.** A script that Jig writes out for
  another runtime to run (a hook's text, the audit sheet's page script) keeps
  the form that runtime reads.

## Alternatives considered

- **A date library** (date-fns, Luxon, Day.js): declined. The plugin may
  vendor only single-file builds
  ([ADR-0001](ADR-0001-bun-typescript-toolchain.md)), and the platform now
  has what these libraries filled in.
- **Keep `Date` and fix call sites as they break**: leaves the parse and
  daylight-saving hazards where they are and gives a new contributor, human
  or model, two styles to choose between.
- **Replace epoch-millisecond arithmetic with `Duration` throughout**: a
  millisecond constant added to a millisecond clock is clear and cheap; a
  `Duration` there adds a conversion for no gain.

## Consequences

### Benefits

- A time zone is named where it matters (the dispatcher's calendar rules)
  and absent where it must not matter (stored records are UTC `Instant`s).
- An invalid moment is a value (`NaN` from `parseMs`) or a thrown
  `RangeError`, never a `Date` whose methods answer `NaN`.

### Costs

- Temporal is stricter than `Date.parse`, so a record written in a shape
  `Date.parse` forgave but `parseInstant` does not (`Tue, 12 Nov 2026`, `2026/11/12`)
  now reads as invalid.
- `Temporal.Instant.fromEpochMilliseconds` rejects a fractional or `NaN`
  argument where `Date` truncated or produced an invalid date, so the helper
  truncates and the rest of the code passes whole milliseconds.
- A test that stubs `Date.now` no longer controls the code; it pins the time
  with `setSystemTime` or the injected `Clock`.

## Extraction (decisions-become-checks)

The `legacy-time` counter in
[tools/quality/ratchet.jsonc](../../tools/quality/ratchet.jsonc), which
`bun run quality` runs, counts `new Date(`, `Date.now(` and `Date.parse(` in
runnable code outside the browser's, the prototypes and the tests, and fails
a change that raises any of the three. It reads text, so a mention in a
comment counts and a `Date` built through an alias does not.
