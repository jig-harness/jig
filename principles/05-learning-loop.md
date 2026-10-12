# 5 — Learning loop built in

A delivery system that doesn't learn from its misses decays into ritual.
Groundwork ships the learning machinery as a module (M8) and applies it to
itself:

- **Miss → lens**: when a reviewer, gate, or agent misses something an
  external oracle (another reviewer, a human, production) catches, the miss is
  classified against a taxonomy, filed with a durable number, reconstructed as
  an **eval fixture** (the exact pre-fix state, so the catch is replayable),
  and turned into an **additive lens** — a new checklist bullet, prompt
  module, or gate. The fixture joins a regression corpus only after a live
  run proves it works; measurement (recall, precision, cost) decides whether
  the lens stays.
- **Session reflection**: agents accumulate feedback about the process itself,
  which is reviewed by a human and applied to the scaffolding — never
  auto-applied.
- **Memory promotion**: durable insights move from agent-private memory into
  the shared, versioned knowledge base.

**Why.** This is the only mechanism in groundwork that makes all the others
self-improving; without it, every checklist is frozen at the day it was
written.

**Consequences:**

- **Backflow is a standing obligation**: groundwork was distilled from a
  production codebase, and every repository that uses it keeps learning. Each
  new lesson there (a corrected design, a new lens) is evaluated for
  Groundwork, which takes the *corrected* design, not the first attempt.
- Improvement artifacts (taxonomies, fixtures, lens registries) are versioned
  in the repo like code — the process has a test suite.
