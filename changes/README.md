# Change notes

A pull request records what it changes for a reader in a **change note**: a
small Markdown file in this folder, one per pull request, named after the
branch or the change (`changes/notion-store.md`). It never edits
[CHANGELOG.md](../CHANGELOG.md) or the plugin's version. After the merge, the
release step (`scripts/release.ts`, run by `.github/workflows/release.yml`)
writes every note into the changelog, moves the version when a note asks for
it, tags the release and deletes the notes. Two pull requests then never
edit the same lines, so merging one does not put the others in conflict.
Why: [ADR-0004](../docs/adr/ADR-0004-change-notes-released-after-the-merge.md);
the practice is [M12](../modules/M12-parallel-agent-ergonomics/README.md)'s.

## Writing one

```markdown
---
release: minor
---

One or two sentences that sum up the release, when it needs them.

### Added

- What was added, written for someone who uses Jig: what it does and where
  it is. Mark a change that breaks something a consumer relies on as
  **Breaking**, and say what the consumer changes.

### Fixed

- What was wrong, as the user saw it, and what happens now.
```

- **`release`** is `patch`, `minor` or `major`, as
  [semantic versioning](https://semver.org) names them. Every pull request
  that changes `plugin/` asks for one (`bun run gates` fails otherwise):
  machines receive the change only through a new version. Before 1.0.0 a
  breaking change asks for `minor`. Leave the front matter out when nothing
  under `plugin/` changes: the note then goes under **Unreleased**.
- **The sections** are
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)'s change types,
  each a `###` heading with a list: `Added`, `Changed`, `Deprecated`,
  `Removed`, `Fixed`, `Security`. Each change is one list item, however many
  lines it takes.
- **The text before the first section** is the release's summary, so only a
  note with `release` may have one. The notes waiting when the release step
  runs are one release, at the largest bump any asks for; their summaries
  are joined in the order the merges landed, then by file name, and so are
  their items under each type.
- No `#` or `##` heading: the release step writes the version and its date.
- Links are relative to the note, as in any Markdown file here
  (`[M12](../modules/M12-parallel-agent-ergonomics/README.md)`); the release
  step rewrites them for CHANGELOG.md and leaves a link shown as code alone.
  Write links inline: a reference definition is refused, since every note's
  labels would share CHANGELOG.md's.
- A note holds headings, list items, paragraphs, inline links, code spans and
  emphasis, nothing else: no code block, raw HTML, quote, table, image or
  line of only `=` or `-`. Each could change how CHANGELOG.md renders after
  the note. Bun's Markdown parser reads the note, so what it reports as
  another kind of element is refused, wherever the construct sits.

`bun run gates` reads every note the way the release step will, and fails
a branch that edits the changelog's Unreleased or release sections or moves
the version itself. Correcting an earlier release's text stays a direct
edit to CHANGELOG.md.

To see what the release step will write without writing it:

```sh
bun scripts/release.ts --dry-run
```

It writes every waiting note as one release, since the tree it releases
already holds the code of every merge that landed before it ran.
