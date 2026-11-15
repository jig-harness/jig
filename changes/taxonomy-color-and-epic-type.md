---
release: minor
---

### Added

- A label taxonomy entry may carry `color`, the colour its label shows in the
  tracker, as six hex digits (`cfd3d7`, no `#`), so a colour that sets one
  label apart is recorded and does not drift. `check-label-taxonomy.ts` fails
  on a colour that is not six hex digits as a text; M9's template documents
  the field.
- `validate-labels.ts` reads an issue's own tracker type, from
  `--native-type` or the `nativeType` of the issue it is given. An issue
  whose type `issue_tracker.labels.epic_types` lists, such as Epic, is
  checked as if it carried the epic label: a `requires:` naming that label
  is met by it, and a group not required on the epic is not required on it.
  A `roadmap` issue typed Epic needs no `epic` label beside it.
