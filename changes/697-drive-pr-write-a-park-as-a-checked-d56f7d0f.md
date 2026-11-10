---
release: minor
---

### Changed

- **Breaking:** New drive parks accept checked `parked-decision/v1` JSON on stdin instead of Markdown. Update custom park writers to the JSON contract; existing parked Markdown decisions remain readable. Parks now retain structured options and their optional details across the ledger, dashboard and `jig ask`, support conversion from decision sheets, and refuse decisions above 8 KiB or beyond the ledger's comment budget.
