# Glossary

Plain-language definitions of every term of art used in groundwork. Terms are
capitalized as commonly written; cross-references are *italicized*.

## Core ideas

- **AI-native delivery** — building and maintaining software with AI coding
  agents as first-class participants: the repo is organized so agents can find
  the rules, run the checks, and improve the process — not just emit code.
- **Scaffolding** — everything in a repo that exists to guide agents (and
  humans): instruction files, *skills*, *rules*, glossaries, checkers. Not the
  product code itself.
- **SSoT (single source of truth)** — the one authoritative place a fact or
  rule is defined. Everything else *points* to it or is *generated* from it,
  so copies can't quietly disagree.
- **Drift** — the gap that grows when two copies of the same fact evolve
  independently (a doc says one thing, the code does another). Groundwork's
  recurring answer: make one copy the *SSoT* and gate or generate the rest.
- **Projection** — a consumer-specific view *generated* from an *SSoT* (a CI
  path-filter, a review-gate table, a tracker-label set derived from a
  change-area catalog). Because it is generated and *freshness-gated*, it
  cannot silently disagree with its source.
- **Module** — groundwork's unit of adoption: one practice area (e.g.,
  "generated-artifact freshness") packaged with its invariant, maturity
  levels, templates, and reference code. Modules adopt independently.
- **Maturity level** — how deeply a module is adopted: **Lite** (minimum
  useful), **Standard** (production teams), **Strict** (regulated/compliance
  posture). Brownfield projects climb one level at a time.
- **Profile** — a recommended composition of modules and maturity levels for a
  project shape: Solo/Lite, Team/Standard, Regulated/Strict.
