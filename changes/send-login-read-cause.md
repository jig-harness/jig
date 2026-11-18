---
release: patch
---

### Fixed

- `jig send` names why it could not read the login it would write as: a
  spent allowance with the time it resets, a refused credential, or no
  answer from the forge or the tracker, and that nothing was sent. The
  refusal saying the forge or tracker named no login now appears only when
  it answered without one. `--as` is checked as before.
