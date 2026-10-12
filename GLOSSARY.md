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
- **Area class** — a repo-chosen boolean partition of *change-areas* used to
  scope a check to "the areas that matter for this question" (e.g. which
  areas require the heavy build, which gate a deploy). Not a schema field
  itself — each class is defined by a rule over existing schema fields — but
  a check that consumes a class must cite its rule, so two implementations
  can't silently disagree about membership. *Code area* and *deploy-critical
  area* are the two instances used by the *change-area catalog*'s
  regex-mirror guard.
- **Code area** — the *area class* answering "must the heavy build run for a
  change here?", repo-defined (e.g. every area whose `category` isn't a
  docs-only tag). Used by `checkFilterCoverage` to decide which areas a fast
  CI shortcut regex must never miss. Not identical to *deploy-critical
  area* — a CI-infra area can be code-bearing without ever being deployed.
- **Deploy-critical area** — the *area class* of every area whose
  `deployTier` is not `none`, read directly off the schema field (unlike
  *code area*, which is repo-chosen). Used by `checkFilterCodeAreaCoverage`
  to decide whether a file's resolved areas actually gate a deploy.

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
  and the reviewers that read drafts can run before it is marked Ready, which
  summons the reviewers that wait for Ready. A human marks it Ready, or a
  *PR drive loop* does at the point the *pull-request policy* names.
- **Integration branch** — the branch pull requests land on (often `main`),
  where everyone's changes meet. Groundwork's tools read it from the
  repository's default branch unless configuration names another.
- **Forge** — the service that hosts a repository and its pull requests,
  reviews and checks (GitHub, GitLab, …).
- **Stacked pull request** — a pull request based on another open pull
  request's branch instead of the *integration branch*, so dependent work can
  be reviewed before what it builds on merges. A *native* stack records the
  final target in the *forge*'s own stack metadata; a plain *branch chain*
  records it nowhere, and tools have to walk the chain of bases to find it.
- **Pull-request policy** — a repository's declared rules for how pull
  requests are shaped: whether they may stack, how branches are named,
  whether they open as drafts and when they are marked Ready, how a pull
  request links its issue, and how large it may be.
- **Merge base** — the most recent commit two branches share. A merge
  compares each branch with it to see what each side changed; a pull
  request's own changes are its diff against the merge base with its base
  branch.
- **Conflict marker** — the `<<<<<<<`, `=======` and `>>>>>>>` lines git
  writes into a file where it could not combine two sides' changes. A file
  that still holds one is not resolved.
- **Integration side** — in a merge, rebase or cherry-pick that stopped on
  conflicts, the side that carries the *integration branch*'s changes, as
  opposed to the side carrying the work being brought in. Git's own names,
  "ours" and "theirs", swap meaning between a merge and a rebase, so
  Groundwork's conflict tooling names each side by this role instead.
- **Changelog** — a file listing each release's notable changes, newest
  first. Groundwork's follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
  one heading per plugin version, and an **Unreleased** heading for changes
  that no release carries yet.
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
- **Scar class** — one of the four kinds of scar *de-scarring* removes from a
  promoted document: review dialogue (S1), a correction-in-place ledger (S2), a
  completed-work ledger (S3), and an archaeological layer of superseded states
  (S4).
- **Keep test** — the de-scarring question for each sentence: would a reader
  who never saw the old state decide wrongly without it? If yes, the sentence
  stays, rewritten as a present-tense constraint.
- **Closure invariant** — the rule that a finished row may leave a plan,
  checklist or backlog only when its *closure anchor* is verified: the issue it
  names is closed and opening it confirms the gap is truly resolved, or the
  thing it delivered is present in the source of truth. No anchor, the row
  stays and the missing anchor is reported. Part of *de-scarring*
  ([scar classes](plugin/skills/descar/references/scar-classes.md)).
- **Completeness register** — a maintained statement of current coverage, such
  as a list of every requirement a contract must address with a `covered` mark
  on each. Its rows are live claims people rely on, not finished-task residue,
  so *de-scarring* corrects a stale row in place and never deletes it
  ([scar classes](plugin/skills/descar/references/scar-classes.md)).
- **Design brief bundle** — the numbered set of Markdown files and images
  handed to an external design session as its only input.