- **Invariant** — the tool-independent statement of a practice ("every
  committed generated file has a drift check"), as opposed to any particular
  tool that implements it.
- **Disposition** — a written behavioral default ("systematic over
  improvised", "no backward compatibility yet") paired with the explicit
  condition under which it flips (its *flip condition*). A disposition
  without a flip condition becomes dogma.
- **Tool delta** — a runtime-specific instruction file (`CLAUDE.md`,
  `.cursorrules`, …) carrying only what is specific to that runtime plus a
  pointer to the universal instruction file — never a second copy of it.
- **Vendoring** — copying external material into a repo so it remains
  available and stable regardless of the original's location or lifetime.
- **MCP (Model Context Protocol)** — an open standard for connecting AI
  agents to external tools and data sources; an MCP server exposes a set of
  callable tools to any compatible agent runtime.

## Enforcement

- **Quality gate** — a check that must pass before work proceeds (formatting,
  linting, type checks, tests, build).
- **Enforcement ladder** — the ordered places a rule can live: written
  convention → editor/local script → *git hook* → *CI* → mandatory review
  step. Each rung is harder to bypass. Groundwork treats "which rung is this
  rule on, and what promotes it?" as a first-class question — and the rung is
  what the *auditor* scores.
- **Convention-only** — a rule that exists only as prose or habit, with no
  mechanical check. A tracked state, not a resting place.
- **Git hook** — a script that runs automatically at a git event
  (pre-commit, pre-push, commit-msg). Managed by tools like lefthook, husky,
  or pre-commit.
- **CI (continuous integration)** — the service that runs checks on every
  push/PR (GitHub Actions, GitLab CI, …). In groundwork's model, CI is the
  *authority*: local hooks are conveniences that can be bypassed; CI closes
  the hole.
- **Grep gate** — a deliberately simple check that searches the codebase for a
  forbidden or required pattern. Cheap, fast, and good enough for many rules;
  each ships with a self-test so the gate itself can't silently break.
- **Generated artifact** — a committed file produced by a script from some
  source of truth (an API spec from route definitions, an index from a docs
  tree). Must never be edited by hand.
- **Freshness gate (drift check)** — the check that fails when a *generated
  artifact* no longer matches what its generator would produce — proof the
  committed copy is stale.
- **Freshness triad** — the three mechanisms every committed *generated
  artifact* ships with: a regenerate script, a CI drift check, and a
  pre-commit auto-regenerate-and-stage hook.
- **Commit-nothing check** — a CI check that recomputes a derivable fact
  (a count, a roster) and compares it to what the prose claims, committing
  no generated file — freshness without the merge-conflict liability of a
  committed cache.
- **Ephemeral replay** — the strongest drift check for schema-like
  artifacts: rebuild from absolute scratch in a throwaway environment
  (e.g. replay all migrations into a disposable container), normalize, and
  diff against the committed copy — testing the whole derivation chain,
  not file timestamps.
- **Suppression token** — a documented inline marker that legitimately
  silences a specific gate at a specific spot, with a justification. A
  registry of them prevents ad-hoc, invisible exceptions.
- **Escape hatch** — a documented, legitimate way to bypass a gate (e.g.
  `git commit --no-verify` in an emergency), always paired with a higher
  rung — usually *CI* — that re-checks, so the bypass changes nothing about
  what merges.
- **Advisory gate** — a gate that reports failures without blocking, run
  that way while its precision is being proven. Every advisory gate carries
  a promotion condition (when it becomes blocking); advisory-forever is a
  tracked smell.
- **Process marker** — a literal tag in a commit-message body (e.g.
  `[reviewed: db-migration]`) recording that a mandatory process step
  happened, required by a commit-msg hook and re-verified by a gate the
  committer can't skip.
- **Change-area catalog** — one machine-readable file mapping path patterns to
  named *change-areas* and their implications (which CI jobs run, which reviews
  are mandatory, which deploy tier applies). It is the *SSoT* every consumer
  reads via generated *projections*, instead of each re-hardcoding its own
  path-lists that then disagree.
- **Fix-and-stage** — the pre-commit hook pattern where an auto-fixer
  (formatter, regenerator) runs and its output is re-staged automatically,
  so the commit lands already clean instead of failing.

## Process

- **ADR (architecture decision record)** — a short numbered document capturing
  one significant decision, its context, and its consequences. Append-only
  history: superseded ADRs are marked, not rewritten.
- **Frontmatter** — the machine-readable metadata block at the top of a
  document (a YAML header: type, status, lifecycle, owner, freshness date).
  Validated against a schema so a docs tree stays queryable and its lifecycle
  is mechanically checkable rather than guessed.
- **Authority hierarchy** — a written, single-valued precedence order for
  resolving contradictions between documents (e.g. generated ground truth >
  decision records > feature docs). Turns "which doc wins?" from a judgment
  call into a lookup.
- **PRD (product requirements document)** — the document defining *what* a
  feature does for users and why — deliberately separate from *how* (the
  architecture doc).
- **Draft PR** — a pull request opened in "not ready for review" state so CI
  and bots can run while a human decides when it's worth reviewers' attention.
- **HITL (human-in-the-loop)** — a decision class that must be made by a
  human, never autonomously by an agent (merges, releases, destructive
  operations, scope expansions). Kept in an explicit registry.
- **BWC (backward compatibility)** — keeping old interfaces working when
  things change. Groundwork treats "when do we start paying for BWC?" as an
  explicit *disposition* with a flip condition (e.g., first real customer
  data), not an unstated assumption.
- **De-scarring** — cleaning a finished document of review findings,
  corrections, and reviewer dialogue ("scars") so it reads cleanly; the
  history stays in PRs, issues, and git — not in the artifact.
- **Flag label** — an issue-tracker label that *drives process* rather than
  just categorizing (e.g., "has-migration" → a mandatory review gate fires).
- **Worktree** — a git feature giving one repository multiple working
  directories, letting several agents work different branches of the same repo
  in parallel on one machine.
- **Monorepo** — one repository holding many applications/packages, usually
  with a shared task runner and shared quality gates.
- **Verified pointer** — a branch or tag that a delivery pipeline advances only
  when post-merge verification passes, so "merged" and "verified" stay distinct
  facts. Deploys ship the verified pointer, not the latest commit; a *freshness*
  watchdog pages when the pointer falls too far behind the default branch.
- **Ephemeral environment** — a disposable, cheap preview environment spun up
  per pull request or branch and torn down after, so changes can be exercised in
  something realistic without a shared long-lived staging server.
- **Test-data factory** — a generator of realistic, tenant-isolated, resettable
  seed data, so tests and preview environments run against representative data
  rather than hand-made fixtures or a copy of production.

## Review & learning

- **Shadow reviewer** — an in-house automated PR reviewer that runs alongside
  commercial review bots in comment-only mode, so its quality can be measured
  against them before it's ever allowed to block anything.
- **Review lens** — one additive, numbered check taught to a reviewer (a
  prompt module or checklist bullet), typically born from a documented miss.
- **Miss→lens flywheel** — the improvement loop: an external reviewer or human
  catches what the automated reviewer missed → the miss is classified, filed,
  and reconstructed as an *eval fixture* → a new *lens* is added → validated →
  measured. Generalizes to any evaluable agent behavior.
- **Eval fixture / corpus** — a pinned historical case (exact commit + expected
  findings) that a reviewer or agent is re-run against, turning past misses
  into a regression test for the process itself. A fixture pins the *pre-fix*
  state and joins the blocking corpus only after a live run validates it.
- **Lever** — a durably numbered miss-and-its-answer (`L-NNNN`), filed once and
  referenced forever: a *lens*, an *eval fixture*, and a parity metric all point
  back to it. Numbering is guarded for uniqueness like *ADR* numbers.
- **Review harness** — an automated reviewer built as prompt *lenses* over a
  reusable engine, not a fixed static analyzer. Split into a repo-agnostic
  **core** (a tool registry of reviewers, a required verify step, and
  containment guards that keep it from flooding a PR or running untrusted code)
  and a repo-specific **config** (which reviewers, which lenses, which posture).
- **Comment-resolution loop** — the discipline that every PR review thread
  reaches a terminal state before merge — **addressed** (fixed here),
  **rejected** (with a reason), **deferred** (with a filed follow-up), or *moot*
  — each leaving an audit trail. Scope expansion and overruling a human thread
  stay *HITL*.
- **Moot (as a resolution)** — the terminal state for a review finding whose
  anchored code no longer exists: deleted or rewritten by a later commit.
  Distinct from *rejected* on purpose — rejected asserts the reviewer was
  **wrong**, moot asserts it may have been **right about code that is gone**.
  Collapsing the two feeds a *miss→lens flywheel* false positives the reviewer
  never committed, training away findings it got right. Still needs a trail
  naming what superseded it.
- **Declared verdict** — the resolution state written by the author, in a
  machine-readable form anchored to a fixed position in the reply, at the moment
  of replying — rather than reconstructed later from the thread's prose.
  Reconstruction loses acceptances far more often than rejections, so anything
  downstream that counts outcomes inherits that bias.
- **Export adapter** — the small, checked-in translation step between a forge's
  API and a gate's input format. A forge offers an id, a resolved boolean and
  free text; a gate wants a closed set of states. Keeping the mapping in one
  place — including local vocabulary and an explicit "cannot tell" — means it
  can be tested against the gate it feeds, instead of being re-improvised in
  every workflow that calls the gate.
- **Review round** — one pass of the review loop: reviewers comment, the author
  resolves, the push re-triggers the reviewers. Because resolving *causes* the
  next round, "no open threads" is not the loop's stop condition; a round that is
  settled — every expected reviewer has reported — with nothing left is.
- **Precision bar** — the pre-committed threshold of measured precision an
  automated reviewer (or *lens*) must clear before it may be promoted from
  comment-only to blocking. Recorded up front so "advisory forever" is visible.
- **Parity report (parity tracker)** — the periodic measurement of a reviewer
  against oracles (external reviewers, humans): recall, precision, and a
  `missed_blockers` count. Drives whether a *lens* is kept, promoted past the
  *precision bar*, or killed — and whether a vendor can be dropped.
- **Reflection** — the cycle that accumulates end-of-session feedback into an
  inbox and processes it into *proposed* scaffolding changes, which a human
  approves before anything is edited (self-modifying rules stay *HITL*).
- **Memory promotion** — lifting a durable lesson from an agent's private,
  per-session memory into git-tracked, shared memory through a review point, so
  it survives the session and reaches other agents.
- **Skill** — a packaged, named procedure an agent can invoke (a review
  checklist, a migration workflow). The unit of codified "how we do this
  here."
- **Rule (conditional rule)** — an instruction file that loads into agent
  context only when files matching its path patterns are being edited — the
  scoped counterpart of an always-loaded instruction file.
- **Scout** — a small, cheap agent (fast model, read-only) sent ahead of
  implementation to gather facts; part of tiered model routing (expensive
  models decide, cheap models explore).
- **Auditor** — groundwork's runnable assessment: parallel surveys of a target
  repo, stack detection, per-module maturity scoring, and a prioritized
  recommendations report. See [audit/](audit/).
- **Backflow** — the standing rule that lessons from a live implementation
  flow back into this template (and vice versa), keeping both honest.
