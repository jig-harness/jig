---
release: minor
---

### Added

- The workspace launcher supports GitHub Issues beside Linear, including issue numbers, keys and web addresses, with repository routing and separate context caches for each GitHub repository.

### Fixed

- Launcher cache files and Herdr kickoff claims use `issue-123` for a GitHub key such as `#123`, while preserving team keys.
