---
release: patch
---

### Fixed

- `drive-pr`: a pass that met Claude Code's weekly usage limit now stops the
  drive `QUOTA_PARKED` with the reset the notice states
  (`You've hit your weekly limit · resets Nov 27, 11am (<zone>)`), so the
  dispatcher walls the account until that reset rather than for its
  `wall_backoff`. The drive reads the pass's own transcript by its session
  id, so an account whose transcript tree is too large to walk within the
  scan bounds no longer hides the wall and leaves the pull request stopped
  as an ordinary pass failure. A pass failure whose scan was cut short before
  it found a wall now says so in the drive's closing report, with cause
  `unknown` and a next step that looks for the notice first.
