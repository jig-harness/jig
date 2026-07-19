# 3 — AI scaffolding as the spine

The unifying principle. Every module is written so its practice is **operable
by AI agents**, not just readable by humans:

- Rules are **machine-checkable** wherever possible; prose conventions name
  their check (or their absence — see principle 4).
- Facts live in a **single source of truth** with generated projections, so an
  agent never has to guess which of two disagreeing copies is right — and
  parallel agents don't fork the vocabulary (glossaries exist for exactly
  this).
- Instructions are **layered and scoped**: a universal instruction file, tool-
  specific deltas, per-directory files, and conditional rules that load only
  when relevant — so agent context stays small and precise.
- Procedures are packaged as **named, invocable skills** rather than tribal
  knowledge.

**Why.** Agents amplify whatever structure exists. In a well-scaffolded repo,
ten parallel agents converge (same terms, same gates, same process); in an
unscaffolded one they diverge and their output fights itself. Scaffolding is
the highest-leverage investment because every other practice pays through it:
gates catch agent mistakes, docs governance keeps agent knowledge current,
review systems catch what gates can't, and the learning loop improves all of
it.

**Consequences:**

- Module content addresses "what does the agent need to find, and where?"
  explicitly.
- The scaffolding maintains *itself* through the same machinery: instruction
  files carry freshness checks (M2), the review system reviews its own
  changes, and scaffolding drift is a first-class audit finding.
