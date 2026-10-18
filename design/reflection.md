# Reflection stores: design

**What problem this solves.** Session reflection
([`reflect`](../plugin/skills/reflect/README.md) and
[`review-reflections`](../plugin/skills/review-reflections/README.md)) keeps
its records in a store behind a contract. The plugin ships a filesystem store
and a [Notion store](../plugin/skills/reflect/README.md#notion-store), a
database people browse, filter and sort. A team that reads and triages its
work in Jira wants the findings there, while the skills keep reading and
writing the same events. This design describes that store. Everything else
about reflection (the events, the computed state, the journal, the store
contract, its conformance suite and the built stores) is described in the
[reflect README](../plugin/skills/reflect/README.md).

The Jira store is not planned yet ([ROADMAP.md](../ROADMAP.md), Later).

## What every store holds to

Whatever a store keeps its records in, these requirements decide whether the
findings stay useful, and a store is not done until it meets them.

- **`list` is exhaustive.** Naming a finding's class means choosing from the
  classes already in use, and a search that is ranked, capped or paged
  without being followed to its end cannot prove that a class does not exist:
  the reader coins a new name for a shape the store already holds, and one
  recurrence is counted as two classes. A store therefore reads everything or
  exits non-zero; a store whose own search is ranked (a database's text
  search, an issue tracker's query) lists by walking every page of an
  unranked query. The [conformance suite](../plugin/skills/reflect/README.md#the-store-contract)
  includes an exhaustiveness test: it appends a bulk of events (250 by
  default) under a change each and as many again under one change, and
  requires `list` to return every event the store holds, with and without a
  `since`. It finds a page smaller than the bulk, and a cap on the whole
  listing below the events it must hold; an adapter whose backend pages or
  caps above the bulk raises the bulk past that size.
- **The kinds of finding cover what is worth recording.** `kind` is `error`,
  `opportunity` or [`unhelpful-content`](../GLOSSARY.md). The third is instruction text, in an
  instructions file or a skill, that cost context without helping: a section
  the agent loaded and never used, or one that misled it. It keeps the cost
  of always-loaded context ([M0](../modules/M0-instruction-architecture/README.md))
  visible in the same store as the failures, with a class shared by repeated
  reports of the same text.

## Jira store (future)

Not planned yet; the shape a Jira store would take, for when a team that
tracks its work in Jira needs one.

- **One issue per finding,** of a custom issue type (`Agent feedback`) in a
  project the configuration names. A finding is the unit a Jira workflow
  decides on, where Notion groups findings by change for reading.
- **Fields:** custom fields for Class, Severity, Target, Repository, Branch,
  Pull request, Harness, Model, Jig version and Skills, so Jira's own
  filters, boards and dashboards work on them; the change's issue key as an
  issue link.
- **The record:** the finding's event as an issue property (JSON stored on
  the issue, not shown in its fields), and each decision as a comment carrying
  its event. `list` reads the properties and comments; the workflow status is
  a view, kept in step by transitions the store makes after recording each
  decision, with the same hand-edit rule and the same handling of an
  [id conflict](../plugin/skills/reflect/README.md#ids) as the
  [Notion store](../plugin/skills/reflect/README.md#notion-store).
- **Idempotency:** every event's id, a decision's included, in a searchable
  field of the issue that holds it, looked up before writing, so a retry does
  not create a second issue. Two concurrent writers can both create one;
  `list` returns the event once, and the store links the later issue to the
  earlier as a duplicate.
- **Escalation** to an issue in the same Jira links the escalated findings
  to it, so the tracker shows the recurrence directly.
- **Open questions:** whether a project administrator must create the issue
  type and fields (the store's `init` cannot on every Jira plan), and how
  `list` walks every page of Jira's search on a large project within the
  store's deadline, since it may not return a partial set.
