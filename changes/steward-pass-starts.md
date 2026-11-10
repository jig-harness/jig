---
release: patch
---

### Fixed

- The dispatcher's steward pass now runs on a Claude Code account. Its skill
  was hidden from the `/` menu, and Claude Code refuses a slash-command
  prompt for a skill hidden that way, so every steward pass on a Claude
  Code account ended before it read the digest.
