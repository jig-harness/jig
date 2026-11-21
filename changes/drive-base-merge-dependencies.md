---
release: patch
---

### Fixed

- Drive rounds refresh dependencies before validating a base merge that
  changed a package manifest or lockfile. They use a frozen install and report
  its command and outcome, so an install failure is distinguishable from a
  validation failure.
