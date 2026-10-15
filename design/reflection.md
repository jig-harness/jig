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
  `list` stays complete within Jira's search paging limits on a large project.
