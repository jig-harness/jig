# Audit catalog

> TEMPLATE — copy to your repo (e.g. `docs/review/AUDIT-CATALOG.md`), replace
> the example rows with your own and delete this note. It is the one list of
> the areas of your repository that drift without any check noticing, and of
> when each was last looked at on purpose. Invariant it encodes: **every
> drift-prone area that no gate fully covers has a named cadence, a last-audited
> date and an owner, and an area audited only by hand is tracked as a gap in
> tooling.** Background:
> [M8](https://github.com/jig-harness/jig/blob/main/modules/M8-learning-loop/README.md#the-audit-catalog-areas-no-gate-covers).

## Which areas belong here

An area belongs when it can go wrong without a gate failing, and no gate
catches the whole of it: an architecture diagram that no longer matches the
code, a security posture that depends on settings in a hosted service, a
dependency policy a lockfile cannot express, a set of runbooks nobody has
rehearsed. An area a gate already covers completely does not belong; its row
would only restate the gate. An area a gate covers *in part* belongs, and its
row says which part is left.

## The catalog

Keep one row per area, sorted by `Last audited`, oldest first, so the area least
recently looked at is at the top; rows marked `never` come before every dated
row.

| Area | Owner | Cadence | Tooling | Last audited | Open work |
|------|-------|---------|---------|--------------|-----------|
| Runbooks match the deployed system | `@operations` | quarterly | manual | 2026-04-02 | `<tracker-key>`: script the command extraction |
| Public API reference vs. behavior | `@api` | ad hoc | contract tests cover the shapes, not the prose; audited when a public endpoint changes | 2026-05-20 | none |
| Repository and hosting settings | `@platform` | monthly | manual | 2026-08-14 | `<tracker-key>`: read the settings through the API and diff them |
| Dependency licenses | `@platform` | per release | `license-check` in CI covers declared licenses; vendored and copied code is reviewed by hand | 2026-09-30 (after v2.3.0) | none |

### Columns

| Column | What goes in it |
|--------|-----------------|
| **Area** | The part of the repository or system, named so a newcomer can find it. One row per area, never per file. |
| **Owner** | One person or team, never "everyone". The owner runs the audit or sees that it is run, and answers for a row that goes overdue. |
| **Cadence** | One of `continuous`, `per release`, `monthly`, `quarterly`, `ad hoc`. `continuous` means a check runs on every change or on a schedule short enough that nobody tracks it by date. `ad hoc` is allowed only with a named trigger in the `Tooling` or `Open work` cell (for example, "when the schema changes"); otherwise the area has no cadence and the row is a defect. |
| **Tooling** | The command, workflow or gate that performs or supports the audit, or the word `manual`. A gate that covers only part of the area says what it leaves out. |
| **Last audited** | The date (`YYYY-MM-DD`) an audit of the whole area last finished, never the date of the last edit to this file, or `never` for an area listed but not yet audited. A `per release` row adds the release the audit followed, `YYYY-MM-DD (after <version>)`, so two releases on one day stay apart. Updated in the same change as the audit's findings. |
| **Open work** | The tracker keys of the findings still to fix, or `none`. For a `manual` row, the key of the issue that closes the gap in tooling (see below). |

## Manual rows are gaps in tooling

An area audited only by hand is a gap in tooling, tracked as one: the row's
`Open work` names the issue that would replace the manual step with a check
(or says, with a reason, why it cannot be automated). A manual audit is
legitimate for the area's first rounds, while its rules are still being found,
and it is a cost that repeats every cycle, so the gap stays visible instead of
becoming the permanent way of working. When the check exists, the row's
`Tooling` changes from `manual` to its name, and the cadence usually moves
toward `continuous`.

## Reading the catalog

A `monthly` or `quarterly` row is **overdue** when today is later than
`Last audited` plus a month or a quarter. A `per release` row is checked
against releases, not the calendar: before a release is cut, its `Last audited`
must name the previous release as the one the audit followed, and the release
waits until it does. Before a repository's first release there is no previous
release, so any finished audit counts. `continuous` and `ad hoc` rows are never overdue by date. A row marked
`never` is due at once, whatever its cadence: adding it opens the issue for its
first audit, and that audit replaces `never` with its date. Review the catalog
whenever you plan work: an overdue row is a candidate for the next cycle, and
an audit that finds nothing still moves `Last audited` forward, because "looked
at, and well" is the fact the date records. An overdue row has an open issue,
assigned to its owner, until the audit runs; the issue is what lets a reader
tell a late audit from a forgotten one.

## Changelog

Add a line each time an audit finishes or a row changes, newest first:
`YYYY-MM-DD — <area>: <what was audited, what was found>`.
