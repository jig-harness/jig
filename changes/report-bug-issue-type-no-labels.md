---
release: patch
---

### Fixed

- `/jig:jig`'s bug reporter now creates the Jig bug it files with the issue
  type Bug in the same call, instead of in an edit afterwards, and files it
  with no `bug`, size or priority label, which Jig's repository keeps in
  fields. A draft that carries such a label (a type, a priority or a size) has
  it dropped, and the reporter says which. Where the account cannot set issue
  types the report is still filed and the reporter says the type was not set.
