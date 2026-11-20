---
release: minor
---

### Added

- Pickup passes can wait for a pull request to merge or a tracker item to
  close. The dispatcher shows the dependency and resumes the pickup when
  it clears. A pull request that closes unmerged raises a need.
- Set a conditional pickup hold with `jig send … hold --until-merged` or
  `--until-closed`. Choosing a pickup's framed option to wait for a pull
  request to merge also places a hold.
