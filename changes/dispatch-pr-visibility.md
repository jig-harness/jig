---
release: patch
---

### Fixed

- The dispatch dashboard shows current PR state separately from historical drive outcomes, with direct PR and repository links, hover context, and copy controls that copy only IDs. Merged or closed drive decisions leave What needs you after a successful forge refresh; follow-up failures remain visible.
- Copy controls use Lucide icons with accessible labels and feedback. Disclosure controls use rotating chevrons and keep their position when expanded.

- Merged PRs show whether their follow-up is awaiting a slot, starting, running, waiting, blocked, or needs attention, with a summary above the panels.
- Changelog checks during an open base merge allow imported releases while continuing to reject branch edits to release versions and sections.
