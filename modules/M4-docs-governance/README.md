# M4 — Docs-as-wiki governance (stub)

**What problem this solves.** Documentation trees grow into hundreds of files
nobody can navigate or trust: no lifecycle, stale content indistinguishable
from current, and no defined home for new knowledge — so agents (and people)
re-derive what was already written. This module governs the docs tree like a
living wiki: schema-validated metadata on every doc, a generated index,
an activity log, a promotion pipeline from session notes to durable pages, and
the de-scarring rule that keeps finished documents clean.

**Invariant.** Every doc carries machine-validated frontmatter (type, status,
lifecycle, owner, freshness); navigation is generated, never hand-curated;
knowledge flows raw → compiled → indexed; approved documents are scar-free
(findings live in review threads/issues, not the artifact); conflicts resolve
along a written authority hierarchy.

**Port sources**: docomply `docs/WIKI-SCHEMA.md`, `docs/.frontmatter-schema.yaml`,
frontmatter checker, index generator + freshness workflows, de-scarring rule +
scar lint (C4), retrospection/promotion conventions. Ports in Phase 3.

**Status**: stub.
