---
release: patch
---

Jig states one rule for every call it makes to a system it does not control.

### Added

- [ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md): every call to a forge, an issue tracker or a reflection store goes through that system's governed transport, which reuses an answer before it sends, asks a budget the whole machine shares, bounds what one call can cost, records what it spent and fails as one of a closed set of classes. The glossary gains the terms (governed transport, budget record, cost ledger, failure class, cost ceiling), and the roadmap gains the item that builds it. Nothing a repository configures changes with this release.
