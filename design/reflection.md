# Reflection stores: design

**What problem this solves.** Session reflection
([`reflect`](../plugin/skills/reflect/README.md) and
[`review-reflections`](../plugin/skills/review-reflections/README.md)) keeps
its records in a store behind a contract, and the plugin ships a filesystem
store: a folder of files that a team can only browse by opening them. A team
that already reads and triages its work in a tool such as Notion or Jira wants
the findings there, filterable and sortable, while the skills keep reading and
writing the same events. This design describes those stores. Everything else
about reflection (the events, the computed state, the journal, the store
contract and its conformance suite) is built and described in the
[reflect README](../plugin/skills/reflect/README.md).

The Notion store is [ROADMAP.md](../ROADMAP.md) item 7; the Jira store is not
planned yet.

Contents: [Notion store](#notion-store) · [Jira store (future)](#jira-store-future)

## Notion store

Keeps reflections in a Notion database that people browse, filter and sort,
while the skills read and write the same events as any other store. It ships
with the plugin as `reflection.store: notion` and works from two settings.

- **Setup.** Create an internal integration in Notion and share a page with
  it. Then `notion-store.ts init --parent <page>` creates the database, its
  properties and its views, and prints the setting to add:

  ```yaml
  reflection:
    store: notion
    notion:
      database: <database id or link>
  ```

  The integration's secret is read from `NOTION_TOKEN`, never from a file.
  `check` reports a missing token, a database the integration cannot see, or
  a database missing properties, each with its fix.
- **Through the REST API.** The store is a script that runs outside the agent,
  so it calls Notion's public API with the integration's token, not the
  agent's own Notion connection. That API pages every database query and
  block listing with a cursor (`has_more`, `next_cursor`), which is what lets
  `list` read every page or fail, and it adds content to a page with an
  append-only call, so a write never rewrites the page body. The store pins
  the API version it is tested against.
- **One page per change.** A page per issue key (else branch) per repository,
  titled `[<repository>] <issue or branch>: <summary>`. Each `reflect` adds a
  section: a heading with the time, the session block as a callout (harness,
  model, Jig version, skills), and each finding as readable text. A decision
  adds a review note under its finding.
- **The record is in the page.** Beside each finding and each decision, in a
  collapsed toggle, is its event as a JSON code block. `list` reads events
  from these blocks and nothing else; editing the prose changes nothing the
  skills see.
- **Properties are a view.** Status, Severity, Classes, Components,
  Repository, Issue, Branch, Pull request, Skills, Harness, Model, Jig
  version, Sessions, First and Last reflected are recomputed from the page's
  events after every write; `repair` recomputes them from the events as
  `list` returns them, so an [id conflict](../plugin/skills/reflect/README.md#ids) settled across pages reaches
  each page, and until then `diagnose` names the pages among the conflict's
  copies. The page Status is `Inbox` while any finding on it
  has no decision, `Approved` while any is approved but not yet merged, and
  otherwise the latest decision, so filters and boards on Status work. A
  property write that fails leaves the events correct; the next write, or
  `notion-store.ts repair`, recomputes the properties.
- **A status changed by hand is kept and surfaced.** The store also writes
  the Status it computed to a hidden property. Before every property update,
  `repair` included, a Status that differs from that hidden one was changed
  by hand: the update leaves Status as the person set it, updates the rest,
  and `diagnose` reports the page until the person records the change as a
  decision (`review-reflections` asks) or puts it back. It is never silently
  overwritten or silently obeyed.
- **Retries and races are harmless.** `append` reads the events on the
  change's page before writing, so a retried event is not added there twice;
  two concurrent writers can still both add one, and `list` returns it once.
  `diagnose` reports different events under one id, on any page. Two sessions
  that create a page for the same change at the same moment leave two pages;
  since state comes from events, `list` merges them by change and later
  writes go to the older page.
- **Fast enough to review often.** `list` keeps a cache in
  `~/.jig/cache/notion/<database>` keyed by each page's last-edited time, so a
  review re-reads only the pages that changed since the last one. Requests
  stay within Notion's rate limit (an average of three a second) and honour
  `Retry-After`.
- **Tested without Notion.** The tests run the conformance suite against a
  local fake of the API endpoints the store uses. A run against a live
  scratch database is opt-in, with a token.

A database must have been created by `init`: the store does not adopt a
database it did not create.

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
  [id conflict](../plugin/skills/reflect/README.md#ids) as the Notion store.
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
