---
release: patch
---

### Fixed

- The records inventory (`plugin/RECORDS.md`) says the drive ledger is written at version 2, envelope and `ledgerVersion` alike, when it records a person's stop, and at version 1 otherwise; and it names the tracker claim marker among the records that carry the record envelope.
- The mechanisms map (`plugin/MECHANISMS.md`) says what happens to a failed follow-up: one that stopped on a routine question runs once more with the class's standing answer, and any other waits on a person, whose **Run it again** deletes its marker and **Record it done** marks it done.
- The plugin README's `jig ask` field table lists every act a station can wait on a person for under `waitsOn`, as `jig ask` prints them, and a test fails when that list and the code's disagree.
- GLOSSARY.md has one entry for the files `jig gc` and Jig's plugin for Orca share, **Launch guard record**, which the documents now use throughout, and an entry for the **Line**, the row of stations a work item passes through.
