---
type: prd
status: accepted
reviewed: "someone, 2026-05-04"

# Product requirements: Saved views

The frontmatter opened with `---` but the closing `---` is missing, so the
header/body boundary is ambiguous. The gate must error (exit 2) rather than
guess.
