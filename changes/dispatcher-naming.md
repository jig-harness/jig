---
release: minor
---

### Added

- The dispatcher names what it starts, so a dispatched workspace is told from a person's at a glance on the board. A workspace it creates is named for the stage and the key (`⚙ dispatched · pickup #123`, `⚙ dispatched · rearm #456`, `⚙ dispatched · followup #789`), and its comment carries the [dispatched mark](../GLOSSARY.md), that name and the launch record's id; a workspace it reuses keeps its name and gets the mark added to its comment once. Each session's terminal tab reads `jig dispatch · <stage> <key>`, and the notices workspace is `⚙ dispatched · notices`. The launch record keeps the mark, and a notification that rewrites a comment keeps it, so a workspace a session renamed is still known as dispatched. The convention lives in the dispatcher's runtime interface (`dispatch/lib/runtime/port.ts`), one place every runtime takes its names from.
- The morning report (`drives.ts --report`) lists the workspaces the dispatcher launched into since the report's time, found by the mark on their launch records, each with the name it carries now and whether its comment still carries the mark (`dispatchedWorkspaces` with `--json`).

### Changed

- A workspace the dispatcher creates takes its Orca name, and so its folder's name, from the dispatched name rather than from its branch; the branch is still the one the repository's branch rule names.