- **Claude Design** — the external design session a *design brief bundle* is
  handed to. The design work happens there, not in the repository; Groundwork's
  `design-brief-builder` skill prepares the inputs and audits them
  ([design-brief-builder](plugin/skills/design-brief-builder/SKILL.md)).
- **Tweaks** — the list of states (at least three meaningful ones, such as
  empty, typical and error) that a design brief asks the prototype to let a
  reviewer switch between, so one prototype shows how the design behaves across
  cases ([bundle templates](plugin/skills/design-brief-builder/references/bundle-templates.md)).
- **Reality grounding** — comparing a design's assumptions with the actual
  schema and code, citing file and line, to find where they agree and where
  they differ.
- **Anti-prescription audit** — a check of a design brief before it goes out
  that removes answers decided in advance, so the designer solves the problem
  instead of drawing the author's solution.
- **Decision sheet** — a self-contained HTML page for one call a human must
  make, rendered from a typed source: the question, the options, what would
  have to be true for each, and a citation for every claim. Groundwork's
  decision skill writes one when it escalates instead of ruling.
- **Explainer sheet** — a cited, commit-dated page (HTML and Markdown) of how
  part of a system works today: the flow as numbered steps, claims grouped in
  sections, each with its source.
- **Sheet kit** — the shared reading system both sheets are built on: layout,
  citations in the margin, escaping, and a freshness guard that compares the
  citations against the commit the facts were checked at.
