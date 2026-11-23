---
release: patch
---

### Fixed

- A drive whose every pass failed to push (a pre-push gate the base branch
  breaks, a remote that rejects the push) no longer stops as a plain
  `STALLED` that the dispatcher re-drives onto the same refusal. The pass's
  `PUSH_FAILED` reason now says why the push failed, a pre-push gate, the
  remote's rejection, the connection, a timeout or an unconfirmed head, and
  quotes the last lines the push wrote. The drive's stop event, its ledger
  and its closing report carry that reason, and the closing report's next
  step sends a person to fix what refuses the push before re-arming. The
  dispatcher reads the stop as a person's need, with that reason, instead of
  re-driving it once per head. **Consumer action:** none.
