# Glossary

Plain-language definitions of every term of art used in jig. Terms are
capitalized as commonly written; cross-references are *italicized*.

Where several words compete for one idea, the entry's term is the one to use
and its *Avoid* line names the rivals. When you meet a rival in a change you
make, use the entry's term instead.

## Core ideas

- **AI-native delivery** — building and maintaining software with AI coding
  agents as first-class participants: the repo is organized so agents can find
  the rules, run the checks, and improve the process — not just emit code.
- **Scaffolding** — everything in a repo that exists to guide agents (and
  humans): instruction files, *skills*, *rules*, glossaries, checkers. Not the
  product code itself.
- **Software factory** — a way of producing software in which work enters in a
  standard form, passes through the same stations and checks every time, and
  comes out measured, so output stays predictable as volume grows. When AI
  agents run the stations, the factory depends on the repository's
  *scaffolding* for context, verification and kept knowledge; Jig provides the
  practices to build that scaffolding and skills that run the stations. See
  [FACTORY.md](FACTORY.md).
- **SSoT (single source of truth)** — the one authoritative place a fact or
  rule is defined. Everything else *points* to it or is *generated* from it,
  so copies can't quietly disagree.
- **Drift** — the gap that grows when two copies of the same fact evolve
  independently (a doc says one thing, the code does another). Jig's
  recurring answer: make one copy the *SSoT* and gate or generate the rest.
- **Projection** — a consumer-specific view *generated* from an *SSoT* (a CI
  path-filter, a review-gate table, a tracker-label set derived from a
  change-area catalog). Because it is generated and *freshness-gated*, it
  cannot silently disagree with its source.
- **Module** — Jig's unit of adoption: one practice area (e.g.,
  "generated-artifact freshness") packaged with its invariant, maturity
  levels, templates, and reference code. Modules adopt independently.
- **Maturity level** — how deeply a module is adopted: **Lite** (minimum
  useful), **Standard** (production teams), **Strict** (regulated/compliance
  posture). Brownfield projects climb one level at a time. *Avoid*: tier
  (*tiered review* and deploy tiers use it), rung (a step of the
  *enforcement ladder*).
- **Profile** — a recommended composition of modules and maturity levels for a
  project shape: Solo/Lite, Team/Standard, Regulated/Strict.
- **Consumer repository** — a repository that uses Jig in any of its ways:
  through the *plugin*'s skills, by adopting modules, or by taking one
  reference pattern. Where it configures Jig, it gives its own values (its
  *consumer overlay*). Jig states the general pattern; a consumer repository
  holds one concrete, tested implementation of it, and what it learns comes
  back as *backflow*. Short form: consumer. *Avoid*: instance, downstream
  repository, target repository, adopting repository.
