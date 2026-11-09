---
release: patch
---

### Fixed

- A reply left on an open human review thread now counts as progress for the
  drive’s stall check.
- Head mismatches now distinguish an unpushed local head, delayed API data,
  and diverged history, with the action each needs.
- A held summary finding re-emitted in a later drive review round now
  contributes to the repeated-file escalation signal.
- Status now identifies unaddressed summary findings held without a push stamp
  and names the steps to verify and dispatch their answers.
