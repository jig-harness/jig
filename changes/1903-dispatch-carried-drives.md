---
release: patch
---

### Fixed

- `jig dispatch`: a claimed item whose open pull request's drive is asked for
  but not yet armed (a person's `drive` label, the completed pickup's
  first-drive handoff, or `dispatch.adopt`) is now carried by that pull
  request, shown with its drive waiting to be armed, instead of raised as a
  stalled pickup whose pull request "has no drive" once it idles past
  `dispatch.stalled_after`.
