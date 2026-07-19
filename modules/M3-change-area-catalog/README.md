# M3 — Change-area catalog (stub)

**What problem this solves.** "What kind of change is this, and what must
happen because of it?" — which CI jobs run, which reviews are mandatory, which
deploy tier applies — usually lives as duplicated path-lists scattered across
CI configs, docs, and reviewer habits, which then disagree. This module makes
that mapping a single machine-readable catalog (path patterns → implications)
from which every consumer view is generated.

**Invariant.** One validated catalog file maps path patterns to implications;
consumers (CI selection, review-gate tables, tracker labels, deploy tiers)
are generated projections and never re-hardcode the patterns. Any
hand-maintained shortcut (e.g., a fast-path regex in CI) is mechanically
checked against the catalog.

**Port sources**: docomply `tools/change-areas/` (catalog.yaml, schema,
resolver, emitters) + the regex-mirror sync guard. Ports in Phase 3.

**Status**: stub — no content beyond this README yet.