- **Archify** — an open-source tool that draws architecture diagrams from typed
  JSON sources. An *explainer sheet* embeds its static drawing as a figure, and
  the sheet's freshness guard checks the figure against its diagram source
  ([explainer sheet](plugin/skills/explain/references/explainer-sheet.md#figures)).
- **Precedent pass** — the mechanical search of a repository's ADRs, policy
  files, rules and glossary that runs before an agent rules on a dilemma, so a
  question already decided is answered from the record, not re-decided.
- **Architect mandate** — the standing brief of the agent that rules in the
  decision skill's third phase: verify every load-bearing claim against the
  code before endorsing it, stress-test the risky parts, and trust nothing
  another agent asserts without evidence
  ([decide](plugin/skills/decide/SKILL.md#the-architect-mandate)).
- **Simplified Technical English** — a controlled form of English
  (ASD-STE100), first written for aircraft maintenance manuals: one meaning per
  word, short sentences, active verbs. A prose linter can check text against
  its structural rules, for example text that asks a human to decide.
- **Flag label** — an issue-tracker label that *drives process* rather than
  just categorizing (e.g., "has-migration" → a mandatory review gate fires).
- **Sensitivity flag** — a *flag label* marking a change that carries extra
  obligations: `has-migration` (a database migration), `api-change` (a
  published contract), `dpa-relevant` (personal data) or `manual-ops` (a manual
  operational step). A fired flag sends a call to a human instead of an agent
  ([decide](plugin/skills/decide/SKILL.md)) and widens the review a change gets.
- **Epic** — an issue whose sub-issues are worked one at a time, each as its
  own pull request, while the epic itself tracks the whole. Groundwork's
  `do-item` skill picks up the next sub-issue and records the epic's order in
  a machine-readable execution plan
  ([do-item](plugin/skills/do-item/SKILL.md)).
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
- **Tiered review** — a review that runs cheap pattern checks first, contract
  checks second, and an expensive semantic review last; each tier can block
  or warn, and a change only pays for the tiers its file types need.
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
  reaches a terminal state before merge — **accepted** (fixed here; some
  teams write *addressed*), **rejected** (the reviewer was wrong, with a
  reason), **won't fix** (right, but deliberately declined, with a reason),
  **deferred** (with a filed follow-up), or *moot* — each leaving an audit
  trail. Scope expansion and overruling a human thread stay *HITL*.
  Groundwork ships it as the `resolve-review-comments` skill.
- **PR drive loop** — the procedure that wraps the *comment-resolution loop*
  for unattended work on one pull request. The comment-resolution loop already
  repeats *review rounds* until the reviewers settle; the drive loop runs each
  round as a fresh agent process and adds a *lease* that fences the working
  tree so two agent sessions never reply to the same thread, labels for
  *self-inflicted findings*, checks for findings that appear only in a
  reviewer's summary, repair rounds for red CI and conflicts with the base,
  and round state that survives between invocations. It stops in exactly one
  *terminal state* and never merges. Groundwork ships it as the `drive-pr`
  skill, and the `do-item` skill starts it when it opens a pull request.
- **Self-inflicted finding** — a review finding on a line one of the pull
  request's own commits last changed, usually a fix from an earlier round. The
  drive labels every finding this way: by the later rounds most findings are
  self-inflicted, and the answer to one is to check the earlier fix's whole
  effect, not just the flagged line.
- **Decline ladder** — the filter that, from a configured *review round*
  onward, makes a finding the triage rubric would accept clear a higher bar
  (severity, category, priority tier) before it earns another fix. It can turn
  an acceptance into a decline, never the reverse, and the bar lives only in the
  repository's `.config/review-triage.yaml`
  ([triage rubric](plugin/skills/resolve-review-comments/references/triage-rubric.md#the-decline-ladder)).
- **Terminal state** — one of the named end states a *PR drive loop* stops
  in (converged, pull request merged or closed, round limit reached, waiting
  on a human, …), each reported with a documented exit code, so a script or a
  person can tell from the exit alone what to do next.
- **CI hold** — an opt-in label a *PR drive loop* puts on a pull request
  between review rounds so the repository's continuous-integration workflows
  skip their expensive jobs on intermediate pushes; removing it runs them in
  full once, on the final head. Only for repositories whose workflows are
  written to honour the label.
- **Required checks** — the continuous-integration checks a repository's
  branch protection requires to pass before a pull request may merge. A drive
  derives them from the protection settings unless the repository lists them
  (`ci.required_checks`).
- **Lease** — a short-lived, renewable claim recorded on disk that says which
  session currently owns a piece of work, such as a pull request's review
  threads. Other sessions read it and stand back; a lease whose holder died
  expires instead of blocking forever.
- **Review Arbiter** — the judgment-only agent the *comment-resolution loop*
  hands a contested finding to when the triage rubric cannot settle it. It
  reads the code, rules fix now, reject, won't fix, defer or escalate, and
  never edits; only an escalation reaches a human.
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
- **Convergence (review loop)** — the point where a review loop may stop: the
  reviewer completed on the exact head commit, its recorded reviewed commit
  equals that head, and no unresolved thread or *summary-only finding* remains.
  Checked mechanically, not judged by feel ([drive-pr](plugin/skills/drive-pr/SKILL.md)).
- **Sticky comment (reviewer summary)** — the single summary comment an
  automated reviewer keeps and updates on a pull request, found by a marker
  string (`review.sticky_marker`). It carries the reviewer's overall verdict
  and any findings it could not attach to a line
  ([configuration](plugin/CONFIGURATION.md)).
- **Summary-only finding** — a review finding that appears only in the
  reviewer's *sticky comment* because it could not be anchored to a diff line,
  so it creates no thread. A loop that counted only threads would report
  *convergence* with a real finding unanswered; the drive enumerates these and
  answers each with a top-level comment
  ([drive-pr](plugin/skills/drive-pr/SKILL.md)).
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
- **Backflow** — the standing rule that lessons learned in the repositories
  that use Groundwork flow back into it (and Groundwork's improvements flow
  out to them), keeping both honest.
- **SOLID** — five object-oriented design principles: single responsibility,
  open–closed, Liskov substitution, interface segregation and dependency
  inversion. A review can check code against them.

## Runnable tooling

- **Plugin** — an installable bundle of skills and other agent extensions
  that an agent tool loads in every session. Groundwork ships its skills and
  its review agent as one plugin for Claude Code and Codex, installed once
  per machine ([plugin/README.md](plugin/README.md)).
- **Marketplace** — a catalog an agent tool installs plugins from; usually a
  Git repository with a manifest listing its plugins. This repository is its
  own marketplace.
- **Consumer overlay** — a repository's own values for a shared procedure,
  such as its gate command and reviewer names, kept in
  `.config/groundwork-overlay.yaml` and read by the procedure when it runs.
  The procedure stays shared while the values belong to the consumer. Every
  field is in [plugin/CONFIGURATION.md](plugin/CONFIGURATION.md).
- **Toolchain** — the runtime, compiler and checks used to build and test tools.
- **Bun** — the runtime that executes Groundwork's TypeScript commands and tests,
  installs their dependencies and bundles the tools.
- **TypeScript** — JavaScript with checked type declarations; Groundwork checks
  the types separately before running its commands.
- **mise** — a tool that installs the exact runtime version recorded by a repository.
- **Hard link** — another filesystem name for the same file. Creating the name
  atomically lets a lock claim publish a complete owner record in one operation.
- **Subagent (plugin agent)** — a separately prompted helper with its own
  instructions and tool list that a skill or session hands one narrow job to.
  A plugin can ship subagents beside its skills; Claude Code loads them,
  Codex reads them only from its own agent folders.
- **Tracker interface and adapter** — the small set of issue-tracker
  operations a skill is allowed to use (read an issue with its comments and
  children, move it to a workflow state, comment, and the reads the delivery
  metrics need), and one implementation of that set for a particular tracker
  (Linear today). The skills call only the interface, so supporting a new
  tracker means writing an adapter, not editing the skills.
- **Test shard** — one slice of a test suite's files, run as its own CI job
  so a long suite finishes in a fraction of the time on parallel machines.
- **Validation plan** — the checks a change must pass, worked out from the files
  it touches: local checks, verification checks, whether a *remote test box* is
  needed, and which review skills to run. A repository supplies it as a command
  that reads changed files on stdin and prints JSON
  (`drive.validation_plan_command`); without one the plan is the gate command
  alone ([drive-pr](plugin/skills/drive-pr/README.md)).
- **Remote test box (Testbox)** — a disposable machine, warmed for one run, that
  re-runs a repository's heavy test and build checks away from the laptop. A
  *validation plan* says when one is required; Groundwork's drive uses each box
  once, because a reused box can sync stale state
  ([drive-pr](plugin/skills/drive-pr/SKILL.md)).
- **Lockfile** — the file a package manager writes to pin the exact version of
  every dependency. When a merge conflicts in one, Groundwork's conflict tooling
  regenerates it from the manifests instead of merging it by hand, and the CI
  fixer reinstalls from it ([resolve-conflicts](plugin/skills/resolve-conflicts/SKILL.md)).
- **Intent chain** — the short statement of why a piece of work exists: the
  epic's intent, the issue's scope and its acceptance criteria. `do-item`
  writes it to a snapshot file and *Refocus* puts it back in front of an agent
  ([do-item](plugin/skills/do-item/SKILL.md)).
- **Refocus** — putting a piece of work's *intent chain* (why it exists: the
  epic's intent, the issue's scope and acceptance criteria) back in front of an
  agent after its context is compacted, and at the start of each review round,
  so a long session does not drift from the goal it started with.
- **Verification fit** — an agent's recorded verdict on whether the checks a
  review round was required to run matched the risk of the change: too strict,
  proportionate, or too lenient. The verdicts are evidence for tuning which
  checks a change must run; they never change a round's checks by themselves.
- **Fractal metrics** — the delivery process's scoreboard across many pull
  requests: review rounds, follow-up issues and escaped defects, each compared
  with a recorded baseline.
- **REST (Representational State Transfer)** — a convention for reading and
  changing service resources through ordinary web requests.
- **GraphQL** — a query language for web APIs in which the caller names exactly
  the fields it wants. GitHub exposes review threads and merge state through it,
  and its quota is a separate, easily exhausted budget from *REST*.
- **ETag** — a version tag a web service returns with a resource. Sending it back
  on the next request lets the service answer "not modified" at no quota cost,
  which is how Groundwork's polling loops watch an idle pull request cheaply
  ([conditional reads](plugin/skills/drive-pr/scripts/lib/gh-conditional.ts)).
- **NDJSON (newline-delimited JSON)** — structured JSON records written one per
  line, so a command can consume them as a stream.
- **ASCII (American Standard Code for Information Interchange)** — the basic
  character set containing English letters, digits and common punctuation.
- **SHA (Secure Hash Algorithm)** — a family of content fingerprints; Git uses
  one to identify a commit, and Groundwork's tools use SHA-256 to record
  exactly which source a generated file was built from.
