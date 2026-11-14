---
release: minor
---

### Added

- `ci.hold_sentinels` names additional checks whose intentional failures mean CI is held while the hold label is present. Held checks spend no repair pass and are judged normally after the hold is released. **Consumer action:** none.
- `ci.advisory_checks` lets a drive park once when only advisory checks fail, offering a repair, a person's waiver, or manual handling without spending a repair pass first. The configuration check warns when the repository disables the required `reviewer-posture` decision class. **Consumer action:** none.
