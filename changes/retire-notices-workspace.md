---
release: minor
---

### Added

- `jig dispatch` removes a repository's notices workspace (`⚙ dispatched ·
  notices`) once it has done its job: when it has been read for
  `dispatch.notices_linger` (an hour by default; `0s` removes it at the first
  tick that finds it read), or when every cause it carries is gone while it
  is still unread. A workspace holding a comment, an agent, changes or a
  commit of a person's is left in place and reported. A new notices
  workspace opens without running the repository's create hook and with
  its terminal closed, so the card holds only its message and nothing a
  hook installs keeps it from being removed. The next message that needs one opens it again; nothing already
  sent is sent twice. Unknown unread marks reset the read linger, and causes
  whose targets could not be observed keep their unread notice. Safety
  refusals found during the final runtime read are reported as refused.
