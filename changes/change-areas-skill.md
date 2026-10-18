---
release: minor
---

### Added

- The [`change-areas` skill](../plugin/skills/change-areas/README.md)
  (`/jig:change-areas`) resolves a change against the repository's
  change-area catalog (`drive.change_areas_catalog`): which areas it
  touches, and what it owes — the checks to run before a push, the mandatory
  reviews, the tracker labels and flags, the steps after a deploy. It prints
  JSON with the validation plan that `drive.validation_plan_command`
  expects, GitHub Actions outputs (`<area>=` for the closure, `<area>-seed=`
  for the direct match), a dorny/paths-filter spec, a post-deploy checklist
  and a review-gate table, and checks the catalog: its schema, the
  `impliedBy` graph, the workspaces and each generator's outputs and
  sources. A push resolves every commit it carried (the event's `before`,
  or `--before`), `--files -z` reads paths separated by null bytes, and a git command
  has a deadline. A repository whose catalog needs more than the generic schema
  runs it through a [composer](../GLOSSARY.md), its own short script that
  adds its fields, outputs and validation policy.
- `review` resolves the catalog with the `change-areas` resolver when the
  repository declares a catalog but no `drive.validation_plan_command`
  (`--no-validation`, so a catalog without validation profiles still routes
  its reviews), and reports any resolver failure, an unknown field included,
  as a blocking catalog finding.

### Changed

- [M3](../modules/M3-change-area-catalog/README.md) states the corrected
  design the resolver implements. Tracker flags are read from the seed
  areas, like tracker labels; mandatory reviews (`review.skills`) are read
  from the closure. A change to a generator's `generated[].source` seeds its
  owning area for every projection, not only the freshness check.
  Validation profiles are declared in the catalog under `profiles:`,
  shallowest first, and an area without one, like a file no area matches,
  gets the deepest, which must list at least one check. Every file of a
  workspace is matched by its own area's paths, not some other area's; a
  workspace with no files yet is covered when one of those paths could
  match a plainly named file in it (letters, digits, `_`, `-` and `.`,
  neither starting nor ending with `.`, and no Windows device name such as
  `CON`), and a workspace is written as git lists paths
  (`apps/web`).
  Closed value lists for `category`, `deployTier`,
  `agent`, tracker flags, post-deploy environments and profiles are declared
  under `vocabularies:`; without one a field takes any text.
- **Breaking:** the catalog field `validation.needsSandbox` is removed. A
  catalog that declares it fails the `change-areas` schema check: remove
  the field, or, where agents must run some changes on a CI-identical remote
  machine, declare the field in the repository's composer and compute that
  requirement in its validation plan, from the seeds' closure.
