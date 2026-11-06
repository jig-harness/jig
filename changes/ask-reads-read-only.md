---
release: patch
---

### Fixed

- `jig ask` no longer migrates the machine's databases. It opens the dispatcher's state database (launch records and outcome log) and the drive's database read-only, so a command anyone can run at any moment never decides when the owner's database moves to a newer schema. Against a database an older schema holds, it reads what that schema allows or names the source in `sources` as not read, saying the owner's next run brings it forward. The dispatcher's and the drive's own runs keep their additive migrations.
- `drives-read-only.ts --json`, the drive's listing for a reader that is not a driver, lists the drive's locks without creating, migrating or importing into the drive's database: a database that is already current is listed as it is, none is no drives, and one a driver must first bring forward is declined with exit 4 and the reason on stderr.
