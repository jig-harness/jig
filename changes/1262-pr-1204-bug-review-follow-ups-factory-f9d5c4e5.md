---
release: patch
---

### Fixed

- Dispatcher epic width limits now cover factory assignments and every parent of nested work. Factory epics start eligible children through an explicit inherited claim, while directly assigned children share the same width reservations as inherited work.
