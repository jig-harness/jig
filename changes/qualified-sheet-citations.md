---
release: minor
---

A decision sheet or an explainer sheet can now cite a fact of another
repository, and the freshness guard checks it against that repository.

### Added

- **Qualified citations.** `beta:ADR-0002` and `beta:apps/api/auth.ts#check`
  name a file or an ADR of the repository `beta`. Each is checked against a
  clone of `beta` at the commit recorded for it in the new
  `verifiedAt.repositories` of the sheet source (`{ "beta": "<commit>" }`). To
  use the form, a consumer configures the clone in `.config/jig.yaml` (or
  the user file, for a per-machine location) as
  `sheets.repositories: { beta: ../beta }`, a map from the name to the
  clone's folder.

  A qualified citation whose name has no configured clone or no recorded
  commit fails `validate` and `render --require-fresh` with a message naming
  the missing piece, instead of being skipped.

### Fixed

- A citation of another repository's ADR was only expressible as a bare
  `ADR-NNNN`, which the guard resolved in this repository: when both number
  their ADRs from `ADR-0001`, it checked the wrong file and reported the
  citation as checked. A bare `ADR-NNNN` still means this repository; cite
  the other one with its name.
