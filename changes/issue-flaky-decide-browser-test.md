---
release: patch
---

### Fixed

- The decision sheet's browser tests no longer fail now and then on a busy machine. After a reload they counted the restored picks at once, before the sheet had shown them; they now wait, up to five seconds, for the first restored pick to appear.
