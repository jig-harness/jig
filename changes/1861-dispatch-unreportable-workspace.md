---
release: patch
---

### Fixed

- `jig dispatch` no longer drops a stopped or parked pull request off the line's needs when a workspace joined to it has a terminal whose agent the session runtime cannot report, such as an idle shell or an editor. Its notification still goes out; a re-arm or takeover it cannot safely start becomes a need that names the workspace, and closing the terminals that run no agent lets the next tick act on it. A stopped pickup's need goes out the same way, and an agent the runtime reports working now holds its target even beside such a terminal. **Consumer action:** none.
