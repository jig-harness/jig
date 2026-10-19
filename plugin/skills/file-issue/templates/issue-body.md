<!--
  Issue body for an issue filed by /jig:file-issue. Copy the sections that
  apply; drop a section marked "when …" when its condition does not hold, and
  replace every <placeholder> before the issue is written. Guidance:
  https://github.com/jig-harness/jig/blob/main/plugin/skills/file-issue/README.md#a-durable-issue-body
-->

**Category**: <one of the repository's `review.taxonomy.categories`, or
`unknown`>

## Problem

<What is wrong or missing, and for whom. For a bug: what happens now, what
should happen, and how to reproduce it.>

**Why now:** <the impact, and why it matters at this priority>

## Desired behaviour

<What the system does once this is done, in behaviour a reader can observe:
inputs, outputs, error cases, edge cases. Name the stable things the change
touches (types, interfaces, endpoints, configuration keys, table and column
names, decision records), not file paths or line numbers: the code will have
moved by the time someone picks this up.>

## Acceptance criteria

- [ ] <one independently checkable condition: the command, test, query or
      observable result that proves it>
- [ ] <another>
- [ ] The repository's gates pass.

## Out of scope

- <adjacent work this issue deliberately leaves alone, naming the issue that
  owns it when one exists>
- <or: "Nothing adjacent; the acceptance criteria are the whole boundary.">

## Pattern (when the issue is a bug of a recurring class)

**Class:** <one sentence naming the underlying class of defect>

**Why it recurs:** <a copied template, a missing check, a rule not enforced>

**Other occurrences:** <each one found, or "none found" with how it was searched>

## Human decision (when the issue carries the human-in-the-loop label)

<What a person must decide or review before the autonomous part can go on,
and who: the stakeholder its facet label names.>

## Operator checklist (when the issue carries the manual-operations label)

<!-- Every item is a concrete step a person performs outside the code after
     the merge; never publish these placeholder lines. -->
- [ ] <step, where it is performed, and how its success is checked>

## References

- <parent issue, related issues, decision records, design documents>
