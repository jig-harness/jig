# Triage rubric — materiality, scope, and who decides

How a review finding's **disposition** is chosen: `accepted`, `rejected`,
`wont-fix`, `deferred`, or `moot`. The goal is that most threads are decided
*mechanically* by this rubric, the ambiguous middle goes to the **Review
Arbiter** agent, and a human is interrupted only when the arbiter escalates.
Referenced from [the procedure](../SKILL.md) § 3. Consumer policy supplies
project stances and sensitivity definitions. `<skill-dir>` in the commands
below is this skill's directory, the parent of this `references/` directory.
Run the commands from the repository root.

Why this exists: a strong reviewer produces more valid findings than a PR can
absorb. Without a materiality bar the loop drowns in fractal detail — every
round implements marginal fixes, defers the rest into tracker noise, and
interrupts a human for scope calls that have obvious answers. Discretion is
built in here instead.

## Priorities

Ordered by what a missed finding costs later:

1. **CI pipelines and quality gates** — a defective gate silently hides whole
   classes of future bugs, or bakes in an inefficiency paid on every run.
   Highest priority; fix even when effortful.
2. **Production code** — correctness, security, tenant isolation, data loss.
3. **Docs** — factual correctness matters; churn-shaped polish does not.
4. **Tests** — a coverage gap is more tolerable than a production defect.
   Exception: a *vacuous* test (one that cannot fail) is a gate defect and
   ranks with priority 1, not here.

## Evaluation order

Evaluate stance, then scope, then materiality — a later step never overrides
an earlier one:

