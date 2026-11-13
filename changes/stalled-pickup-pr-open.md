---
release: minor
---

### Added

- The dispatcher tells a stalled pickup's finished work from abandoned work. When a claimed item has no running session and an open pull request whose head is the branch of this host's launch of the item links it (`Closes <KEY>` or `Refs <KEY>`, as `do-item` writes it), the tick on the host that owns the repository moves the item from its in-progress state to `pr_open`, never to done, and comments on it naming the pull request. An item already in `pr_open` is not reported as stalled while that pull request is open. Where the repository names no `pr_open` state, or the open pull requests did not read, nothing moves and the stall need says why, naming the pull request where there is one. The rule reads the open pull requests the tick already reads, so it makes no forge request of its own; `jig dispatch` lists each move under the repository, and with `--apply` what it did.
