# M5 — ADR practice (stub)

**What problem this solves.** Significant decisions get made in chats and PR
threads, then lost — so they get re-litigated, or worse, silently violated by
code written months later. Architecture decision records (ADRs) fix the
memory problem; this module also closes the *enforcement* gap: decisions that
can be checked mechanically become checks.

**Invariant.** Decisions are numbered, immutable-once-approved records with
enforced metadata (decision date, supersedes/superseded-by); numbering
collisions are mechanically prevented; evolution happens by amendment or
supersession, never silent rewrite; and each ADR is triaged for
"decisions-become-checks" extraction (a rule pattern a gate can verify — see
M1).

**Port sources**: docomply `docs/adr/` conventions, ADR-number gate,
ADR-to-code-rules extraction (`adr-rules.yaml` + checker), amendment
discipline. Ports in Phase 3.

**Status**: stub.
