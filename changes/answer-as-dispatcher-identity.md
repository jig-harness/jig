---
release: patch
---

### Fixed

- A person who shares a forge login or tracker user with their host's
  dispatcher can now answer its stopped-drive, follow-up and pickup cards with
  `jig send`. The dispatcher still ignores its own identity's comments, except
  one carrying the record `jig send` writes for that identity, the decision's
  key and current digest and the option chosen. `jig send` to a tracker item no
  longer refuses on the host that owns the repository: the comment carries that
  record. An answer typed by hand under the shared identity is still not read,
  and the card says why.