1. **Stance** — a finding that contradicts a deliberate project stance
   (for example, asking for a compatibility layer a documented policy excludes) is
   `rejected` no matter how trivial the edit would be — see
   [Standing rejections](#standing-rejections).
2. **Scope** — if the fix would widen the PR beyond what the
   [scope heuristic](#scope-heuristic) allows, importance does not buy it
   passage: obligatory work is `deferred`, optional work is `wont-fix`. A
   high-priority finding that depends on another branch or belongs in its own
   PR still defers — priority makes the follow-up urgent, not this PR wider.
3. **Materiality** — for findings that survive both filters, the first
   matching row decides. **"Trivial" is priced on the class, not the
   instance**: roughly ≤ 10 changed lines, localized, no contract change —
   measured for the whole named class *after* the mandatory sibling sweep
   (`SKILL.md` § 3) is scoped, never for the one instance in the finding.
   Scope the sweep first, then judge. A sweep that touches more than ~3
   files or crosses a contract is **Involved** and falls through to the
   tier rows. The sweep itself still happens for accepted findings — only
   the acceptance decision sees the true size first. A small instance can
   conceal an involved class-wide change, so acceptance must be priced against
   the complete sweep rather than the original anchored hunk.

| Finding | Effort | Disposition |
|---|---|---|
| Any valid finding | Trivial | `accepted` — Boy Scout rule: easy fixes are taken regardless of impact |
| CI/gate defect, security, tenant isolation, production correctness, migration | Involved | `accepted` — bias strongly toward fixing |
| Test-only gap, doc polish, style/naming, hypothetical hardening | Involved | `wont-fix` — valid, deliberately declined, no follow-up |

Both `accepted` rows are then filtered by the [decline ladder](#the-decline-ladder),
which qualifies them from a configured round onward.

The `wont-fix` / `deferred` boundary is obligation, not effort: work that must
eventually happen is deferred with a tracked issue; work that merely *could*
happen is wont-fixed with no issue. Deferring optional polish is what floods
the tracker; wont-fixing obligatory work is how findings get lost. When
obligation itself is unclear, that is an arbiter question.

Two signals sharpen materiality calls on multi-round PRs:

- **Independent convergence** — two reviewers filing the same defect in one
  round is strong evidence the defect is **real**; on its own it says nothing
  about whether the *model* or one omitted case is wrong, and escalating on
  that signal alone widens fixes against this skill's own minimal-fix bias.
  What promotes it to a structural call is a shared root cause: the findings
  name the same abstraction failing in different places (another untrusted-
  input vector, another nesting depth for a text scanner, another heuristic
  for a provenance question). With that evidence, reach for the structural fix
  (move the granularity, parse instead of text-matching, pin the artifact
  verbatim) rather than one more condition — the same threshold as `SKILL.md`
  § 3 "Two rounds on one root cause", read across reviewers instead of across
  rounds. Without it, fix the case.
- **Ask valid, mechanism wrong** — when a finding's stated failure scenario
  does not reproduce but its underlying ask is right for a different reason,
  the outcome is `accepted` with the correction stated explicitly in the
  reply. `rejected` discards a real defect; a silent `accepted` launders a
  false failure scenario into the reviewer-scoring sample.

### The decline ladder

The `accepted` rows buy fixes only while rounds are cheap — every accepted fix
re-triggers all reviewers, so a late-round accept costs a full round apiece,
and each extra fix can introduce a fresh regression. From a configured round
onward, a finding this rubric would otherwise accept must additionally clear
that round band's accept bar.

**The bar is not stated here.** Round bands, the severity floor, the categories
that always survive, the priority-tier cap and the self-inflicted clause all
live in the consumer's `.config/review-triage.yaml`,
and that file is deliberately the only place any of them appear: retuning the
ladder is one config edit with no prose to chase. A threshold
restated here is a second copy that drifts.

The ladder is a **filter over findings this rubric has already accepted**. It
can only turn `accepted` into a decline — never the reverse, never a
`rejected` (the finding was wrong) or a `moot` (the code is gone) — and it does
not move the `wont-fix`/`deferred` boundary: a declined finding that is
**obligatory** is still `deferred` with a tracked follow-up. Nothing is
dropped; what is traded is recall for rounds, an explicit human decision, measured back by
[Calibrating the ladder](#calibrating-the-ladder) below.

Resolve it mechanically, per otherwise-accepted finding:

```bash
bun "<skill-dir>/scripts/triage-ladder.ts" --severity <blocker|high|medium|low|unknown> --tier <tier> --category <token|unknown> --self-inflicted <true|false|unknown> [--pr N] [--obligatory]
```

One JSON verdict per finding: `stance`, a ready-to-post `reply` for a decline
(post it verbatim; for a deferral, insert the follow-up link — from the
[deferral protocol](deferral-protocol.md) — **before** the trailing
`reply.marker` line, never after it. That line must stay the reply's
last non-blank line: `ladderDeclinePatterns` matches the marker only there,
so appending the link after it drops the reply out of
the `--ladder-only` sample from `defect-escape.ts`), `minimalDiff`, and
`anomalies` — every fail-open reason, announced rather than silent. It never
exits nonzero over a config or round problem, because a rule whose whole job is
damping must not be able to stop a drive.

The inputs it cannot compute for itself:

- **severity** — the reviewer's own `**blocker**`/`**high**`/`**medium**`/
  `**low**` token, as `severityOf` (`drive-pr/scripts/summary-findings.ts`)
  reports it. Pass `unknown` explicitly when there is none.
- **tier** — the [Priorities](#priorities) rank the finding sits in. Always
  answerable, since it is this rubric's own first question. It is what a band's
  tier clause reads, and for a reviewer that emits no categories that
  clause is most of what keeps gate and production-correctness findings out of
  a decline — so an omitted tier is not a small omission, which is why the
  script refuses without one.
- **category** — the reviewer's own `🏷️ category:` tag, as `categoryOf` (`drive-pr/scripts/summary-findings.ts`)
  reports it; `unknown` when the tag is absent. Pass it through explicitly —
  `triage-ladder.ts` refuses (`fail(2, …)`) rather than silently defaulting an
  omitted flag to `unknown`, and since a category clause can only ever
  *admit*, an indistinguishable default could wrongly decline a finding whose
  real category should have admitted it.
- **self-inflicted** — `self-inflicted.ts`'s answer for this anchor,
  **required**: `SKILL.md` § 2's enumerate step measures it for every thread
  and feeds it straight into this flag, rather than leaving it as an operator
  option to skip. `null` is not `false`: an unmeasured anchor makes that
  clause abstain, and the verdict says so on stderr — exactly the case where a
  regression from this PR's own earlier round could get declined.

`--round` is read for you, mechanically, never recalled from session memory:

```bash
bun "<skill-dir>/scripts/current-round.ts" [PR]
```

Run both commands with Bun available. Make it available first if its
executable is absent from `PATH`; an unread round counter leaves the damping
rule unarmed. Explicit `bun` invocation also works
on Windows, where the executable shebang alone does not launch the script.

It prints the highest ordinal any review loop in this clone has counted for
the PR: `await-round.ts`'s per-head counter in the git dir (the continuous
`/resolve-review-comments` path), and `drive-pr`'s own durable `rounds` (the
`/drive-pr` path, which never invokes `await-round.ts`). Reading only the
first would leave this rule inert under `/drive-pr`.

It is a **lower bound**, not an exact count: the two counters cover disjoint
heads, so a PR that ran three continuous rounds, converged, and then switched
to `/drive-pr` reports 1–3 for the next three. The error only ever runs low,
which only delays a rule that declines findings, so it is stated rather than
fixed — the alternative is one counter shared across both skills.

That makes the ordinal **PR-scoped, not session-scoped** — deliberately.
`await-round.ts` clears its counter at convergence and `drive-pr` does not, so
a fresh session on a PR a drive already took to round 6 reads 6 and arms the
ladder at once. That is the reading this rule is built from: it prices a
round, and a PR that has had six has had six, whichever loop counted them.

`0` means nothing counted a round here, and the ladder simply does not arm.
Three ways to get it, and only the first two are ordinary — a fresh worktree
or a counter reset at convergence; a **one-shot manual pass**, which runs
neither loop and so counts nothing, leaving the ladder permanently unarmed for
that mode by design; and a counter that exists but cannot be read, or holds
something that is not a canonical positive ordinal, which the script announces
on stderr. Read that line as an anomaly to look at, not as a fresh session.

The value fails open in every one of those cases, deliberately, and so does
every other uncertainty the ladder meets — an unreadable or invalid config, a
round in no band, an input the config nominates as load-bearing arriving
`unknown`. This rule only ever *declines* findings, so arming it from state
that could not be established is the one direction that loses them, while an
unarmed ladder just restores the rows above. Each such case is reported in the
verdict's `anomalies`: the value fails open, the silence does not.

### The late-round minimal-diff rule

From the first band the config marks `minimal_diff` — the verdict reports it,
so it is read rather than remembered — a fix that does survive the ladder is
the **smallest change that resolves the finding**. No opportunistic refactor,
no adjacent cleanup, no "while I am here". Late rounds are where fixes
manufacture the next round's findings, and a widened fix at round 8 buys one
finding and risks several.

The mandatory sibling sweep (`SKILL.md` § 3) is **not** waived by this — it is
the one thing that stops a class from costing a round per instance. It is
scope-priced instead, by the class-priced triviality row above: scope the sweep
first, and if the true class is Involved, the tier rows decide it.

### Calibrating the ladder

The marker every ladder decline carries is standing, and it is what makes the
trade measurable rather than merely asserted. `wont-fix` scores as a true
positive with a materiality signal, distinct from `rejected` — the reviewer
flywheel is not mistaught (see [Guardrails](#guardrails)) — and the round
report lists every ladder `wont-fix` for the human spot-check, as it already
does for all `wont-fix` outcomes.

Monthly, over the declines the ladder itself made:

```bash
bun "<skill-dir>/../drive-pr/scripts/defect-escape.ts" --since <YYYY-MM-DD> --until <YYYY-MM-DD> --ladder-only --json
```

`--ladder-only` narrows the sample to replies carrying the config's own
`reply.marker`, so the population is exactly what the ladder declined and not
every decline the rubric ever made. A decline that comes back as a re-found
`accepted` thread in a later PR is an **escape**: the band that declined it is
too strict, and the fix is an edit to the config — never a special case in this
prose.

This is a **one-way valve**, the same shape `verification-fit.ts` applies to
the change-area catalog: a ladder decline never changes what a round runs, and
the measurement never changes a stance on its own. It produces the sample a
human retunes the weights from, and the consumer records verdicts and the running series in its own review-loop
baseline document.

## Scope heuristic

For an accepted finding whose fix would widen the PR's scope. Both inputs are
mechanical:

- **Size**: derive the PR base branch with
  `bun "<skill-dir>/../../shared/command.ts" -- gh pr view --json baseRefName -q .baseRefName`
  and use per-file counts from
  `bun "<skill-dir>/../../shared/command.ts" -- git diff --numstat "<base>...HEAD"`, comparing with that base's merge base.
  Exclude generated paths using the consumer's authoritative generated-artifact
  registry. Aggregate PR additions/deletions cannot distinguish generated output.
- **Sensitivity**: use the consumer's change-area projection and high-risk path
  rules, including shared schema or contract code that affects external callers.
  Read the registry's scope and known gaps before treating no flag as proof of
  low risk.

| PR state | Call |
|---|---|
| Under ~500 changed lines and this fix introduces no sensitivity flag or contract change | Widen the scope and fix it now — the PR stays reviewable |
| At/over ~500 lines or this fix introduces a sensitivity flag or contract change | Keep focus — `deferred` if obligatory, `wont-fix` if optional |
| Genuinely ambiguous | Review Arbiter |

The question is whether **this finding's fix** would push the diff into
large or sensitive territory. A flag an earlier round's work already armed
does not by itself veto a later fix to an already-touched file that changes
no contract.

Record which rule fired in the reply ("**accepted** — in-scope under the
small-PR rule"), so the thresholds can be tuned later from real replies.

## Standing rejections

A finding that conflicts with a documented project stance is `rejected`,
with a link to the consumer's canonical rule. Read the rule's actual scope first:
a policy governing current-time reads may exclude fixed sentinel dates, and a
closed list of forbidden names does not automatically prohibit unrelated names.
Do not turn an inferred preference into a rule or port one consumer's product
policy into another repository.

Keep recurring classes of against-policy findings in the consumer's reviewer
configuration. When reflection is on, `/jig:reflect` after a long review
records which policy or reviewer change would have prevented the class, for
`/jig:review-reflections` to act on.

## Contradictory findings

Reviewer-vs-reviewer conflicts sit outside the evaluation order above: each
side of one passes stance, scope, and materiality on its own terms, so the
rubric's filters never surface the conflict. Structurally opposite remedies
can each look locally correct, yet consecutive fixes simply reverse the prior
round's decision.

1. **Check for a reversal before triaging.** If a finding's remedy would
   reverse an outcome already accepted on this PR, it is not an ordinary
   finding — do not fix it as one.

   The prior round's outcome lives on the **resolved** thread, and only there:
   the drive state's held keys are cleared the moment a thread resolves, and
   the ordinary enumeration returns unresolved threads only — so neither shows
   an outcome from a round that finished. A later reviewer normally files its
   contradicting finding on a *new* thread, whose comments carry none of that
   history. Read it explicitly, before triaging:

   ```bash
   bun "<skill-dir>/scripts/list-unresolved-threads.ts" [PR] --include-resolved
   ```

   Each line carries `isResolved` plus the thread's comment bodies, so the
   prior `**accepted**` reply and the construct it was about are both
   greppable — **unless `commentsTruncated` is `true`**, which is the same
   100-comment cap the unresolved path already fails closed on. A truncated
   thread's *latest* outcome is exactly the one omitted, so a grep over the
   visible prefix is not evidence of absence: treat the reversal check as
   **inconclusive**, not negative, and send the new finding to the arbiter
   (or a human) with the truncation stated. Concluding "no prior outcome" from
   a partial history is how a contradictory fix gets applied over an accepted
   one.
   Scope the check to the file/construct the new finding touches — not the
   whole PR — and never pass `--include-resolved` on a counting path
   (`await-round.ts` / `converge.ts` measure open work by line count).

   **Take the last trusted outcome on the thread, not any of them.** This
   skill requires a *new* token whenever an outcome changes, so a thread can
   legitimately read `**accepted**` … then `**rejected**` or `**moot**`. Scan
   the comments in order and keep the final qualifying one; an earlier
   `accepted` that a later comment superseded is not a decision to reverse,
   and treating it as one sends the arbiter a decision history that is simply
   wrong. (Same rule `drive-pr` § 3 applies to its own crash-recovery scan —
   the last qualifying reply wins.)

   **A comment carrying an outcome token is only evidence when its
   `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`.** A review
   thread is world-commentable and the stream returns *every* reply, so an
   outside comment opening with `**accepted**` would otherwise divert a live
   finding into this section and on to the arbiter — a spoofable path into
   "do not fix it as an ordinary finding". That is the same server-computed
   gate `drive-pr` § 3 and `summary-findings.ts`'s `TRUSTED_ASSOCIATIONS`
   apply to the same surface; the field is on every comment in the output for
   exactly this reason. An untrusted author's token is not a prior outcome —
   ignore it and triage the finding normally.
2. **Check whether the spec already decides it.** If the PR's linked issue or
   its epic's plan document settles the disputed point, this is not a
   trade-off: the losing side is `rejected`, citing that spec section, and a
   reassertion of it later gets the same reply.
3. **Name the invariant each side defends**, one line each. If both hold and
   are incompatible, the round's job is to **state the trade in the artifact**
   — a documented, tested boundary at the relevant constant/function — and
   answer *both* threads with that same decision, not to re-implement
   whichever side the current round's reviewer argued.
4. The side not taken is `wont-fix` (valid, deliberately declined, no
   follow-up). The round report carries both threads' reasoning so a human can
   overrule cheaply.
5. **Unless step 2 already settled it**, same-construct opposing findings go
   to the Review Arbiter **by default**, not only on ambiguity — and its
   inputs must include the prior accepted reply the new finding would reverse
   (see below); judging the new thread alone is judging half the record. A
   dispute step 2 resolved is not "opposing" in this step's sense: one side is
   already `rejected` against the spec, so there is no live pair left to
   arbitrate.

## Cross-bot duplicates

Reviewers can find the same defect independently. Nearby anchors suggest a
duplicate but do not establish one: confirm the same claim and the same fix
before combining decisions. Paying multiple triage decisions for one finding
adds round cost, so:

- **Fix once, under one thread — and triage the duplicate set as a set.**
  Pick the carrier before replying to any member, and only ever link a copy
  to a carrier *you* are answering in this same round. That is what makes
  the cross-links acyclic: one resolver never picks two carriers for one
  set, and never points at a thread it did not itself decide. If you cannot
  answer the carrier — it is parked, or it is otherwise not yours to decide
  this round — answer this copy on its own merits instead of linking. That
  branch is for a carrier that is *unavailable*, never for one a second live
  resolver is working: evidence of another resolver on this PR means stop
  (below), not proceed, because continuing there produces a second fix or a
  verdict that contradicts the carrier's. The carrying thread carries the
  outcome, the reasoning, and the fix reference.

  That reasoning is acyclic only because **one resolver holds the PR at a
  time**, and that is enforced. Within one working tree
  `/drive-pr` holds a single-instance lock, a per-session lease, and per-hold
  actor provenance — all keyed to the tree, because two managed worktrees on
  one PR is a supported topology. Across working trees, every
  state-mutating `drive-state.ts` command refuses with **exit 13** while
  another working tree holds a live lease on the PR, naming that tree and its
  session. A second worktree keeps every *read*, and keeps every other PR.

  A runtime that identifies **no** session — neither `$DRIVE_PR_SESSION` nor
  `$CLAUDE_PID` — writes a tier-3 record whose holder is the **working tree** rather
  than a session (no pid is invented for it; a working tree is the only thing
  the cross-tree question asks about), so two sessionless resolvers in two
  worktrees refuse each other like anybody else. Within one tree, a
  sessionless resolver never refuses a sibling invocation of its own agent.

  Its one real cost, stated because it is the price of having no pid: that
  record cannot be liveness-tested, so a sessionless resolver that dies
  mid-drive keeps other trees out until its record goes stale — up to
  `DRIVE_PR_LEASE_STALE_MIN` (default 360m), the same bound a lease held on
  another *host* already carries. The `clear-lease` operation of
  `drive-state.ts` with `--all` ends
  it immediately, and every refusal that names a tree-held record says so.
  Exporting `DRIVE_PR_SESSION=$$` is still worth doing where the harness makes
  it stick: a session lease clears the instant its pid does, so it trades that
  window for nothing.

  **A clean finish does not cost that window**. `converge.ts`
  — the loop that spawns each sessionless pass, and the one process that knows
  when it will spawn no further one — hands this tree's tier-3 records back at
  the terminal exits of its loop (converged, a propagated await-round verdict,
  a failed pass, `--max-rounds`), by spawning `/drive-pr`'s
  `release-sessionless-lease.ts`. Read the scope exactly, because it is narrow
  in every direction and the staleness window above remains the fallback for
  everything outside it. It fires only from a `converge.ts` run that
  actually spawned a pass — never from a bare interactive pass, which has no
  defined "done" moment, and never from a run that reached a terminal exit
  having started nothing: a `--dry-run`, a forwarded-flag usage error, an
  ordinary invocation against an already-converged PR, a pass command that
  failed to spawn at all, or `--max-rounds 0`. Those are examples of a
  universal rather than a list to keep complete — *every* terminal exit
  `converge.ts` has is reachable before a pass has run, which is exactly why
  the gate is a flag on the spawn. Which return statement was reached decides
  nothing,
  and neither does the pass's exit code — a failed spawn and a real pass that
  exits `127` are indistinguishable by code, so the gate reads `proc.ts`'s
  `spawnFailed` instead. Whether a pass ran is the whole gate, because a run
  that claimed no record can only be holding somebody else's.
  It touches only `holder: 'worktree'` records
  — a session-held lease is never dropped, since it already self-releases with
  its pid. And it drops the tree-wide record only while that record still names
  the PR being released, so a tree that has moved on to a *different* PR keeps
  its protection. Everything else about it is best-effort: a `/drive-pr` that
  the repository does not have, a failed spawn, a contended state mutex —
  each leaves the record to expire by staleness, and none of
  them changes `converge.ts`'s own exit code.

  Detection, when you need to ask the question directly, is
  `bun "<skill-dir>/../drive-pr/scripts/drive-state.ts" lease <PR> --all` — every live lease on the PR from any
  tree, each with its worktree path, its `pid` field (`0` for a `worktree`
  holder, which has no session to name) and a `self` flag. Use
  that and nothing else. The obvious alternative is wrong in a way worth
  remembering: the `held` operation of `drive-state.ts` stamps every item with the `actor`
  that made it, but a hold deliberately *outlives* its driver — a worktree
  that dies mid-round strands its holds exactly so another driver can finish
  them, which `/drive-pr` § 6 permits on purpose. A foreign `actor` is
  evidence that a hold was made elsewhere, never that anyone is still
  driving, and stopping on it wedges a legitimate successor indefinitely.
  Liveness lives in the lease, which is why the check reads leases. For the
  same reason the admission gate self-clears: a dead or idle holder stops
  being live by that same test, so a crashed worktree never wedges the PR.
  Each row carries a `holder` — `session` for a pid-backed lease, `worktree`
  for the tier-3 record above, whose `pid` is `0` because there is none to
  report rather than because it is unknown.

  The standing answer to a second live resolver on one PR is *stop*, not
  coordinate: concurrent resolvers put two outcome replies on every thread
  they both reach — unrepairable once posted, corrupting the reviewer-scoring
  sample, and dwarfing any cross-link. You will normally meet the refusal
  (exit 13) rather than having to notice the condition. Do not
  re-implement that coordination here either; a second copy of it in prose
  drifts from the one that runs, and a claim scoped to duplicate sets would
  imply a coverage it does not have.

  Which member carries is a **judgment call**, stated as one: the **most
  precise statement** — the copy naming the failure most exactly, or
  covering the most cases — with the **earliest** copy breaking a tie.
  "Earliest" is readable from what you already have: `list-unresolved-threads.ts`
  emits no timestamp, but each thread's `url` ends in `#discussion_r<id>` and
  those ids are monotonic, so the lowest one is the earliest copy — the same
  property `/drive-pr`'s announcement de-duplication turns on. Not
  an objectively orderable key (earliest, lowest id) on its own, because
  those reliably elect the vaguest copy, and the carrier's reasoning is what
  every inherited reply has to defend. Determinism comes from the
  set-at-a-time rule above, not from the ranking.
- **Same claim only.** A duplicate means the same defect with the same fix.
  Two different findings on neighbouring lines are both live; a variant
  adding a genuinely new consequence or case gets that delta answered on its
  own thread, not mooted. Same lines is a *hint* that two copies exist, never
  the test — and neither is history: a defect a later push reintroduces is a
  fresh finding on that head, not a copy of the thread that closed it, for
  the same reason a fix-dependent summary answer expires when the reviewer
  moves past the head it was posted at.
- **Every other copy inherits the carrying thread's verdict**, and the token
  follows what actually happened to the claim — `moot` is not automatic:
  - carrier `accepted` → `**moot** — duplicate of <thread-url>`, fixed
    there: the claim was real and no longer applies.
  - carrier `rejected` → `**rejected**`, carrying that thread's reasoning
    and a link. The claim was false in every copy, and each reviewer that
    filed it should score it as the false positive it was.
  - carrier `wont-fix` / `deferred` → the **same** token, with that thread's
    reasoning and a link (and, for `deferred`, the same issue). The claim is
    valid and unfixed, so `moot` would close an obligatory finding as though
    it had disappeared.

  Either way, do not re-litigate the merits per copy — inherit them.
- **Timing follows the moot-hold rule** on the `accepted` path: when the
  carrying thread's fix is from this same unpushed round, the duplicate's
  premise is only as solid as that fix — hold it with the accepted batch and
  resolve it after the push lands, exactly as `SKILL.md` § 3 already requires
  for fix-dependent moots. An inherited `rejected` / `wont-fix` / `deferred`
  depends on no fix and resolves immediately, like any other.
- **On the `accepted` path, `moot` is the deliberate choice**: `rejected`
  would teach the duplicating reviewer its finding was false (it was not),
  and `accepted` would double-count one fix as two hits. The harvester scores
  each bot's thread separately — which is the same reason an inherited
  `rejected` must be a real `rejected` rather than a blanket `moot`.

## The Review Arbiter

For threads the rubric does not decide, spawn the **Review Arbiter** agent
(`jig:review-arbiter`) — one invocation can take a batch of
contested threads. Give it, per thread: the thread body, `path`/`line`, the
finding's diff hunk — or an explicit note that it anchors to pre-existing code
the PR did not touch (the arbiter has no `git`/`gh` access, so this is how it
tells changed from pre-existing) — the PR number, and the PR's size +
sensitivity flags (computed once per round). When the thread contests or would
reverse an outcome already accepted on this PR, also give it that prior
accepted reply verbatim (see [Contradictory findings](#contradictory-findings)).

For a thread the arbiter might otherwise rule `fix-now`, run
[`triage-ladder.ts`](#the-decline-ladder) **yourself** first, **twice** — once
with `--obligatory`, once without — and give it both printed JSON verdicts,
not the raw round/severity/category/self-inflicted inputs — the arbiter has no
`Bash` to run the CLI, and hand-interpreting `.config/review-triage.yaml`'s
bands from a `Read` can diverge from the CLI's fail-open polarity, clause
evaluation and `minimalDiff` arming. `stance`, `band`
and `minimalDiff` never depend on `--obligatory` — it only picks which
template renders into `reply` (`wont-fix` vs `deferred`) — so the two verdicts
agree on everything else; running both, always, is what lets the arbiter rule
obligation itself (the `wont-fix` / `deferred` boundary under
[Evaluation order](#evaluation-order)) instead of being handed a `reply` baked to
whichever guess you made before it ruled. Do not special-case the "obligation
already looks obvious" thread and send only one: the arbiter's ruling is what
counts, and a single verdict silently forces its reply-draft to agree with
your guess even when it decides the other way.

It returns one verdict per thread — `fix-now` | `rejected` | `wont-fix` |
`defer` | `escalate` — with a one-sentence rationale and a token-prefixed
`reply-draft` (`rejected` is for findings its code-reading disproves). The
caller posts the **reply-draft**, never the bare rationale: the draft opens
with the mapped outcome token (`fix-now` → `accepted`, `defer` → `deferred`;
`rejected` and `wont-fix` map verbatim). Drafts for `fix-now` and `defer` are
**provisional** — the arbiter writes them before the fix exists or the
follow-up is filed, so the caller finalizes them after acting (the commit
sha, the issue link) and only then posts; `rejected` and `wont-fix` drafts
change nothing downstream and may post as-is. For `escalate` there is no
draft — the outcome awaits the human, and any interim status reply goes out
with `--no-outcome` — except under a drive at the `wide` autonomy level,
where an `escalate` with the class `escalated` and `human-decision: no` comes
with a `provisional-draft`: the reply outcome the arbiter would choose were
the call the agent's, `rejected`, `wont-fix` or `deferred`, never a fix. The
caller posts it with drive-pr's `provisional-reply.ts`, which marks it a
**provisional decision**: a person reverses it by commenting on the thread,
and until then reconciliation and triage skip the thread (a different sense
from the provisional *drafts* above, which are finalized before they post).

Arbiter ground rules (enforced by its agent definition):

- It **reads the anchored code** before ruling. A thread is never judged from
  the reviewer's text alone — findings have been accepted that the emission
  site refutes.
- `escalate` is rate-limited: escalations from a round are **batched into one
  question** to the human at round end, never one interruption per thread.
- It decides disposition only; it never edits code.
- It never rules `fix-now` for a finding that would change a value the PR
  records as a human decision, or add or change a normative rule inside such a
  span — that always resolves to `escalate`, since only a human may approve the
  new value or rule and the arbiter's own ruling is not that approval (see
  [Guardrails](#guardrails), below).

## Guardrails

- `wont-fix` is never the escape hatch for a hard-but-obligatory fix — that is
  a deferral, with a tracked issue.
- **An accepted fix never silently changes a recorded human decision.** Where
  the PR frames content as a human decision ("Decided by X on date", an
  operations follow-ups block, a decisions table), a fix may correct the supporting
  facts or rationale but not the decided value itself — a finding that needs
  the value changed requires human approval of that value before
  implementation. Route it to the Review Arbiter or park it for the human, but
  the arbiter may only assess it and must rule `escalate`, never `fix-now` —
  its ruling is not the human approval this guardrail requires.
- **Nor does it add or change a rule inside a [human-decided span](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).** The
  guardrail above covers the decided *value*; a fix can also leave the value
  alone and add or change a **normative rule** (a "must", a limit, an
  exception, a condition) inside a section the PR records as a human decision.
  Such an addition is the decision rewritten by another route, and an
  unattended loop that accepts one finding at a time can extend a decision
  round after round until it contradicts what the human recorded. A finding
  whose fix adds or changes a normative rule inside a human-decided span is
  never an ordinary accept: park it for the human or rule it `escalate`, or
  accept only wording that leaves the rule exactly as recorded (a clarified
  sentence, a corrected cross-reference, a fixed typo).
- **A new gate's exemption must be keyed on a signal the gate's own code
  emits** — never on a pre-existing artifact whose shape the old code, or a
  trusted human, could also produce. A grandfathering clause keyed on legacy
  artifact shape is a bypass, not a compatibility measure — and must be assessed against the consumer's compatibility policy. Moving
  an exemption without removing its ambiguous signal preserves the bypass.
- The round report states the `wont-fix` count and one-line reasons, so a
  human can spot-check the discretion cheaply.
- The reply-harvesting pipeline scores `wont-fix` as a **true positive with a
  materiality signal** — distinct from `rejected` (false positive); the
  consumer's harvester must preserve that distinction. Mislabeling
  a wrong finding as `wont-fix` teaches the reviewer its false positives are
  valid; mislabeling a valid-but-minor finding as `rejected` slanders it.
