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
- **Station** — one fixed step of a *software factory*, with its input, its
  output and who runs it: a skill, an agent or a person. Design and planning
  runs a feature through a pipeline of stations (research, PRD, architecture,
  …); execution runs one work item through a line of them, from pick-up to a
  merged pull request and its follow-ups. See [FACTORY.md](FACTORY.md).
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
  convention → editor/local script → *agent-runtime hook* → *git hook* →
  *CI* → mandatory review step. Each rung is harder to bypass. Jig treats "which rung is this
  rule on, and what promotes it?" as a first-class question — and the rung is
  what the *auditor* scores. *Avoid*: level for a rung (a module's
  *maturity level* uses it).
- **Convention-only** — a rule that exists only as prose or habit, with no
  mechanical check. A tracked state, not a resting place.
- **Git hook** — a script that runs automatically at a git event
  (pre-commit, pre-push, commit-msg). Managed by tools like lefthook, husky,
  or pre-commit.
- **Agent-runtime hook** — a command an agent runtime (Claude Code, Codex)
  runs at its own events: before or after a tool call, when a prompt is
  submitted, when a session starts, resumes or compacts. It sees what no
  *git hook* can (the command about to run, the prompt, the session's
  transcript) and is the softer rung: it runs only where it is registered
  and trusted, so *CI* re-checks whatever it enforces. The *turn budget*
  guard in Jig's *plugin* is an example.
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
- **Release cooldown** — a minimum age a dependency release must reach
  before the dependency updater proposes it or a package manager resolves it
  (a few days), so a release that is yanked or found compromised is usually
  gone before anyone sees it. Held in the updater and in every installer,
  with exemptions as exact package names, and kept in step by one policy
  ([M1](modules/M1-gates-enforcement-ladder/README.md)).
- **Install-script allowlist** — the list of packages allowed to run
  lifecycle scripts (preinstall, install, postinstall, prepare) when
  dependencies are installed; the installer blocks every other package's
  scripts. A listed package is never auto-merged by the updater, since its
  new release runs code on every machine that installs it
  ([M1](modules/M1-gates-enforcement-ladder/README.md)).
- **Policy lockstep** — one policy file states the release cooldown, its
  exemptions and the install-script allowlist; every installer and the
  dependency updater repeat those values in their own configuration and
  units, and a gate checks they still agree, running before any install
  that could run a script ([M1](modules/M1-gates-enforcement-ladder/README.md)).
- **Push protection** — the forge's own secret scan on a push, which rejects
  a push carrying a credential before it lands. The outermost layer of a
  secret scan, behind the pre-commit hook and the blocking *CI* scan over a change's
  commits ([M1](modules/M1-gates-enforcement-ladder/README.md)).
