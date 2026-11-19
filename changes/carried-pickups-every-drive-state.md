---
release: patch
---

### Fixed

- `jig dispatch` no longer raises a stalled-pickup need for a claimed item
  whose open pull request's drive is parked on a person's question, stopped
  for a re-arm or a re-drive, or undecided for a tick while the forge
  computes its mergeability: the item is reported as carried by the pull
  request, with the drive's state, and the drive's own need is the only one a
  person sees. An item a pull request merged within the last day links is
  not raised as stalled either; its follow-up settles it.
