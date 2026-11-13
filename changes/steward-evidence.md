---
release: patch
---

### Fixed

- The steward's digest now includes each target's workspace state, bounded
  pass output, linked open and merged pull requests and failing-check
  history on the head and base commits. Unavailable reads remain explicit,
  and pass output is quoted as untrusted data.
- Dispatched passes retain output even without a question, and a steward
  that ends without submitting leaves a cause in the outcome log.
- The steward's durable digest keeps only a redacted, bounded summary of pass
  output, and the output fields of a digest are erased once launch retention
  has passed.