- **Quiet mode** — the form of a *quality gate* command written for an agent
  to read: on success it prints a summary (a *verdict line* and the last few
  lines), on failure the full output, and it keeps the gate's own exit
  status, which a filter in a pipe would replace with its own
  ([M12](modules/M12-parallel-agent-ergonomics/README.md#core-pieces)).
  *Avoid*: silent mode (a flag that hides warnings or diagnostics, which
  quiet mode keeps).
- **Verdict line** — the one line per part that a gate run ends with, naming
  the part and its outcome (passed, failed with its exit status, could not
  run), so the reader of a run with several parts counts one per part; a
  part without one did not run, and never counts as passed.
- **Error classifier** — the check a retrying step applies to a failed
  command's output before retrying: only an error it classifies as
  transient is retried, anything else aborts with the original message; it
  is tested against messages recorded from the real tool
  ([M1](modules/M1-gates-enforcement-ladder/README.md#core-pieces)).
- **Pipeline index** — a page that lists a repository's pipelines and what
  each is for. A derived fact, so it is dropped, checked or generated by
  M2's ladder, never kept by hand
  ([M10](modules/M10-environments-deploy/README.md)).
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
- **Generated-file inventory** — the one declaration of every committed
  *generated artifact*: its outputs, its source, its regenerate command and
  its check. One generic runner runs every declared check in CI, so a
  generator cannot ship without its check and none needs a CI step of its
  own. It is a standalone file or the `generated:` entries of a
  *change-area catalog*.
- **Regeneration after merge** — regenerating a *generated artifact* on the
  push to the *integration branch* instead of demanding it fresh on every
  pull request: for a derivation the merge need not wait for, and as the
  backstop for two pull requests each fresh on its own and stale once both
  merged. The regenerated commit reaches the protected branch through a
  pull request on a fixed branch per generator that a person merges, and no
  commit carries a CI-skip marker.
- **Generator coverage check** — a check that the set of inputs a generator
  reads equals the set that exists, for a generator that selects its inputs
  by a list it maintains. A *freshness gate* proves the artifact equals the
  generator's output and cannot see an input the generator never reads.
- **One-way derivation** — the rule that an artifact which disagrees with
  its source is regenerated, never edited to match: the source layer emits
  every constraint the artifact carries, each link of a chain of derived
  files has its own check, a structured artifact is compared as parsed data
  with both sides normalized identically, and no derived schema is authored
  twice.
- **Commit-nothing check** — a CI check that recomputes a derivable fact
  (a count, a roster) and compares it to what the prose claims, committing
  no generated file — freshness without the merge-conflict liability of a
  committed cache.
- **Pin site** — a place that repeats a toolchain version declared
  elsewhere: a CI setup step, a container build argument, a package-manager
  field, a type package that tracks the runtime. Every pin site is gated to
  equal the one source, and a pin that differs on purpose is a registered
  exception with a reason
  ([M2](modules/M2-generated-artifact-freshness/README.md)).
- **Tally (versus constraint)** — the test for a number in prose. A
  *constraint* (a limit, a budget, `3 retries`) is part of what the text
  means and stays; a *tally* describes an adjacent list (`the 6 passes`,
  `120 skills`) and is a hand-written cache of it, which drifts when the
  list changes: it is dropped, or registered in a *facts registry* and
  checked by a *commit-nothing check*.
- **Facts registry** — the one declaration of each derivable fact prose
  states: its source (globs over the repository's files, or a command) and
  the phrasings a stated copy may take. A *commit-nothing check* re-derives
  each fact on every run and fails when a stated copy disagrees; a fact
  nobody states has nothing to check.
- **Measured marker** — the inline comment `<!-- measured -->` that exempts
  a line from the advisory lint over unchecked *tallies*: the number is a
  constraint or a measurement that stays on purpose. A note after the word
  may say how it was measured.
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
- **Failure channel** — one of the three ways a failure travels, decided by
  the situation rather than the author's taste: an expected outcome the
  caller branches on is returned as the *result type*, a failure that crosses
  a module boundary is thrown as a *domain error*, and a bug is raised as a
  *defect*. See [M15](modules/M15-contracts-errors/README.md).
- **Result type** — the one tagged union a function returns when an expected
  outcome can go either way: a success arm holding the value, or an error arm
  whose error carries a tag the caller branches on. One type per repository;
  a second shape for the same idea is a second channel.
- **Domain error** — a typed error carrying a registered code and the
  metadata the code declares (severity, message key, recovery hint). It is
  what crosses a module boundary, and the only error the *error boundary*
  maps by its code.
- **Defect** — a bug or a broken invariant, raised through one primitive
  (`invariant(condition, message)` or a defect error type) so that "defect"
  is a mechanical property of how it was raised, not an author's judgment. It
  maps to a generic server-side failure and is never caught to drive control
  flow.
- **Error boundary** — the one place errors reach a caller: the handler that
  maps each error to a fixed response shape (code, message key, severity,
  recovery hint, *correlation id*: the complete public field set), turns an
  error it does not know into an opaque generic code, and sends no internal
  detail on a server-side failure. A command-line tool's boundary writes an
  exit status per outcome and one line on standard error instead.
- **Correlation id** — an identifier given to one request and carried
  through its logs, spans and error response, so support can find the
  server-side detail the response does not carry.
- **Detached work** — work started and not awaited (fire-and-forget: a cache
  warmed in the background, a notification sent after the response). Nothing
  is waiting on it, so a failure in it is reported by one helper, with its
  cause, and never surfaces as a rejection.
- **Error-code registry** — the one place every error code a system can emit
  is declared, with its metadata and in one format. Every other copy of the
  codes (a client's code union, a locale's message catalog, the public
  reference) is a *generated artifact* of it, and no code is constructed
  anywhere else. See [M15](modules/M15-contracts-errors/README.md).
- **Orphan code** — a registered error code that nothing outside the
  *error-code registry* references: dead weight in every generated copy, and
  a code a client handles that can never arrive. Its mirror, a **reverse
  orphan**, is a code-shaped literal in a hand-written document that no
  registry entry declares. An audit reports both.
- **Migration ledger** — the record of the migrations that exist to apply,
  in order: a journal file, a changelog, a revision chain, or the files'
  own sequence. Distinct from the table the runner writes to say what it
  applied. The ledger and the files match one to one, in strictly
  increasing order, so no migration can be skipped silently. See
  [M15](modules/M15-contracts-errors/README.md).
- **Fix forward** — correcting a migration that has merged, or any applied
  artifact that must not change, by adding a new one that makes the
  change, never by editing the one that ran.
- **Structure-only migration** — a migration that changes the schema
  (tables, columns, indexes, constraints, functions, policies) and no
  data. A data change is a backfill with a runtime, a lock and a rollback
  story of its own, and lives in a seed, a job or a reviewed one-off.
- **Published interface** — the part of the interface a system serves that
  external consumers build against, as its contract document declares it
  (an OpenAPI document, a protobuf package, a GraphQL schema). An operation
  is internal unless a named external consumer justifies publishing it,
  because a published operation is a commitment to its shape for as long as
  anyone integrates against it; each operation is marked once at its
  source, and the published and the internal documents are generated from
  that one source. See [M15](modules/M15-contracts-errors/README.md).
- **Bounded input** — a request input field whose contract declares what it
  accepts: a maximum length, pattern or format on a string, a maximum on a
  number, a maximum item count on an array, a closed shape on an object, a
  type on everything. The count of unbounded fields in a contract is held
  under a *ratchet*.
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
- **Seed area** — a *change-area catalog* area that a changed file matches
  directly, through its `paths` or a generator's `source`: what the change
  touched. The seeds together with every area their `impliedBy` relation
  reaches, the closure, are the change's consequences; each projection reads
  one of the two.
- **Validation profile** — a named gate depth for a coding agent's own
  pre-commit/push checks, declared in the *change-area catalog* under
  `profiles:` from shallowest to deepest (for example `shallow`, which skips
  the code gates of an area with no code to gate or with code that never
  ships, and `deep`, which runs them all). An area may name its profile; one
  that names none gets the deepest — the same fail-closed default as a file
  matching no area at all.
- **Self-check paradox** — the situation where a *check* validates the same
  data its own trigger condition is computed from (e.g. a catalog's structural
  check, triggered by resolving changed paths *through* that catalog). The
  fix is to run the self-check independently of the thing it's checking —
  unconditionally, or on a hand-written, literal path match — never on a
  selection computed from it; otherwise a change that breaks the check's own
  trigger skips the check along with it.
- **Code-bearing** — a *change-area catalog* area classification: changing
  it means a heavy build/test job must run. Modeled as a checker-side
  deny-list of explicitly non-code-bearing area ids (docs, spike, and
  similar) — never `category` values, since `category` is grouping metadata
  and must never select a build lane; any area not on the deny-list is
  code-bearing by default, so a newly added area fails toward the heavy gate
  instead of silently skipping it the way an allow-list would. This
  deny-list is deliberately generous and must not double as the reachability
  target of *area-class-resolved* — see **Code-bearing anchor**, below. Of a
  commit or a range: one that changes a path verification builds or tests;
  the *verified pointer* watchdog's lag counts only these
  ([M10](modules/M10-environments-deploy/README.md#the-watchdog-decides-by-cause)).
- **Code-bearing anchor** — a *change-area catalog* area explicitly
  designated as one that directly ships — a deployed service *or* a
  published package, not deployment-only (a library-shaped area can anchor
  via a release/publish reference) — *or*, for a non-shipping code-bearing
  area such as a repo-owned test harness, linter, or build tool, one backed
  by an enabled heavy-gate/build CI job running on its own paths — used only
  as the target of *area-class-resolved*'s `impliedBy`-closure check.
  Modeled the opposite way from the *code-bearing* deny-list on purpose: a
  small, hand-maintained allow-list, default-*exclusive*, so it stays a
  genuinely narrower target — reachability against the default-inclusive
  deny-list would be tautological, since closure is reflexive and every
  non-denied area trivially reaches itself. Each anchor carries a
  source-controlled *reference* external to the catalog — a deployment
  manifest or package-publish step for an anchor that ships, or the CI job
  reference for a non-shipping one — proving the reference exists and was
  reviewed — not that the area is currently live.
- **Regex-mirror guard** — the pattern that keeps a hand-written, fast CI
  regex ("did any code change?") honest against the *change-area catalog* it
  duplicates. Two directional checks compare path prefixes — every regex
  alternative's prefix belongs to some catalog area, and every
  *code-bearing* catalog area is matched by the regex — and a third checks
  that every tracked file the regex calls code-bearing matches an area. That
  is prefix synchronization over tracked files, not proof that every path
  the regex could match is in the catalog: a not-yet-tracked file under a
  broad prefix can still match no area.
- **Area-class-resolved** — the *change-area catalog* strict-maturity
  criterion proving a *regex-mirror guard*'s bidirectional sync is
  insufficient on its own: a file can match a real, schema-valid area whose
  `impliedBy` closure never reaches a **code-bearing anchor**, and still
  pass a sync check that only asks "does this file match some area?" The
  criterion requires every file the regex classifies as code to resolve,
  through the closure, to the anchor set — checking against the broader
  *code-bearing* deny-list instead would make the criterion tautological.
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
  change here?", defined by explicit non-code-bearing area ids
  on a deny-list, never by `category` (which is grouping metadata). Used by
  `checkFilterCoverage` to decide which areas a fast
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
  watchdog notices it; when the job belongs to serialized post-merge
  verification, the watchdog also cancels the run, since it holds the slot
  every newer run waits behind.
- **Expression injection** — a value an outsider can set (a branch name, a
  pull-request title, a commit message, a dispatch input) that a CI
  provider's expression syntax substitutes into a script's text before the
  shell reads it, so the value runs as code. Prevented by passing the value
  through an environment variable, which the shell treats as data.
- **Cache key** — the set of inputs a build cache hashes to decide whether a
  stored result answers a task: the sources, the lockfile, the toolchain,
  and the values of the environment variables the task reads. Complete when
  it covers every input that changes the output; a stale result is fixed by
  completing the key, never by switching the cache off (module M13).
- **Cache namespace** — the set of cache entries one key scheme and one
  key-affecting environment can reach. Two pipelines that differ in one such
  variable, or in a credential whose value selects the store (an absent
  secret reads as an empty string), write and read namespaces of their own,
  and the only symptom is one pipeline's *hit rate* at zero.
- **Cache mount** — a directory a container build keeps across builds for
  one build step alone (BuildKit's `RUN --mount=type=cache`). Nothing of it
  is committed to the image, so every step that reads it declares it; M13's
  cache-mount check fails a step that does not.
- **Hit rate** — hits over hits plus misses among one run's cacheable tasks,
  reported in the run's summary. The number that shows a declared cache
  storing nothing, or a split *cache namespace*, which nothing else reports.
- **Runner class** — the size of machine a CI job runs on (its cores and
  memory), bought by the minute at a rate per class and named by a provider
  or vendor label. Chosen per job from its measured work; the jobs that only
  decide or report run on the smallest (module M13).
- **Runner-minutes** — the minutes CI jobs held a runner, summed per job,
  per pipeline or per change; the unit pipeline cost is measured and
  compared in. The class's rate turns it into money.
- **Cost per change** — the runner-minutes spent on CI per merged change,
  counting every run on the change's heads and its post-merge run; the
  number that makes a per-push leg comparable with CI.
- **Verification leg** — one of the places a check runs for one change: the
  editor, a pre-commit or pre-push hook, a remote sandbox, CI. CI is the
  *authoritative leg*, the only one a merge waits for; the others give
  earlier feedback and select no more work than CI does for the same
  change (module M13).
- **Reopen condition** — the checkable statement, written with a decision,
  of what would make the team revisit it: a registered metric, a comparator,
  a threshold and a window. Without one a decision is re-argued instead of
  re-checked.
- **Cost ledger** — the record of every decision that changed what a
  pipeline spends, each with its measurement before and after and its
  *reopen condition*. M13's cost-ledger check fails an entry that lacks
  them or whose after-measurement is past its due date.

## Process

- **ADR (architecture decision record)** — a short numbered document capturing
  one significant decision, its context, and its consequences. Append-only
  history: superseded ADRs are marked, not rewritten.
- **Skeleton file / tissue** — a *skeleton file* holds an architectural contract
  (layer rules, a published interface, the schema of record), is owned by
  people and is read-only for agents; everything else is *tissue*, the
  implementation agents may change freely. Skeleton files are listed in an
  inventory, and a change to one needs recorded authority: an edit to the
  inventory, or a commit trailer naming an approved *ADR*
  ([skeleton-file gate](modules/M5-adr-practice/reference/skeleton-gate/README.md)).
  Unrelated to the "skeleton" templates, which are starting points to copy.
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
- **Conflict hotspot** — a file that conflicts again and again as parallel
  pull requests merge, usually because it keeps in one place something every
  change adds to (a count, a list, a version). Measuring the conflicts
  finds it; moving that fact out of the shared place removes it.
- **Merge replay** — merging the two parents of a past merge commit again,
  without a working tree (`git merge-tree`), to see what conflicted then and
  why. Jig's conflict report replays every merge in a range of time and gives
  each conflicting region a *cause*: a fact every change edits in one place
  (a count, a list, a version), or two changes to the same lines.
- **Changelog** — a file listing each release's notable changes, newest
  first, written for the people who use the *released artifact* it belongs
  to. Jig's follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
  one heading per plugin version, and an **Unreleased** heading for changes
  that no release carries yet. Jig's is written from *change notes* by the
  release step, never by hand.
- **Change note** — a small file a pull request adds with its changelog
  entry and the release it needs, in place of an edit to the changelog and the
  version that every pull request would otherwise make. After the merge, a
  release step writes the notes into the changelog and moves the version, so
  parallel pull requests never conflict over either. Also called a changeset
  or a news fragment by the tools that use them
  ([changes/](changes/README.md), [M12](modules/M12-parallel-agent-ergonomics/README.md)).
- **Released artifact** — a thing a repository publishes at a version for
  others to install, embed or consume: a package, a command-line tool, a
  plugin, a service's client library. Each has one changelog, written for
  the people who use it, and its own version; a change that reaches none of
  them gets no entry. A repository can release several, at their own
  versions ([M16](modules/M16-releases-versions/README.md)).
- **Semantic versioning (semver)** — a version scheme of three numbers,
  `major.minor.patch`, whose change says what an upgrade does to the people
  who use the software: a new major version may break something they rely
  on, a new minor version adds capabilities compatibly, a new patch version
  only fixes defects. Before 1.0.0 a minor version may break things
  ([semver.org](https://semver.org)).
- **Version source** — where a repository keeps its released version, for
  the `changelog` skill: in files (JSON, TOML, YAML or a plain `VERSION`
  file, each at a key) or only in its git tags. The release step moves it, and
  checks that every file agrees first
  ([skill](plugin/skills/changelog/README.md)).
- **Version placeholder** — text a file holds until a release knows its
  version, such as `since: next` in a field that records the version that
  added it. The release step replaces it with the version it makes, in the
  files the configuration names, since a branch cannot know that version
  before it merges.
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
- **Claude Design** — a hosted design tool, and the one external design
  session a *design brief bundle* is prepared for so far. The design work
  happens there, not in the repository; Jig's
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
- **Label taxonomy** — the one file that lists every label an issue may
  carry, in families (types, *flag labels*, *label groups*, *label
  categories*), with the rules between them, so labels are chosen from a
  closed vocabulary and checked before an issue is written
  ([M9](modules/M9-tasks-memory/README.md);
  [file-issue](plugin/skills/file-issue/README.md#the-label-taxonomy)).
- **Label group** — a family of a *label taxonomy* an issue carries at most
  one label of, such as a size or a repository; a required group, exactly
  one.
- **Label category** — a family of a *label taxonomy* whose labels share a
  prefix (`area:billing`, `area:search`) and of which an issue may carry
  several. An open category accepts any name matching a pattern after the
  prefix.
- **Facet** — a label that refines another and means nothing without it,
  such as the stakeholder label beside a human-in-the-loop flag; the
  *label taxonomy* says which label it requires, and the label validator
  rejects it alone.
- **Sensitivity flag** — a *flag label* marking a change that carries extra
  obligations, such as a database migration, a published contract, personal
  data or a manual operational step. `decide` reads them under fixed names:
  `has-migration`, `api-change`, `dpa-relevant` (personal data covered by a
  data-processing agreement) and `manual-ops`. A fired flag sends a call to a human instead of an agent
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
- **Epic census** — the read-only count of how a repository's started *epics*
  stand, kept by the fleet-health sensor: *finished-but-open* (every child is
  closed, the epic is not), *tail-blocked* (nearly all delivered, one or two
  children still open) and *orphan-risk* (no children, project, owner or
  repository). It changes nothing; it points at the epics the closure step
  should look at, and closing one still takes an *acceptance verdict* or a
  *waiver* ([M11](modules/M11-process-observability/README.md)).
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
- **Worktree namespace** — the data namespace (a database schema, a
  database, a key prefix) a *worktree* derives from its own identity, so
  worktrees sharing one database server never share tables. Created with an
  owner and an expiry, reaped by that owner once the worktree is gone or the
  expiry has passed, and never the production namespace, which carries no
  prefix.
- **Worktree scratch** — working files the agents of one *worktree* keep in
  a gitignored directory of it (`.context/` in Jig's skills). Every agent in
  that worktree shares it, each file with one writer or as an append-only log
  under a lock; they outlive one session but only a session in that same
  worktree sees them, so nothing another worktree, or a person not working
  in it, needs belongs there
  ([memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md)).
- **Machine-local store** — a folder outside every *worktree*, one per clone
  and at a path the user can move, where tools keep what the worktrees of one
  machine share: locks, *leases*, a review loop's records, a working copy of
  a brief. Not a memory tier: it must hold no work state the tracker lacks,
  so that deleting it costs a rebuild and loses no decision
  ([memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md#the-machine-local-store)).
- **Handoff** — the note one session leaves so another can carry on: what is
  done, what remains, what was decided, what is uncertain, and the command
  that resumes the work. It goes on the tracker item, never in *worktree
  scratch* ([memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md#handoffs)).
- **Monorepo** — one repository holding many applications/packages, usually
  with a shared task runner and shared quality gates.
- **Verified pointer** — a branch or tag that a delivery pipeline advances only
  when post-merge verification passes, so "merged" and "verified" stay distinct
  facts. Deploys ship the verified pointer, not the latest commit; a watchdog
  decides why the pointer lags the default branch, heals a *dropped trigger*
  within a budget of attempts, and pages on the faults a person must repair
  (heals that keep ending without a verdict, a pointer that did not move after
  a passing verification, a stalled runner queue, divergence, an observation
  it cannot read); a running verification, failed gates and a
  documentation-only lag need nothing.
- **Dropped trigger** — a push the CI provider never turned into a run, or a
  run that ended without a verdict (cancelled, timed out, never started), so
  the gates never decided and nothing failed. The one cause of a lagging
  *verified pointer* a watchdog heals on its own, by dispatching verification
  at the tip once a grace window has passed, until a budget of such
  dispatches at the same tip is spent.
- **Back-merge** — the recovery for a *verified pointer* that diverged from
  its branch: a merge commit on the integration branch whose tree is the
  branch's own and whose second parent is the pointer's tip. It restores the
  ancestry a fast-forward needs without merging any of the diverged content;
  forcing the pointer back is never the recovery.
- **Cadence registry** — the one file listing every scheduled job and how
  often it must produce a result, with the grace it may be late by and the
  number of failures in a row that make it *red*. A scheduled workflow missing
  from it is a job nobody watches, so a check fails it. See
  [M11](modules/M11-process-observability/README.md#heartbeat-a-stopped-schedule-is-stale-never-green).
- **Stale (job)** — the class of a scheduled job with no result inside its
  cadence plus grace, or none at all, unless its failures in a row already
  make it *red*: it stopped running, was disabled, only
  ever got cancelled, hung, or never ran. The job's last result is old, not
  current, so a stale job is never green, and a watcher fails for it as for a
  red one. A cancelled or skipped run is not a result.
- **Dead-man's switch** — a check that alarms when an expected signal does *not*
  arrive. The heartbeat watcher reports to an external monitor on success and
  on failure; if the watcher itself stops, the report goes missing and the
  monitor raises the incident. Reporting only on failure would make a dead
  watcher look like a healthy quiet one.
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
- **Reaper (symmetric teardown)** — the scheduled job that removes what the
  delivery system created once it has expired or lost its creator: a
  preview deployment, an *ephemeral environment*, a test tenant, a
  *worktree namespace*. Teardown is symmetric with creation: whatever
  creates a resource writes its owner and its expiry at creation, and the
  reaper keyed to that owner reads them back. A destructive reaper reports
  by default, acts only on an explicit opt-in, and refuses production.
- **Promotion gap** — the work items that have reached one environment but
  not the next, computed from version-control ancestry as the commits
  between the two environments' pointers (`production..verified`), never
  kept by hand in tracker fields. Its count per environment pair is a
  process metric.
- **Environment currency** — whether an environment that is deliberately
  behind runs a version a given check applies to. The floor is derived from
  history (the newest commit touching a path the check depends on), the
  deployed version is read from the environment's pin, and ancestry decides;
  a non-current environment's cell is removed from the check's matrix, not
  skipped, so it reports neither a false red nor a false green.
- **Test tier** — a class of test suite with its own trigger and time
  budget: **unit** tests (one piece of code, no real services) on every
  push, **integration** tests (code against real services such as a
  database) when their paths change, and *end-to-end tests*: the full sweep
  nightly or on demand, and the tests of journeys nothing else checks on
  every push to the default branch ([M14](modules/M14-testing-strategy/README.md)).
- **End-to-end test (E2E)** — a test that drives the whole running system
  through its real interfaces, as a user or client would. The slowest *test
  tier*, so the full sweep, whose journeys other checks already cover, runs
  on a schedule rather than per change; end-to-end tests that are the only
  check of a critical journey run on every push to the default branch,
  before the `verified` pointer moves.
- **False green** — a check that reports success while the thing it claims
  to check is broken: a suite that skipped itself, a *test double* that
  accepts anything, a test that was never seen to fail.
- **Skip tripwire** — a check at the end of a CI job that reads the test
  runner's machine-readable report and fails the job when the suites it
  exists for executed zero tests (the test cases not skipped), so a suite
  that skipped itself, or a selection that matched nothing, cannot report a
  *false green* ([M14](modules/M14-testing-strategy/README.md)).
- **Flaky test** — a test that sometimes passes and sometimes fails on the
  same code, because of timing, shared state or an unreliable dependency.
- **Flaky-test quarantine** — setting a *flaky test* aside so its failures
  stop blocking merges while it is fixed, without hiding them: the test keeps
  running and reporting, and the quarantine list is reviewed and short
  ([M14](modules/M14-testing-strategy/README.md) lists it as future work).
- **Stale test** — a test whose failure predates the change under work and
  was not caused by it: its subject moved, its premise no longer matches the
  code, or the base it was last green on has changed since. Known only by
  reproducing the failure with a *fresh-base probe*; fixed inline when the
  fix is cheap, otherwise deleted with a tracker item recording what it
  covered ([M14](modules/M14-testing-strategy/README.md)).
- **Fresh-base probe** — running a failing check again on a freshly fetched
  base branch, in a throwaway *worktree*, before the failure is attributed to
  a change. The failing test passes on the base (the failure is the
  change's), fails there, read from that test case's own result in the
  runner's report rather than from its name in the output (a *stale test*),
  or the probe cannot decide (the fetch failed, no worktree, a different
  failure), and a failed fetch is never read as a pass
  ([M14](modules/M14-testing-strategy/README.md); `fix-ci` ships it as
  `probe-base.ts`).
- **Behaviour pin** — a test that asserts the defective behaviour of a
  dependency that a workaround compensates for, run against the real
  dependency and named for the workaround. It fails on the release that
  fixes the defect, which is the signal to retire or adapt the workaround,
  never to update the assertion
  ([M14](modules/M14-testing-strategy/README.md)).
- **Runtime canary** — a scheduled job that runs the most informative test
  suites, and a compiled-binary smoke test, against the next release of the
  runtime or a driver (its canary, nightly, beta or release-candidate
  channel), blocks nothing and records the exact build it used, so an
  incompatibility is known before the upgrade and a red run can be
  attributed ([M14](modules/M14-testing-strategy/README.md)).
- **Test double** — a stand-in for a real dependency in a test (a fake,
  stub or mock). An honest one rejects what the real dependency would
  reject, so a wrong call fails the test instead of passing it.
- **Mutation check** — proving a test can fail by breaking the code it
  covers on purpose (misspelling a flag at a call site, removing a
  condition), watching the test fail, then restoring the code.
- **Injected clock** — the current time handed to code as a dependency
  (an object with a `now()` method) instead of read from the system, so a
  test can fix or advance time.
- **Isolation predicate** — the condition that hides data a caller must not
  see: another tenant's rows, soft-deleted records, what an authorization
  rule denies. Tested against the engine that evaluates it, with data that
  would leak if it were missing.
- **Test-data builder** — a function that returns one value of a declared
  contract type with fixed defaults, which a test overrides field by field;
  a change to the type fails the type check, or the completeness lint an
  ecosystem needs for that (Go's `exhaustruct`), instead of a test. Unlike a
  *test-data factory*, it makes values in the test process rather than
  seeding a database.

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
- **Audit catalog** — the one list of the *drift-prone areas* no gate fully
  covers, each with an owner, a cadence, the tooling that audits it (or
  `manual`), the date it was last audited and the work it left open. An area
  audited only by hand is tracked there as a gap in tooling. It records the
  health of a repository's code and systems; `/jig:audit` records whether the
  repository has adopted Jig.
- **Drift-prone area** — a part of a repository or its systems that can go
  wrong without any gate failing, such as a diagram that no longer matches the
  code or settings kept in a hosted service. See *drift*.
- **Deep-review tracker** — an optional table beside the *audit catalog* that
  versions the list of dimensions a deep review covers and queues a re-review
  of every area last reviewed under an older version.
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
- **Severity format** — how one automated reviewer writes a finding's
  severity: its login, the shape of the field (a bold word, a priority badge,
  one field of a pipe-delimited header) and how its words map onto Jig's
  `blocker`, `high`, `medium` and `low`. Read only from comments that login
  posted; a finding no format reads has an unknown severity, which leaves the
  *decline ladder* inert for it where the repository's review-triage file
  lists `severity` under `fail_open.inert_when_unknown`
  ([severity formats](plugin/EXTENDING.md#severity-formats)).
- **Human-decided span** — a part of a pull request that records a person's
  decision (a "Decided by …" line, a decisions table, an operations follow-ups
  block). A review fix may correct the facts or wording around it, but may not
  change the decided value or add or change a **normative rule** inside it (a
  "must", a limit, an exception, a condition) without that person's approval;
  such a finding is escalated or parked
  ([triage rubric](plugin/skills/resolve-review-comments/references/triage-rubric.md#guardrails)).
- **Terminal state** — one of the named end states a *PR drive loop* stops
  in (converged, pull request merged or closed, round limit reached, waiting
  on a human, …), each reported with a documented exit code, so a script or a
  person can tell from the exit alone what to do next.
- **CI hold** — an opt-in label on a pull request that the repository's
  continuous-integration workflows honour: while it is present they skip
  their expensive jobs and a required check fails (the *held-head check*);
  removing it runs every required check again on the same head, and only
  results that started after the removal count. A *PR drive loop* applies it
  between review rounds and removes it at convergence. The practice is
  [M13's](modules/M13-pipeline-economy/README.md#7-hold); drive-pr's
  `ci.hold_label` is its driver side.
- **Held-head check** — the step of a required check that fails while a
  pull request carries the *CI hold* label, so a held head is visibly not
  mergeable from the moment the label lands until the release; its message
  names the label to remove. M13's workflow-convention lint accepts it in
  one shape only.
- **Required checks** — the continuous-integration checks a repository's
  branch protection requires to pass before a pull request may merge. A drive
  derives them from the protection settings unless the repository lists them
  (`ci.required_checks`).
- **Lease** — a short-lived, renewable claim recorded on disk that says which
  session currently owns a piece of work, such as a pull request's review
  threads. Other sessions read it and stand back; a lease whose holder died
  expires instead of blocking forever.
- **Directory fence** — a nonempty directory retained at the path reserved
  for one lock acquisition after its release or recovery. A delayed process
  trying to move that same acquisition there cannot replace the nonempty
  directory, so it cannot remove a newer holder's lock. Windows retains this
  shape because a directory move there can replace an ordinary file.
  *Avoid*: directory guard.
- **Control channel** — the way a person, or the session that started it,
  reaches an agent running unattended without killing it, kept with that
  agent's worktree (in its *worktree scratch*, or in the runner that started
  it). Its **directives**
  (hold the push, pause, stop, resume) are a closed set, enforced by code at
  fixed checkpoints, and a directive that cannot be read counts as in force;
  its **notes** are free text the agent may read and never has to obey.
  `drive-pr` ships one as the drive mailbox, an inbox file in the
  worktree scratch that any sender appends to
  ([M12](modules/M12-parallel-agent-ergonomics/README.md)). *Avoid*: mailbox
  for the general idea.
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
- **Post-merge stage** — the step after a pull request merges that settles
  what the merge still owes: for each class of residual obligation (the
  tracker state, deferred findings, out-of-tree actions, temporary
  scaffolding, live verification, the next step) it records *owed* (filed or
  done) or *not owed* (with the evidence that settled it). "Nothing found" is
  not evidence
  ([M7](modules/M7-pr-lifecycle-review/README.md#core-pieces)).
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
- **Reflection store** — where reflection's records accumulate, shared by
  every repository that reflects into it: an append-only log of *findings*
  (what a session learned about the scaffolding) and *decisions* about them,
  from which a finding's status is computed. Any store answering the same
  contract (`check`, `append`, `list`, `diagnose`) will do; a folder of files
  is the default.
- **Reflection journal** — a worktree's own file of findings captured as they
  happen and not yet sent to the *reflection store*, so capturing one never
  depends on the store being reachable.
- **Unhelpful content** — a kind of reflection finding: instruction text, in
  an instructions file or a skill, that cost an agent context without helping
  it, such as a section it loaded and never used, or one that misled it.
  Recording it beside the failures keeps the cost of always-loaded context
  visible ([reflect](plugin/skills/reflect/README.md)).
- **Owner marker** — the line `Jig owner: <owner>` that reflection writes into
  the description of a class's tracker issue, so the issue says whose it is.
  `<owner>` is `repository:<id>` or `tool:<name>`, with every character other
  than letters, digits and `.:/-` percent-encoded so that the tracker's
  markdown rewrites cannot make two owners read alike. Several repositories
  can share one tracker team and one `pattern:<class>` label; reflection
  attaches a finding only to an issue carrying its own owner's marker
  ([reflect](plugin/skills/reflect/README.md)).
- **Conformance suite** — a set of checks any implementation of a contract
  must pass, run against the implementation itself, so a second
  implementation is held to what the first was tested for.
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
- **Model tier** — the cost class of model an agent or skill runs on, named by
  role: *Judgment*, Strategic, Execution or *Scout*. Derived from the model
  family it declares, not from how important its job sounds. See the
  [model routing policy](modules/M0-instruction-architecture/reference/model-routing-policy.md).
  *Avoid*: model level (a *maturity level* is something else).
- **Judgment tier** — the narrowest *model tier*: the top reasoning model,
  admitted only for a *decision layer* that is judgment-only, low-volume and
  high-leverage, and that a mechanical rule already tried and failed to
  settle.
- **Decision layer** — the one contested call inside a larger procedure, split
  out so that it alone runs on an expensive *model tier* while the evidence
  gathering and ranking around it run on cheaper ones. The unit the *Judgment
  tier* is assigned to, rather than a whole skill or agent.
- **Family alias** — a model name that selects a model family rather than
  one release (`opus`, `sonnet`). A pin written with it ordinarily resolves to
  the family's current release, though not always: a session already on an
  older release of that family, or a third-party provider's mapping, can
  resolve it to an older one
  ([resolution exceptions](modules/M0-instruction-architecture/mappings.md#family-aliases-and-pins-in-claude-code)).
  A versioned model id freezes the pin instead.
- **A/B baseline** — the cheaper model a premium model assignment is compared
  against, recorded in its own field next to the assignment: as a family
  alias with the planned comparison until the comparison runs, then with the
  exact release that was measured. It is what a downgrade returns to; it is
  never itself a pin.
- **Cost per completed task** — what a piece of agent work costs from start to
  a finished, accepted result: every token stream billed, every turn, retry
  and review round. The measure a move between *model tiers* on cost grounds
  must compare; list price per token is not it.
- **Model roster** — the list of which agent or skill runs on which *model
  tier*, generated from their metadata and checked for drift, never kept by
  hand.
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
  moves, no held decline and no *left on purpose* entry leaves on purpose.
  The *audit sheet* marks and lists each one, so every gap is either
  addressed or visibly left.
- **Left on purpose** — a gap within the target that the auditor chose not
  to recommend work for now, listed in the *report source* with the reason
  and when to revisit it. The *audit sheet* shows it in its own list rather
  than as an *uncovered gap*. Unlike a decline, the team did not decide it.
- **Not examined** (audit) — the score of a maturity criterion beyond the
  target of the profile the audit was run for, which the audit chose not to
  examine so its effort goes to the criteria the target asks for. It meets no
  bar, is never a gap, and a later audit reports it as examined rather than
  as fixed.
- **Applied recommendation** — a recommendation carried out after the audit
  that made it, in the same session or later, marked in the *report source*
  with the pull request or commit that applied it. The *audit sheet* shows it
  as done and asks for no decision on it; the *audit record* still scores the
  commit it audited.
- **Explored profile** — a profile the *audit sheet* is rendered against to
  see how the repository would read under it, without changing the profile
  the *audit record* holds. The sheet labels it explored, not recorded.
- **Alternative profile** — the other profile the facts could support when
  they sit near a boundary (deploys, but one person commits), which the
  *audit sheet* shows beside the suggested one with how many modules would
  be at their target under it.
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
- **Turn budget** — the number of agentic turns (API round-trips: one request
  to the model and its reply, which may hold several content blocks) an agent
  runtime allows one prompt before it aborts the session outright, with no
  handoff written. The plugin's turn-budget guard, an *agent-runtime hook*,
  counts the round-trips off the transcript and tells the agent to wrap up
  within a margin of the cap.
- **Shared code (`plugin/shared/`)** — the plugin's code that more than one
  skill uses: the configuration reader, the process runner, the
  command-line boundary, the logger. Skills import it by relative path; it
  imports nothing from a skill.
- **Command-line boundary** — the one wrapper around a script's entry point
  that turns its result or failure into an exit code and a message, so every
  script reports failures the same way.
- **Type guard** — a function that checks at run time that a value has a
  given shape, and tells the type checker so when it does. Data read from
  outside the program (JSON, a configuration file) is checked by one before
  it is used.
- **Standard error (stderr)** — the output stream a program writes its
  diagnostics to, separate from standard output, which carries its result.
- **Stack trace** — the list of function calls that were in progress when an
  error was raised, innermost first; it shows where a failure happened.
- **Log level** — how severe a log line is (error, warn, info, debug). A
  program set to one level writes the lines at that level and the more
  severe ones, and leaves out the rest.
- **Marketplace** — a catalog an agent tool installs plugins from; usually a
  Git repository with a manifest listing its plugins. This repository is its
  own marketplace.
- **Consumer overlay** — a repository's own values for a shared procedure,
  such as its gate command and reviewer names, kept in
  `.config/jig.yaml` and read by the procedure when it runs.
  The procedure stays shared while the values belong to the consumer. Every
  field is in [plugin/CONFIGURATION.md](plugin/CONFIGURATION.md).
- **Composer** — a repository's own short script that runs a Jig tool's
  library with that repository's values where configuration cannot express
  them: extra catalog fields, extra outputs, its own validation policy. The
  tool stays shared; the composer holds only what is the repository's
  ([change-areas](plugin/skills/change-areas/README.md#a-composer)).
- **JSONL (JSON Lines)** — a text format with one complete JSON value per
  line. Appending a record is appending a line, and a reader can process the
  file line by line, so it suits logs that only grow.
- **Front matter** — a block of `key: value` lines between two `---` lines
  at the very top of a Markdown file, holding facts about the file rather
  than its text, such as a change note's `release:`.
- **Common Changelog** — a stricter changelog format than Keep a Changelog
  ([common-changelog.org](https://common-changelog.org/)): written at
  release time, no Unreleased section, the change types `Changed`,
  `Added`, `Removed` and `Fixed`, and every entry one line with a reference
  to the change and its authors (which a project with one contributor may
  leave out).
- **Ruleset** — GitHub's set of rules for a branch or tag (a pull request
  required, checks that must pass, no force pushes), with a list of
  *bypass actors*: the people, teams or apps allowed past the rules. The
  older branch protection grants its exceptions one rule at a time (who may
  push, who may skip the required pull request); a ruleset's bypass actor
  passes every rule in that ruleset, so rules an actor must not pass go in a
  ruleset that does not name it.
- **GitHub App** — an identity an organization creates for automation, with
  only the permissions it is given and on only the repositories it is
  installed on. A workflow mints a token for it that lasts an hour, so no
  person's credential is stored.
- **Deployment environment** — a named set of secrets in a CI system that
  only some branches may use; GitHub Actions calls it an *environment*. A key kept in an
  environment restricted to `main` cannot be read by a workflow running on
  any other branch.
- **Composite action** — a GitHub Actions action whose `action.yml` combines
  several steps into one, used like a single step. A workflow uses one from
  its own repository by path (`uses: ./path`) or from another repository
  with `uses: owner/repo/path@ref`; GitHub then fetches it at the pinned
  ref, so a workflow can run that repository's scripts without checking it
  out.
- **App manifest** — a file describing a *GitHub App* (its name, its
  permissions, whether it has a webhook) that GitHub turns into a new App
  when a person posts it, so the App is created with exactly the
  permissions written down rather than ones picked by hand.
- **Release pull request** — a pull request holding a release step's
  commit (the changelog section and the moved version), regenerated by CI
  after each merge and merged by a person, for a repository whose
  integration branch lets no automation push past its rules.
- **Releasing commit** — the commit on the integration branch that released
  a version: the first on the branch's own (first-parent) history whose
  changelog has that version's heading. Its tag goes on that commit once
  its own required checks pass, and on no other.
- **Release channel** — a named address that machines install a released
  artifact from, which moves to a new version on its own schedule: one
  channel takes every version as it ships, another only the versions that
  proved themselves on the first. A machine follows a channel and receives
  its updates, where a pinned version receives none. npm's dist-tags
  (`latest`, `next`) are channels; Jig's plugin has `latest` and `stable`
  ([plugin/README.md](plugin/README.md#release-channels)).
- **Trusted publishing** — publishing to a package registry without a
  stored token: the registry is told once which repository and workflow may
  publish a package, the publishing job proves it is that workflow with a
  short-lived identity token from its CI provider (OpenID Connect), and the
  registry returns a credential that expires within minutes. npm, PyPI and
  crates.io offer it.
- **Provenance** — a signed, public record a package registry keeps beside
  a published version, naming the repository, commit and workflow that
  built it, so anyone installing it can check where it came from. A
  publish attestation, such as PyPI's, is narrower: it names the workflow
  that uploaded the file, which proves where it was published from, not
  where it was built.
- **Preview package** — a package built from a pull request's commit, so a
  consumer can install and try the change before it merges. It is not a
  release: no changelog entry, no version the release step chose, no tag,
  and it moves none of the release channels; one published to the
  registry gets a channel name of its own that no release uses.
- **Promotion** — moving a version from a release channel that takes every
  version to one that takes only proven ones, once a written rule holds (a
  time on the first channel, checks green, no open regression). A
  **rollback** moves the channel back to a version it carried before.
- **Soak** — the time a version must spend where some machines run it before
  it is promoted, so problems its tests missed surface first.
- **TOML (Tom's Obvious, Minimal Language)** — a configuration file format of
  `key = value` lines grouped under `[section]` headings. Python projects
  (`pyproject.toml`) and Rust crates (`Cargo.toml`) keep their name and
  version in it.
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
- **POSIX** — the common standard behind macOS, Linux and other Unix-like
  systems: how processes are grouped and signalled, which commands exist
  (`ps`, `sh`), how file permissions work. Windows does not follow it, so
  code that relies on it needs a separate path there.
- **WSL (Windows Subsystem for Linux)** — a Linux system that runs inside
  Windows. Tools that need *POSIX* run there unchanged.
- **PATHEXT** — the Windows environment variable listing the file endings
  (`.exe`, `.cmd`, `.bat`, …) that count as runnable programs. Windows finds
  a command typed without an ending by trying each one in turn, so `claude`
  can name `claude.cmd`; a program that starts commands itself has to do the
  same search.
- **Job Object** — a Windows grouping of processes that the system can end
  together. A process a job member starts directly joins the job unless the
  job allows it to break away, and ending the job stops every process in it,
  which a *POSIX* process group does not guarantee. Work a member asks
  another service to start (through WMI's `Win32_Process.Create`, for one)
  is not in the job and survives it.
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
  implementation of that set for a particular tracker. The skills call the
  interface, so supporting a new tracker means writing an adapter, not
  editing the skills, except where a skill still calls Linear directly: the
  review skill's deferral step (roadmap item 10), the one operation the
  interface does not have yet (attaching a file), and a few reads of
  Linear's own answers.
  [plugin/EXTENDING.md](plugin/EXTENDING.md#issue-tracker) lists
  them under "What still assumes Linear". Linear's adapter is built;
  adapters for Jira and for a plan file kept in the repository are planned
  ([ROADMAP.md](ROADMAP.md) item 12).
- **Batch** — several small, independent issues from one area of the code
  closed by one pull request, with one commit for each issue, so the review
  is paid once instead of once per issue
  ([work-batch](plugin/skills/work-batch/README.md)).
- **Batch anchor** — what a batch is drawn from: an area of the
  *change-area catalog*, a path in the repository, an epic, or one issue
  whose area's other open issues join it.
- **Solo-only issue** — an issue that never joins a *batch* because it
  carries a *sensitivity flag*, the human-in-the-loop label or the
  manual-operations label: each starts a review gate or a human step that
  would apply to every other change in the pull request.
- **Launcher** — the program an issue tracker's "open in coding agent" button
  runs. Jig's assigns the issue to whoever opened it, saves the whole
  issue to a file the agent reads, chooses the repository from the issue's
  label and opens a workspace for the agent through a *workspace provider*.
- **Workspace runtime** — the app or terminal tool that creates an agent's
  workspace, usually a git *worktree*, and runs the agent session in it.
  Jig's practices name none; its tooling targets Herdr first and also
  supports others, Conductor among them
  ([ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)).
- **SSH (Secure Shell)** — the standard way to log in to another machine
  and run commands there over an encrypted connection; a *workspace runtime*
  can use it to run an agent's workspace on a remote host.
- **Workspace provider** — the part of the *launcher* that opens the agent's
  workspace in one *workspace runtime*. Providers differ only in that last
  step, so adding one does not change the rest of the launcher; which exist
  and which are planned is in the
  [launcher's README](tools/launcher/README.md#providers).
- **Deep link** — a web-style address (`<app>://…`) that opens a desktop
  app at a given place; the launcher's Conductor provider uses one to open a
  workspace with the prompt and the repository already filled in.
- **Test shard** — one slice of a test suite's files, run as its own CI job
  so a long suite finishes in a fraction of the time on parallel machines.
- **Validation plan** — the checks a change must pass, worked out from the files
  it touches: local checks, verification checks, whether a *remote test box* is
  needed, and which review skills to run. A repository supplies it as a command
  that reads changed files on stdin and prints JSON
  (`drive.validation_plan_command`); without one the plan is the gate command
  alone ([drive-pr](plugin/skills/drive-pr/README.md)). The
  [change-areas](plugin/skills/change-areas/README.md) skill prints one from
  the *change-area catalog*.
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
  AAA are increasingly strict.
- **CSS (Cascading Style Sheets)** — the language a web page's look is
  written in: layout, colors, type, and animation, kept apart from the
  page's content.
- **Bleed** — a picture that runs past the edge of the page or window
  instead of stopping at its column, a term taken from print
  ([design/website.md](design/website.md)).
- **Jig model** — the figure on the website's home page: a three-dimensional
  model of a doweling jig that the browser draws as a technical drawing
  (paper faces, ink edges) in the page's own colors, closes as the reader
  scrolls, and turns a few degrees toward the pointer. It needs WebGL (the
  browser's drawing interface for three-dimensional graphics) and
  JavaScript; without them, for a reader who asks for reduced motion, or on
  a narrow screen, a still drawing stands in its place
  ([design/website.md](design/website.md)).
- **GLB** — the binary form of glTF, the standard file format for
  three-dimensional models on the web: one file holding a model's parts,
  their placement, their materials and its animations, which a browser can
  load and draw ([design/website.md](design/website.md)).
- **UV map** — the flat layout a three-dimensional model's surface is
  unfolded onto, giving every point on it two coordinates (called U and V)
  so that a pattern or an image can be drawn across the surface; the website
  draws the jig model's grain and hatching from its UV maps
  ([design/website.md](design/website.md)).
- **Inverted hull** — a way to draw a 3D model's outline: a second copy of
  each part, pushed slightly outward and with only its inside faces drawn,
  in ink. Where the part's edge curves away from the viewer, the copy shows
  past it as a line, so smooth shapes such as a cylinder's sides get an
  outline that edge lines alone would miss
  ([design/website.md](design/website.md)).
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
- **Trace span** — a timed record of one operation, such as a command or a
  polling wait. A trace groups related spans, and each span identifies the
  parent operation that started it, including across child processes.
- **JSX** — an HTML-like markup syntax that some JavaScript and TypeScript
  files embed, compiled to ordinary function calls. A tool that reads source
  as text must handle it or say that it does not.
- **ASCII (American Standard Code for Information Interchange)** — the basic
  character set containing English letters, digits and common punctuation.
- **SHA (Secure Hash Algorithm)** — a family of content fingerprints; Git uses
  one to identify a commit, and Jig's tools use SHA-256 to record
  exactly which source a generated file was built from.
- **llms.txt** — a Markdown file at the root of a website that gives language
  models and coding agents a short index of the site's content, each entry a
  link to a page as Markdown, so they need not read the site's HTML. Jig's
  website derives its own from the same documents as its pages
  ([design/website.md](design/website.md)).
- **LOC (lines of code)** — the lines of a source file that are neither blank
  nor only a comment. The [code-stats](plugin/skills/code-stats/README.md)
  skill reports it beside all lines, comment lines and blank lines.
- **Shebang line** — the first line of a script, starting `#!`, that names
  the program to run it (`#!/usr/bin/env python3`). A file without an
  extension can be recognised by it.
- **Git attributes** — settings git keeps per path in `.gitattributes`
  files. The `linguist-vendored`, `linguist-generated`,
  `linguist-documentation` and `linguist-language` attributes, a convention
  of GitHub's language statistics, mark a file as another project's code, as
  generated, as documentation, or as written in a named language.
- **Test fixture** — data a test reads (an input file, a recorded response, a
  snapshot of expected output), as opposed to the test's own code.
- **DDL (data definition language)** — the statements that define a
  database's structure (tables, columns, indexes), as opposed to the queries
  that read and change its data. Schema files and migrations hold it.
- **Database migration** — a file that changes a database's structure, or
  moves its data, from one version to the next; migrations are applied in
  order.
- **Workspace manifest** — the file that lists the packages or modules of a
  repository that holds several: `pnpm-workspace.yaml`, a `package.json`
  `workspaces` list, `go.work`, Cargo's `[workspace]`, Gradle's
  `settings.gradle`, uv's `[tool.uv.workspace]`.
- **Unclassified share** — the part of a repository, in files and in
  *LOC*, that the code-stats skill could not place: files no kind rule
  matched, or no area rule matched, so they fell to the default area. A large
  share means the repository's `code_stats` configuration needs work.
- **Code-stats dimensions** — the values the code-stats skill gives every
  tracked file: its *area* (what the file is for: product code, tests,
  tooling, agent scaffolding, docs, build, database, ops), its *kind* (what
  the file is: code, test, docs, configuration, data, generated, fixture,
  asset, vendored), its language, and its *module* (the unit of the
  repository it belongs to, from the *workspace manifests*). Unrelated to
  the change-area catalog's areas.
- **Classify command** — a command a repository supplies to the code-stats
  skill (`code_stats.classify_command`) when globs cannot describe its
  layout: it reads the tracked paths and prints, per file, the area, kind,
  language or module that overrides the skill's own classification.
