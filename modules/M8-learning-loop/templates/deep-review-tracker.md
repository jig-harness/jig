# Deep-review tracker

> TEMPLATE — optional; copy next to your [audit catalog](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/templates/AUDIT-CATALOG.md)
> (e.g. `docs/review/DEEP-REVIEW-TRACKER.md`) when you run deep reviews: a
> whole area examined along a fixed list of dimensions (correctness, security,
> accessibility, whatever your areas need). Without it, adding a dimension
> quietly leaves every area reviewed under the old list looking current. When
> you copy it, replace the example dimensions with your own list at version 1,
> delete the example reviews (Billing, Notifications) and delete this note.

## The rule

Each review records the **version of the dimension list** it used. The list
has a version that moves whenever a dimension is added, split or made
stricter. An area is **due** for a re-review when the version it was last
reviewed under is lower than the current one, whatever its date says. Reading
the table answers "which areas were reviewed without dimension X": every row
whose version is below the one that introduced X.

## Dimensions

Current version: **1**

| Version | Change | Dimension |
|---------|--------|-----------|
| 1 | initial list | correctness |
| 1 | initial list | security |
| 1 | initial list | error handling |

Never edit a past row: add a row with the new version, and raise the current
version above.

## Reviews

| Area | Reviewed on | Dimension version | Findings filed |
|------|-------------|-------------------|----------------|
| Billing | 2026-08-03 | 1 | `<tracker-key>` |
| Notifications | 2026-08-19 | 1 | none |

## Queue

Recompute this list when the version moves, and from then on whenever a row is
added: an area is queued when the `Dimension version` of its most recent review
is below the current version. Review the oldest first. A queued area leaves the queue by being
reviewed under the current version, never by editing its row.

- _(empty)_
