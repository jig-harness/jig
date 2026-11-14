---
release: minor
---

### Added

- `file-issue`'s weekly sweep keeps a read position between runs when it only
  comments (`file_issue.sweep.move: false`): `check-fields.ts check --yes
  --position <file>` saves where the run left off, oldest issue first, and the
  next run resumes there, going on from the oldest issue at the end. A
  population larger than one run's read of 20 pages of 100 is now reached in
  turn, and an issue whose missing facets changed is commented on again when
  the read comes round to it. Keep the file between scheduled runs (a file on
  the host, or a CI cache); without it every run reads from the oldest issue.