- **Invariant** — the tool-independent statement of a practice ("every
  committed generated file has a drift check"), as opposed to any particular
  tool that implements it.
- **Disposition** — a written behavioral default ("systematic over
  improvised", "no backward compatibility yet") paired with the explicit
  condition under which it flips (its *flip condition*). A disposition
  without a flip condition becomes dogma.
- **Tool delta** — a runtime-specific instruction file (`CLAUDE.md`,
  `.cursorrules`, …) carrying only what is specific to that runtime, with the
  universal instruction file brought in by the runtime's import or native
  read — never a hand-maintained second copy of it, and never only a pointer
  to it. Where a runtime has neither, a delta generated from the universal
  file and checked for freshness is a projection of it, not a copy.
- **Always-loaded context** — everything an agent runtime puts in context
  before the agent acts, in every session: the chained instruction files,
  rules with no path scope, the *discovery metadata* of every skill and
  agent, and the instructions *MCP* servers send. Each runtime and reviewer
  that reads it has a *context budget*.
- **Context budget** — how much of the *always-loaded context* one consumer
  takes in (Codex: the first 32,768 bytes of the instruction chain by
  default). Text past a consumer's budget does not reach it, usually without
  a warning, so it counts as not delivered.
- **Discovery metadata** — the name and description of a *skill* or agent
  that a runtime lists in every session so the model can choose it, paid
  for whether or not it is ever used.
- **Context window** — the amount of text a language model can take in at
  once, counted in *tokens*: the instructions, the conversation and every
  file it has read share it.
- **Token** — the unit a language model reads and is billed in, a word or
  part of one; English prose runs at about 4 characters a token.
- **Load path** — the way a file reaches a runtime's context: read natively,
  or brought in by an import. A text pointer ("see `AGENTS.md`") is not a
  load path; the model may or may not follow it.
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
  step. Each rung is harder to bypass. Jig treats "which rung is this
  rule on, and what promotes it?" as a first-class question — and the rung is
  what the *auditor* scores. *Avoid*: level for a rung (a module's
  *maturity level* uses it).
- **Convention-only** — a rule that exists only as prose or habit, with no
  mechanical check. A tracked state, not a resting place.
- **Git hook** — a script that runs automatically at a git event
  (pre-commit, pre-push, commit-msg). Managed by tools like lefthook, husky,
  or pre-commit.
- **CI (continuous integration)** — the service that runs checks on every
  push/PR (GitHub Actions, GitLab CI, …). In Jig's model, CI is the
  *authority*: local hooks are conveniences that can be bypassed; CI closes
  the hole.
- **Grep gate** — a deliberately simple check that searches the codebase for a
  forbidden or required pattern. Cheap, fast, and good enough for many rules;
  each ships with a self-test so the gate itself can't silently break.
- **Fail closed** — what a gate does when it cannot do its job: its input is
  missing or unreadable, empty where its format requires content, or a
  command it runs failed. It stops with an error instead of reporting that
  nothing was found. The opposite, failing open, turns a broken check into a
  green one. An input whose format allows zero entries (a log with no events)
  may be empty; the gate then says it examined zero.
- **Could not check** — the third outcome of a gate, beside passed and found
  violations (exit status 2 by convention): the gate could not decide, so the
  fix belongs to its input or environment, not to the code under check. Never
  evidence that a change passed.
- **Mutation testing** — checking a test by breaking the code it guards on
  purpose (deleting a condition, flipping a comparison) and confirming that
  the test then fails. A test that stays green against the broken code was
  not testing that code.
- **Shadow job** — a non-blocking CI job that runs a candidate tool beside
  the one in charge, on the same changes, and publishes how their results
  differ, so the candidate can be judged before it replaces anything.
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
- **Ratchet** — a gate that tolerates the findings a codebase already has
  but fails any change that adds to them, so the count can only go down. A
  rule held at a ratchet is promoted to a hard error once its count reaches
  zero.
- **GritQL** — a query language for matching patterns in source code by its
  structure rather than its text, used to write custom lint rules. Biome runs
  GritQL rules as plugins.
- **Dead code** — code nothing uses: files no entry point reaches, exports no
  module imports, dependencies no file loads.
- **Cyclomatic and cognitive complexity** — two counts of how hard a function
  is to follow: cyclomatic counts the independent paths through it, cognitive
  weighs nesting and breaks in the flow. CRAP (change risk anti-patterns)
  combines complexity with test coverage.
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
- **Pipeline economy** — spending *CI* only where its answer changes a merge
  decision, without letting a saving turn a failure into a pass (module M13).
  It decides how cheaply and how fast checks run, never which checks exist.
- **Aggregator job** — the one CI job a repository requires before merging,
  which waits for every other job and turns their results into one verdict.
  It exists because a job skipped by its condition counts as passing: the
  aggregator tells a job the change did not need from a job that never ran.
- **Concurrency group** — a key under which a CI provider lets only one run
  proceed at a time; a newer run with the same key cancels or displaces the
  older one. Safe only when the surviving run checks everything the displaced
  run would have.
- **Queue stall** — a CI job waiting for a machine to run on, for longer than
  any job should. Job timeouts do not count that wait, so only a separate
  watchdog notices it.

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
- **Path-scoped rule** — a *frontmatter* rule that applies only to the
  documents under a path prefix, for a subtree whose vocabulary differs from
  the rest (a runbook directory that must name its service, an archive that
  may hold only archived documents). It can narrow the tree's vocabulary,
  never widen it ([frontmatter check](modules/M4-docs-governance/reference/frontmatter-check/README.md#path-scoped-rules)).
- **Orphan document** — a document no other document lists under `related:`
  in its frontmatter. Ordinary Markdown links are not counted, so an orphan
  may still be linked from a page body; it is a candidate for a declared
  relation or for retiring, not proof that nothing leads to it. An *orphan
  report* lists them as a warning, never a failure
  ([index generator](modules/M4-docs-governance/reference/index/README.md#orphan-report)).
- **Sticky stamping** — how a generator dates the documents it writes: the
  `last_updated` date advances, in UTC, only when the output changed, and
  otherwise keeps the date the file already carries. It keeps generated
  documents honest without rewriting files whose only change is the date
  ([stamp](modules/M4-docs-governance/reference/stamp/README.md)).
- **Codemod** — a one-shot script that rewrites many files mechanically, such
  as bringing every document's frontmatter into line before a validator is
  tightened. Run as survey, plan, then apply, one commit per kind of change
  ([M4 adoption](modules/M4-docs-governance/README.md#adoption-steps)).
- **PRD (product requirements document)** — the document defining *what* a
  feature does for users and why — deliberately separate from *how* (the
  architecture doc).
- **PR (pull request)** — a proposed change to a repository, opened so it can
  be reviewed and checked before it is merged into the *integration branch*.
  Most of Jig's execution process runs around one.
- **Draft PR** — a pull request opened in "not ready for review" state so CI
  and the reviewers that read drafts can run before it is marked Ready, which
  summons the reviewers that wait for Ready. A human marks it Ready, or a
  *PR drive loop* does at the point the *pull-request policy* names.
- **Integration branch** — the branch pull requests land on (often `main`),
  where everyone's changes meet. Jig's tools read it from the
  repository's default branch unless configuration names another.
- **Developer Certificate of Origin (DCO)** — a short statement a
  contributor agrees to by adding a `Signed-off-by:` line to each commit,
  certifying that they wrote the change or otherwise have the right to submit
  it under the project's licence.
- **NOTICE file** — the file beside a project's `LICENSE` that names its
  copyright holder and lists the parts under other licences: here the
  templates under MIT No Attribution and the vendored third-party code. The
  Apache License requires anyone who redistributes the project to keep it.
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
  Jig's conflict tooling names each side by this role instead.
- **Changelog** — a file listing each release's notable changes, newest
  first. Jig's follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
  one heading per plugin version, and an **Unreleased** heading for changes
  that no release carries yet.
- **HITL (human-in-the-loop)** — a decision class that must be made by a
  human, never autonomously by an agent (merges, releases, destructive
  operations, scope expansions). Kept in an explicit registry.
- **BWC (backward compatibility)** — keeping old interfaces working when
  things change. Jig treats "when do we start paying for BWC?" as an
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
  handed to. The design work happens there, not in the repository; Jig's
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
  have to be true for each, and a citation for every claim. Jig's
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
  own pull request, while the epic itself tracks the whole. Jig's
  `do-item` skill picks up the next sub-issue and records the epic's order in
  a machine-readable execution plan
  ([do-item](plugin/skills/do-item/SKILL.md)). An epic is defined by its role
  (an outcome too large for one pull request, and the unit progress is
  reported on), not by how many children it has, and it closes on an
  *acceptance verdict*, never on a count of open children
  ([M9](modules/M9-tasks-memory/README.md#work-item-rules)).
- **Acceptance verdict** — the recorded outcome of reviewing whether an
  *epic*'s designed scope is delivered: accepting (with or without follow-ups)
  or rejecting. An accepting verdict, or a *waiver*, is what lets an epic close
  ([M9](modules/M9-tasks-memory/README.md#an-epic-closes-on-an-accepted-verdict)).
- **Waiver** — a person's recorded decision, on the *epic* itself, to close it
  without an *acceptance verdict*. It stands in for a review nobody ran and
  never overrides a rejecting one.
- **Tail** — an open child of an *epic* that the epic was never scoped to
  finish, such as a legal sign-off, an operator step or review debt. At
  closure a tail is linked back and given a comment naming the epic, then
  unparented and moved to the standing destination for its kind.
- **Shipping item** — the work item whose own pull request carries a change,
  as opposed to the *epic* that contains it. A *flag label* that fires a gate
  goes on the shipping item.
- **Severity mapping** — the one table that turns a finding's severity into
  the tracker priority it is filed with, shared by every
  path that files an issue so they cannot disagree.
- **Worktree** — a git feature giving one repository multiple working
  directories, letting several agents work different branches of the same repo
  in parallel on one machine. *Avoid*: workspace for the checkout itself; a
  workspace is what a *workspace provider* opens around a worktree.
- **Worktree scratch** — working files an agent keeps in a gitignored
  directory of its *worktree*. They outlive one session but only a session in
  that same worktree sees them, so nothing another worktree, or a person not
  working in it, needs belongs there
  ([memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md)).
- **Handoff** — the note one session leaves so another can carry on: what is
  done, what remains, what was decided, what is uncertain, and the command
  that resumes the work. It goes on the tracker item, never in *worktree
  scratch* ([memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md#handoffs)).
- **Monorepo** — one repository holding many applications/packages, usually
  with a shared task runner and shared quality gates.
- **Verified pointer** — a branch or tag that a delivery pipeline advances only
  when post-merge verification passes, so "merged" and "verified" stay distinct
  facts. Deploys ship the verified pointer, not the latest commit; a *freshness*
  watchdog pages when the pointer falls too far behind the default branch.
- **Digest (content digest)** — a hash of an artifact's exact bytes, such as
  the `sha256:…` that names a container image (`image@sha256:…`). Unlike a
  tag, which can be moved to other bytes, a digest always names the same
  content, so a deploy that names one ships exactly what was verified.
- **Build once** — the practice of building an artifact a single time and
  promoting those same bytes, by *digest*, through every environment, with
  per-environment settings supplied at deploy time rather than compiled in.
- **GitOps** — running deployments from git: a controller (such as Argo CD or
  Flux) keeps an environment matching what a git ref holds, so a deploy is a
  commit to that ref and a rollback is a revert.
- **Rendered state (release-state ref)** — the fully generated deployment
  manifests for an environment, with *digests* filled in, kept on a ref of
  their own that a *GitOps* controller reads and only one dedicated machine
  identity writes, so the source line's release pointer stays a pure
  fast-forward of verified commits.
- **Trusted ref** — the ref a promotion's own workflow definition and gate
  code are loaded from: the *verified pointer*, never whichever branch the
  person starting the promotion happened to pick, since a manually started
  workflow runs the copy of itself that lives on the chosen branch.
- **Post-deploy identity check** — the step that ends every deploy: the live
  environment must report the exact artifact identity that was promoted, its
  rollouts must be ready, and a readiness check that exercises the
  application's critical dependencies (its database, where it has one) must
  pass before the deploy counts as done.
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
  Jig ships it as the `resolve-review-comments` skill.
- **PR drive loop** — the procedure that wraps the *comment-resolution loop*
  for unattended work on one pull request. The comment-resolution loop already
  repeats *review rounds* until the reviewers settle; the drive loop runs each
  round as a fresh agent process and adds a *lease* that fences the working
  tree so two agent sessions never reply to the same thread, labels for
  *self-inflicted findings*, checks for findings that appear only in a
  reviewer's summary, repair rounds for red CI and conflicts with the base,
  and round state that survives between invocations. It stops in exactly one
  *terminal state* and never merges. Jig ships it as the `drive-pr`
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
  here." *Avoid*: command, slash command: `/jig:<name>` is how a skill is
  invoked, not what it is.
- **Rule (conditional rule)** — an instruction file that loads into agent
  context only when files matching its path patterns are being edited — the
  scoped counterpart of an always-loaded instruction file.
- **Scout** — a small, cheap agent (fast model, read-only) sent ahead of
  implementation to gather facts; part of tiered model routing (expensive
  models decide, cheap models explore).
- **Auditor** — Jig's runnable assessment: parallel surveys of a
  repository, stack detection, per-module maturity scoring, and a prioritized
  recommendations report, recorded in the audited repository so a re-run
  reports what changed. Runs as the `jig` plugin's `/jig:audit`; see the
  [audit skill](plugin/skills/audit/README.md).
- **Audit record** — the file (`.config/jig-audit.yaml`) in which an audit
  leaves what it found in the audited repository: the plugin version, date and
  commit, each maturity criterion's score with its evidence, and the
  recommendations the team declined, each with a reason and a condition for
  revisiting it. The next audit compares against it.
- **Audit sheet** — the self-contained HTML page an audit ends in, rendered
  from the *audit record* and a *report source* (the agent's JSON summary,
  recommendations, drift and what it examined): the maturity map against the
  team's profile, the moves to start with, and a choice per recommendation
  that the team copies to an agent as one block of decisions
  ([audit sheet](plugin/skills/audit/references/report-sheet.md)).
- **Popover** — a small panel beside a mark on a page that explains it in
  plain words, shown while the pointer rests on the mark or the keyboard
  focus is on it, and hidden again on Escape. The *audit sheet* gives one to
  each criterion's mark in its maturity map and to each module's chip.
- **Audit guide** — the part of the *audit sheet* that explains Jig to a
  reader who has never met it: the idea and the enforcement ladder, the
  modules, the profiles and their targets, how the audit works and how to
  read the sheet. It is one section of the same file, which the sheet's
  script opens as a view of its own.
- **Uncovered gap** — a maturity criterion within the target of the team's
  profile that does not meet its bar, which no recommendation of the audit
  moves and no held decline leaves on purpose. The *audit sheet* marks and
  lists each one, so every gap is either addressed or visibly left.
- **Profile signal** — an observed fact suggesting a project has outgrown
  the profile it aims for, such as more contributors, a new deploy
  environment or a compliance document. The *audit sheet* shows it beside the
  profile as a reason to revisit that choice, never as a finding.
- **Conditional target** — a level a *profile* asks of a module only when
  the team says a stated condition holds ("several agents work the repository
  in parallel workspaces"), because the need depends on how the team works,
  not on its size. The *audit record* lists the ones that apply
  (`profile_conditions`), and the *audit sheet* lets the team tick them.
- **Calibration note** — what an audit prints when the team says one of its
  judgements is wrong: a recommendation, or a criterion's score. It gives the
  criterion's statement, recorded score and evidence beside the team's note,
  for the agent to re-examine; the score itself is never changed by it.
- **Trend** (audit) — each module's maturity level across the audit records
  a repository committed over time, oldest first, shown in the *audit sheet*
  for the modules whose level changed.
- **Probe** — a precondition of a maturity criterion that a script can test
  from the repository's files ("some CI configuration exists"). When it does
  not hold the criterion is scored absent without further judgement; when it
  holds, an agent still judges the criterion itself.
- **Backflow** — the standing rule that lessons learned in the repositories
  that use Jig flow back into it (and Jig's improvements flow
  out to them), keeping both honest.
- **SOLID** — five object-oriented design principles: single responsibility,
  open–closed, Liskov substitution, interface segregation and dependency
  inversion. A review can check code against them.

## Runnable tooling

- **Plugin** — an installable bundle of skills and other agent extensions
  that an agent tool loads in every session. Jig ships its skills and
  its review agent as one plugin for Claude Code and Codex, installed once
  per machine ([plugin/README.md](plugin/README.md)).
- **Marketplace** — a catalog an agent tool installs plugins from; usually a
  Git repository with a manifest listing its plugins. This repository is its
  own marketplace.
- **Consumer overlay** — a repository's own values for a shared procedure,
  such as its gate command and reviewer names, kept in
  `.config/jig.yaml` and read by the procedure when it runs.
  The procedure stays shared while the values belong to the consumer. Every
  field is in [plugin/CONFIGURATION.md](plugin/CONFIGURATION.md).
- **JSONL (JSON Lines)** — a text format with one complete JSON value per
  line. Appending a record is appending a line, and a reader can process the
  file line by line, so it suits logs that only grow.
- **Configuration layer** — one source of configuration values, read in a
  fixed order so a later one overrides an earlier one: a person's own file
  for every repository, then the repository's *consumer overlay*, then
  environment variables for one run. Sections merge field by field; any
  other value replaces the earlier one whole.
- **Configuration schema** — the machine-readable list of every field the
  consumer overlay may hold, with its type and the skills that read it
  ([config-schema.yaml](plugin/skills/audit/config-schema.yaml)). The audit
  checks a repository's file against it, and tests keep it and the written
  reference listing the same fields.
- **Toolchain** — the runtime, compiler and checks used to build and test tools.
- **Bun** — the runtime that executes Jig's TypeScript commands and tests,
  installs their dependencies and bundles the tools.
- **TypeScript** — JavaScript with checked type declarations; Jig checks
  the types separately before running its commands.
- **mise** — a tool that installs the exact runtime version recorded by a repository.
- **Hard link** — another filesystem name for the same file. Creating the name
  atomically lets a lock claim publish a complete owner record in one operation.
- **Subagent (plugin agent)** — a separately prompted helper with its own
  instructions and tool list that a skill or session hands one narrow job to.
  A plugin can ship subagents beside its skills; Claude Code loads them,
  Codex reads them only from its own agent folders.
- **Issue** — one unit of work in the issue tracker: what `/jig:do-item` picks
  up and a pull request closes. Skills say *item* for short. *Avoid*: ticket,
  card, task.
- **Tracker interface and adapter** — the small set of issue-tracker
  operations a skill is allowed to use (read an issue with its comments and
  children, move it to a workflow state, comment, the reads the delivery
  metrics need, and the open-issue reads a batch proposal ranks), and one
  implementation of that set for a particular tracker
  (Linear today). The skills call only the interface, so supporting a new
  tracker means writing an adapter, not editing the skills.
- **Launcher** — the program an issue tracker's "open in coding agent" button
  runs. Jig's assigns the issue to whoever opened it, saves the whole
  issue to a file the agent reads, chooses the repository from the issue's
  label and opens a workspace for the agent in a *workspace provider* (with
  Conductor, a routed issue's agent starts once you confirm the new
  workspace).
- **Workspace provider** — the part of the *launcher* that opens the agent's
  workspace in a particular app or host (Conductor today). Providers differ
  only in that last step, so adding one does not change the rest of the
  launcher.
- **Deep link** — a web-style address (`conductor://…`) that opens a desktop
  app at a given place, here with a prompt and a repository already filled in.
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
  *validation plan* says when one is required; Jig's drive uses each box
  once, because a reused box can sync stale state
  ([drive-pr](plugin/skills/drive-pr/SKILL.md)).
- **Lockfile** — the file a package manager writes to pin the exact version of
  every dependency. When a merge conflicts in one, Jig's conflict tooling
  regenerates it from the manifests instead of merging it by hand, and the CI
  fixer reinstalls from it ([resolve-conflicts](plugin/skills/resolve-conflicts/SKILL.md)).
- **WCAG (Web Content Accessibility Guidelines)** — the W3C's standard for
  making web pages usable by people with disabilities. Its levels A, AA and
  AAA are increasingly strict; Jig's website holds every text color pair to
  the AA contrast minimum in both themes ([design/website.md](design/website.md)).
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
  which is how Jig's polling loops watch an idle pull request cheaply
  ([conditional reads](plugin/skills/drive-pr/scripts/lib/gh-conditional.ts)).
- **NDJSON (newline-delimited JSON)** — structured JSON records written one per
  line, so a command can consume them as a stream.
- **ASCII (American Standard Code for Information Interchange)** — the basic
  character set containing English letters, digits and common punctuation.
- **SHA (Secure Hash Algorithm)** — a family of content fingerprints; Git uses
  one to identify a commit, and Jig's tools use SHA-256 to record
  exactly which source a generated file was built from.
