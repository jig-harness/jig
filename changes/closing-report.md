---
release: minor
---

### Added

- Every pickup, follow-up and steward pass the dispatcher starts now ends by writing a closing report: a short `closing-report/v1` record of what the run concluded, the next step and who takes it, a question with its framed decision when a person must decide, why it fell short when it did, and up to 10 references as evidence. The pass records it with the new `jig dispatch report <record> <token> <file>`, which its prompt names beside `jig dispatch result`. The command replaces email addresses, account identifiers and tokens or other credential-shaped values with `<redacted>`, checks the record and names everything wrong in one refusal; it may run more than once, before or after the result, the last report that passes standing, and it never changes the result. The launch record keeps the report whole, and the outcome log's `ended` row carries its fields and who wrote it (`by`), with `cause` and `by` as new columns of the log. A pickup now records its result as soon as its drive is armed and writes its report at the end. See [plugin/README.md](../plugin/README.md#the-closing-report).

### Changed

- The steward digest's kept summary of a pass's output now also replaces JSON Web Tokens, using the same list of credential shapes as the closing report.
