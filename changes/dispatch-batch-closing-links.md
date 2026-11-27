---
release: patch
---

### Fixed

- The dispatcher reads up to 100 closing issue references per open pull request and keeps confirmed issue links available when another pull request's references are incomplete. Claimed issues with a known carrier can still be marked as carried.
