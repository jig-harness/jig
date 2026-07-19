# M8 — Learning loop (stub)

**What problem this solves.** Checklists, reviewers, and gates freeze at the
day they were written; the same class of miss recurs because nothing turns a
miss into a check. This module packages the miss→lens flywheel, the eval
corpus that makes process improvements regression-tested, and the
reflection/memory-promotion cycles.

**Invariant.** Every significant miss (by a reviewer, gate, or agent) is
classified against a taxonomy, filed with a durable identifier, reconstructed
as a replayable eval fixture, and answered with an additive lens; fixtures
join the regression corpus only after live validation; lenses are kept or
killed by measurement; scaffolding changes from reflection require human
approval.

**Port sources**: docomply `docs/development/ai-tools/miss-to-lens-flywheel.md`
(C5), eval-harness shape (`tools/ai/eval/`), parity-tracker shape
(`tools/ai/parity/`), reflect / review-reflection-feedback / promote-memory
command patterns. Ports in Phase 4.

**Status**: stub.
