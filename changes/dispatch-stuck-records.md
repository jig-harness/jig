---
release: patch
---

### Fixed

- `jig dispatch` no longer leaves a pending launch record that no tick will launch again looking like an ordinary pending launch. A record whose two launches both went unanswered is now notified to a person (cause `needs-person`, once, then on `dispatch.renotify_after`) and shown on the dashboard as needing a person, with why and the `jig dispatch clear <record>` that releases its slot.
- A follow-up whose marker was posted but whose launch never ran, because the tick stopped before the runtime answered, is launched again at the next tick under the same launch record, token and marker, once a fresh read finds its marker still the earliest trusted one naming it, no hold label and no session joined to the pull request. When that read finds otherwise, the record is notified as needing a person instead, and no second follow-up starts for the pull request while it holds it. Such a record could previously only be found by reading the launch records, and `jig dispatch clear` refused it.
