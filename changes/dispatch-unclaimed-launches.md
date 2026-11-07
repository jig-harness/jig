---
release: patch
---

### Fixed

- `jig dispatch` no longer leaves a launch the session runtime answered as started, but whose wrapper never claimed its launch record, holding its stage and an account slot with no notice. Once the machine file's new `unclaimed_after` (default `15m`) has passed since that answer, the record is reported as stuck: notified to a person as needing them (cause `needs-person`, once, then on `dispatch.renotify_after`), shown on the dashboard as needing a person, and released with `jig dispatch clear <record>`. A record claimed within `unclaimed_after` is never flagged. When the runtime reports a session joined to the record's target, the notice says so, since that wrapper may have started its stage without claiming the record; the slot is never freed automatically.
