# M10 — Environments & deploy (stub)

**What problem this solves.** "It merged" and "it works where users are" are
different facts; conflating them ships breakage. This module covers the
verify-then-promote pipeline architecture and the environment kit that makes
testing real: ephemeral preview environments and a seeded test-data factory.

**Invariant.** CI architecture separates PR gates → post-merge verification
(advancing an explicit "verified" pointer, with a watchdog) → deploy of
verified artifacts → manual, gated promotion to production; preview
environments are disposable and cheap; realistic test data is generated,
multi-tenant-isolated, and resettable.

**Port sources**: docomply four-workflow CI/CD architecture, verified-pointer
+ freshness watchdog, spawn-env pattern, test-data-factory concept
(genericized). Ports in Phase 5.

**Status**: stub.
