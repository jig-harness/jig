---
release: minor
---

### Added

- The `file-issue` skill (`/jig:file-issue`) files a tracker issue from the discussion, or plans an existing one (re-labels it, splits it into sub-issues, records its relations). It writes a durable issue body, derives the labels from the change-area catalog's tracker labels of the areas a diff touches directly (else from the description), searches for a duplicate, checks every label set against the repository's label taxonomy and asks before it writes, all through the tracker scripts ([README](../plugin/skills/file-issue/README.md)).
- `validate-labels.ts` in the `file-issue` skill checks one issue's labels against the label taxonomy: an unknown label, no type or two, two labels of one group or none of a required group, and a facet without the label it requires are refused; `--check-tracker` also refuses a label the tracker lacks or has more than one of, matching names exactly as the tracker adapter does. A label is checked as it will be written: an empty one or one with whitespace around its name is refused, not trimmed.
- The label taxonomy schema gains optional `groups` (single-select families such as a size or a repository, optionally required) and `categories` (prefixed multi-select families, optionally open to any slug matching a pattern, with `max`, `recommended` and `requires`), and a flag may declare `requires_category`. [M9's template](../modules/M9-tasks-memory/templates/label-taxonomy.yaml) shows one of each.
- The [tracker interface](../GLOSSARY.md) gains creating, updating and searching issues, listing the labels an issue can carry, and reading and recording relations; the Linear adapter implements them, and `do-item`'s `tracker.ts` exposes them as `create`, `update`, `search`, `available-labels`, `relations` and `relate` ([EXTENDING.md](../plugin/EXTENDING.md#issue-tracker)).
- `issue_tracker.taxonomy` names the label taxonomy (default `label-taxonomy.yaml`); the audit's configuration check reads the file it names, counts group and category labels as defined, and checks `issue_tracker.labels.batch_sizes` against the group labels alone.

### Changed

- **Breaking** for a repository that runs M9's label-taxonomy lint from a Jig checkout: it moved from `modules/M9-tasks-memory/reference/label-taxonomy-lint/` to `plugin/skills/file-issue/scripts/check-label-taxonomy.ts` and no longer needs `lib/`; point the CI step at the new path ([mappings](../modules/M9-tasks-memory/mappings.md)).
- **Breaking** for a label taxonomy whose entries carry a key the schema does not list (anything but `notes` beside the documented fields): the lint now refuses it, so a misspelt rule is never read as absent. Remove or rename the key. The lint also refuses a type, flag or group label that begins with a category's prefix.
