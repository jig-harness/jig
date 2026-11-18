---
release: minor
---

### Fixed

- Untagged releases of one repository that share a remedy now reach a person
  as one need instead of one card per version. The need lists every version,
  `jig ask --waiting` counts it once, and one answer on the tracker item it
  names covers them all. A version leaves the list when it gets its tag, and
  the need goes with the last one. Releases whose one re-run of the failed
  gates was requested form their own need, and any such release is offered
  only **Investigate** and **Tag it by hand**. Each release keeps its own
  record and tracker item.
