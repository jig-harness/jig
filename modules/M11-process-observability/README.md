# M11 — Process observability (stub)

**What problem this solves.** Teams instrument their product but not their
process: nobody knows the review-adoption rate, gate pass rates, CI duration
trends, or what the AI reviewer costs vs catches — so process decisions run
on vibes. This module instruments the delivery system itself.

**Invariant.** The delivery process emits telemetry (review outcomes and
costs, gate results, cycle times); automated-reviewer quality is measured
against external oracles (parity, missed-blocker rates) before autonomy
increases; dashboards make process drift visible; measurements drive
promote/demote decisions for gates and lenses (with M8).

**Port sources**: docomply per-review telemetry events, weekly parity
reporting, reviewer cost accounting. Ports in Phase 5.

**Status**: stub.
