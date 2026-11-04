---
release: minor
---

`jig dispatch dashboard` is now the page that answers what needs you, what is
running, what is coming and how it went.

### Added

- The dashboard's top half: what needs a person, with the question and the
  recommendation in place and the whole decision one tap away; each account's
  slots and the sessions in them, with their evidence; and what comes next,
  ordered by what will happen. Each panel says which tick it is as of, and a
  stopped timer, a server that stops answering and a refused token each have a
  state of their own.
- The log's filters are the page's address, so a view on a phone is a link a
  laptop opens. Class counts ignore the class filter, so another class can still
  be chosen, and each bad class that recurs on a repository over the last seven
  nights is named.
- Each tick that reads every repository in the machine file writes the line to
  the state database (`tick_line`, schema version 4), and a receipt says so when
  it could not, with exit `1`. A host can serve the page from a copy of that
  database alone.

### Changed

- **Breaking** for a tool reading the server directly: `GET /rows` answers
  `{ ok, value }` or `{ ok, failure: { code, reason } }`, and its `counts` ignore
  the class filter. A database at the new schema version is refused by an older
  plugin, as every schema change is.
