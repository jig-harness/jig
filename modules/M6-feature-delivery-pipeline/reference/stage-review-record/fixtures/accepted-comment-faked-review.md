---
type: prd
status: accepted
reviewed: true # Alice, 2026-07-20, #123
---

# Product requirements: Saved views

YAML parses `reviewed:` as the scalar `true` — the reviewer, date, and ref are
an inline comment, not a review record. The gate must strip the comment and see
`true` (a bare boolean, no anchor), so this must FAIL.
