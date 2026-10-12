# Round-finish mechanics — what `finish-round.ts` sequences, and why each step is there

`SKILL.md` § 6 is one command. This is the record of what that command does,
what every check inside it proves, and the failure each one closes.
You do not need it to run a clean round; you need it when a refusal names
something you have to act on, when you are recovering by hand with the
individual scripts, or when you are changing any of them.

**Section numbers below refer to `SKILL.md`'s numbered round steps** (§ 1 the
gate, § 3 triage-and-act, § 6 the round finish). Every command shown is still
individually invocable — `finish-round.ts` sequences them, it does not
replace them, and hand-running one is the documented recovery path.

---

## 0. The pre-push refusals

`finish-round.ts` refuses first, before the one irreversible act — a dirty
worktree, an unconcluded git operation, or a round about to push
fixes for which no `triage-thread.ts` reply was ever posted.

**The dirty-tree / unconcluded-op refusal.** A dirty worktree, or an
unconcluded git operation (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
`rebase-merge`, `rebase-apply`) whose porcelain status still reads clean,
makes every later check's premise false while every one of them still
passes: everything below treats a successful push as evidence that the
validated tree is on the PR.

**The untriaged-thread refusal.** SKILL.md's documented round loop
is gate → enumerate → triage *each* thread via `triage-thread.ts` → validate →
commit → `finish-round.ts`. A driver commonly fixes every finding's
underlying code instead and goes straight from "fixes applied" to
`finish-round.ts`, never once calling `triage-thread.ts`. Without this guard
nothing refuses that: no thread is held either way, so the round pushes,
stamps, and reports "0 held item(s) drained" — a report
**indistinguishable**
from the legitimate case (a round that genuinely rejected/wont-fixed
everything, which also drains 0 held items). The reviewer bot's threads stay
open with zero driver reply, silently, until a *later* round's gate reports a
stale unresolved-thread count and someone checks each thread's reply history
by hand.

The guard (`checkUntriagedThreads` in `finish-round.ts`) refuses only when
**all** of:

- **(a) that thread carries no current held triage decision of its own.** A
  hold is keyed per-thread (`HeldItem.key` is the threadId for `kind:
  'thread'`), so a hold recorded against a *different* thread — this round's or
  an earlier undrained one — is not evidence that *this* thread was triaged.
  Treating the mere presence of any held item anywhere in the batch as
  sufficient would let one accepted-and-held thread on file A silently excuse
  a never-triaged thread on file B, so the guard correlates the held set
  against each candidate thread individually. A hold on *this* thread's own key still is not
  enough on its own: the hold's recorded `commentUrl` must also match the
  thread's *latest* comment — **or** be followed only by a trusted reviewer
  bot's own automated confirmation of it (`isThreadHoldCurrent`;
  see the paragraph on this below). A reviewer or human can post a new
  comment on a thread after it was held but before this round's push
  completes, and a key-only match would still exempt it — silently closing
  the fresh comment with no outcome reply ever posted.
- **(b) at least one unresolved review thread is anchored to a file this
  round's own local non-merge commits touch.** "This round's own non-merge
  commits" means since the last verified SHA (`drive-state.ts verified`) when
  one validates, else the cumulative merge-base against `origin/<base>` (the
  configured base branch) — `roundBase()` in `scripts/lib/round-delta.ts`, the
  *same* fail-closed base resolution `round-plan.ts` shares (though
  `round-plan.ts`'s own validation file list uses its separately computed
  cumulative/delta base — `roundBase()`'s `rb.base` return goes unused there;
  only `rb.sha`, feeding its test-box decay decision, does) — diffed
  with `changedFilesSinceExcludingMerges()`, NOT `round-plan.ts`'s own
  `changedFilesSince()`: a base-sync merge (SKILL.md § 5 runs `base-sync.ts`
  every round) can bring in a large slice of the base branch's own unrelated
  churn, and only this round's own non-merge commits should count as
  "touched" (see `round-delta.ts`'s own header for the measured case). A thread with `path === null` — a PR-level comment
  anchored to no file at all — can never satisfy this condition, so this
  guard never reasons about one. The thread enumeration is
  `list-unresolved-threads.ts`, and by default with **no** `--bots-only`
  filter — a human thread left untriaged is the identical mistake, so bot
  and human threads both count here by default, unlike the `--bots-only`
  convergence stop condition elsewhere in this skill. `finish-round.ts`
  itself accepts `--bots-only` and forwards it to this same enumeration
 — pass it only when the *round itself*
  is being driven `--bots-only`, since that is the one case where refusing
  on an untouched human thread would violate bots-only mode's own scope
  (SKILL.md § 6).
- **(c) that thread's triage state is incomplete or stale** — not only
  "never triaged, this round or any prior one", which is just the narrowest of
  the three cases the paragraphs below cover: a current reply with no hold
  recorded, and an existing hold gone stale, are incomplete or stale triage
  too, not "no record at all". The narrowest case is checked via `currentReplyOutcome`, which
  requires the qualifying reply to be the thread's own literal *latest*
  comment. `currentReplyOutcome` shares its primitives with `triage-thread.ts`
  (`TRUSTED_ASSOCIATIONS` +
  `qualifyingOutcome`) but is deliberately *stricter* than it: `triage-
  thread.ts`'s own "last qualifying reply" scan walks backward and accepts
  the first trusted qualifying reply it finds anywhere in the thread's
  history, which is right for *its* purpose (deciding what outcome a
  *reconciling* call should report) but wrong for *this* guard's purpose
  (deciding whether a thread is safe to push past) — a reply from an
  earlier round would otherwise stay "found" even after a *new*, unaddressed
  comment lands on the same thread afterward. So the two predicates can legitimately disagree: a newer
  non-outcome reply makes *this* guard treat the thread as untriaged while
  `triage-thread.ts`'s own reconciliation still finds the older outcome —
  that divergence is intentional, not a residual bug.

  **That divergence has a non-obvious consequence for the remedy**: running plain `triage-thread.ts` on a thread this
  guard refused for a *stale* reply/hold does NOT fix anything — its
  reconciliation rule treats the older qualifying reply as "the answer"
  regardless of the newer comment, so it silently re-confirms the stale
  state and this guard refuses again next round, a loop that never
  converges. The refusal's own message distinguishes the two cases and names
  the correct remedy for each: a genuinely never-triaged thread names plain
  `triage-thread.ts`; a stale one names the documented supersession path
  instead — post a fresh reply via `reply-to-thread.ts` directly (which
  becomes the new latest comment), then `triage-thread.ts` to complete the
  disposition (it will find that fresh reply, not the stale one, since it
  scans from the latest comment backward).

  **A current, valid reply is also not always enough on its own**: `triage-thread.ts` is *self-reconciling*, not
  atomic (its own header) — a kill between posting the reply and recording
  its durable disposition leaves a valid, *current*, trusted reply on GitHub
  with the *other* half of the dispatch never having happened. `isThreadTriaged`
  (the combined predicate `checkUntriagedThreads` actually filters on) treats
  this differently by outcome, and both halves of the gap matter —
  `accepted`, and `moot` *without* the leave-open marker, always
  create a *hold* when the dispatch completes, so for those two the exemption
  requires a *current* hold to exist (`isThreadHoldCurrent`). `rejected`,
  `wont-fix` and `deferred` never create a hold — `triage-thread.ts`'s normal
  completion for them calls `resolve-thread.ts` and *resolves* the thread
  instead. Since this guard only ever sees threads `list-unresolved-
  threads.ts` reports as unresolved, an unmarked merit reply sitting here
  cannot be a legitimately-finished dispatch (a finished one would have
  resolved the thread and it would not be in this list at all) — it is
  `triage-thread.ts` crashing between the reply and the resolve, the same
  shape of gap as the accepted/moot one, just on the other side of the
  fork. The *one* way a merit reply (or an unmarked moot) legitimately stays
  unresolved forever is the LEAVE_OPEN marker — `triage-thread.ts
  --leave-open` works identically across every non-hold outcome (its own
  header), not only `moot`, so this check does too. Either crash's remedy is
  the same *shape*, naming the correct missing half: re-run `triage-thread.ts`
  on the *same* thread with *any* valid outcome body on stdin (not an empty
  one: `triage-thread.ts` refuses *empty* stdin outright, before it ever
  fetches or reconciles the thread). Its self-reconciliation
  will find the already-posted reply and win over whatever this
  invocation's own body said, completing whichever half — a hold, or a
  resolve — never happened. Posting via `reply-to-thread.ts` again here
  would double-post.

  **A current hold's own url matching is also not enough by itself**: GitHub preserves a comment's permalink when it is
  *edited*, so a hold made for `accepted` whose comment is later edited to a
  different outcome — or to remove the outcome token entirely — still
  matches on url. `isThreadHoldCurrent` therefore answers a narrower
  question than its name suggests on its own; `isThreadTriaged` re-derives
  the outcome from the *held* comment itself — the one the hold's own
  `commentUrl` names, not necessarily the thread's literal latest — and
  requires it to still equal what the hold was recorded for. That is
  `heldReplyOutcome`, not `currentReplyOutcome`, because
  `isThreadHoldCurrent` tolerates a trailing bot confirmation (above): once
  that tolerance is what makes the hold current, the literal
  latest comment can *be* that confirmation, which carries no outcome token by
  construction — comparing `currentReplyOutcome` against the held outcome
  would then always read `null` and refuse the very round the tolerance
  exists to let through. Any mismatch on `heldReplyOutcome` — url moved on
  (already covered above), or the outcome itself changed — means the held
  record no longer describes reality, and the thread is untriaged again
  regardless of what the *new* outcome would, on its own, need. This is the
  pre-push counterpart to the identical check `resolve-held-thread.ts`'s own
  drain-time recheck already makes — its own tolerance for a
  trailing confirmation is the "new paragraph" a few sections below (§ 4,
  "Draining a `kind: thread`") documents; without either, an edited reply
  would sail past this guard and only get caught by the drain check *after*
  the irreversible push already landed.
- **(d) that thread is NOT currently parked** (`drive-state.ts park` /
  `parked-keys`). A parked thread is a recorded human decision — often
  precisely *because* `triage-thread.ts` itself refuses to reply to it (e.g. a
  `commentsTruncated` thread, which `triage-thread.ts` tells the operator to
  park instead) — so counting it as evidence of skipped triage would wedge a
  drive permanently: this guard's own printed remedy ("triage it via
  `triage-thread.ts`") is refused by `triage-thread.ts` for exactly the case
  it exists to catch.

That conjunction is what separates the mistake from a legitimate all-merit
round. A round that genuinely rejected/wont-fixed/deferred everything has
already posted qualifying replies, and an ordinary merit reply also
**resolves** the thread — dropping it out of (b)'s unresolved population — so
the one place (b) can still be true for a legitimate round is
`triage-thread.ts --leave-open` (SKILL.md's human-thread exception), which
posts the qualifying reply but deliberately leaves the thread open, or a
thread a human explicitly parked. That is exactly why (c) and (d) are each
checked independently of (b) rather than folded into it: the reply exists, so
(c) is false for the left-open thread; the park record exists, so (d) is
false for the parked one; and the guard does not fire for either.

**Fail-closed on its own inputs.** Any infra read this guard cannot complete
— the round base cannot be resolved, the `held` batch is unreadable or
carries an entry `parseHeld` cannot describe, the `parked-keys` set is
unreadable, `list-unresolved-threads.ts` fails or emits a line that cannot be
parsed as a thread — refuses (`TRIAGE_CHECK_FAILED`, exit `1`) rather than
silently proceeding, the same posture `BATCH_UNREADABLE` already takes for
the drain step below. A `commentsTruncated` thread with no qualifying reply
among the *visible* comments is treated as offending — "cannot confirm a reply
exists" fails closed to "treat as untriaged", never silently excluded — a gate
that sees only part of its input must not read the unseen part as clean.

**What this does NOT do.** It cannot retroactively fix an already-pushed
round, and recovering one after the fact is costly (a `triage-thread.ts` run
against a head that has already moved on refuses "already resolved — nothing
to do" for a thread a review bot auto-resolved with no driver-authored
outcome). It only stops *this* round's push when it can
*prove*, from data it can read, that this round's own file changes left a
live, untriaged, unparked thread behind — a round with no held batch and no
unresolved threads on its own touched files at all pushes exactly as it did
before this
guard existed.

## 1. The push

Once both pre-push refusals above have cleared, `finish-round.ts` pushes
through the guard, never with a bare `git push`:

```bash
<skill-dir>/scripts/guarded-push.ts [PR]
```

`drive.ts` checked liveness before handing you the round, but that was before
you triaged, fixed and ran the gates — minutes ago. A PR that merged anywhere in
that window leaves this push orphaning the whole round silently.
`guarded-push.ts` re-checks at the instant of the push and refuses on a merged
or closed PR (exit `5`). It also pushes an **explicit refspec** at the PR's own
head branch rather than letting the worktree's upstream, `push.default` or
configured refspecs decide — a bare `git push` can update a different existing
branch entirely, which no after-the-fact check can undo — and then confirms the
PR actually advanced to the SHA it pushed.

## 2. The stamp

Stamp each held item's pushed SHA **now**, once the validated tree is a commit —
recording it before the commit names the pre-fix head. This call stamps the SHA
onto the held items *this working tree* holds, as their push provenance (see
the held-batch note below) — except a
held **finding that already carries a stamp** with an outstanding dispatch
claim, whose existing stamp is preserved rather than advanced, to prevent an
interrupted dispatch from being re-answered under a push that never carried
its fix. An *unstamped* finding's claim file is never grounds to freeze it,
even if one is present: a claim needs `--pushed-sha` to equal the item's own
stamp before it can dispatch anything, so a claim file over an unstamped
record can only be one still in flight, not a completed dispatch — freezing
it too would let a concurrent driver's transient, about-to-fail claim
attempt block *this* actor's own first-ever stamp from ever landing. It must
therefore run
**after** the holds it is vouching for, which is the order this section
already prescribes — step 3 holds, step 6 pushes:

```bash
<skill-dir>/scripts/drive-state.ts stamp-held [PR] --sha "$(git rev-parse HEAD)"
```

## 3. The head-sync wait

Then — **before** trusting anything the API says about this round — wait for the
PR head it reports to equal local HEAD:

```bash
<skill-dir>/scripts/drive-status.ts [PR] --json --no-count
```

Seconds after a push, `gh pr view --json headRefOid` still returns the
**previous** SHA, where everything was settled and resolved. `drive-status.ts`
blocks on that mismatch rather than judging the stale head.

**`--no-count` here is load-bearing, not cosmetic.** This call's job
is a head-sync wait, not a round gate — the held threads are still open on
GitHub at this point (nothing below has resolved them yet), so without the
flag every call here returns `ROUND_READY` and bumps the durable round count
for the head that was *just* pushed. That happens **inside** the very step
that is about to resolve the held batch — before `resolve-held-thread.ts`'s
own round check ever runs — so the round `hold` recorded at reply time (this
round) would already be stale by the time the resolve call reads it back,
failing the round verification on every single pass, not only a
crash-recovered one. The head still gets counted exactly once: step 1's gate
does it at the top of the *next* round.

## 4. The held batch

Only once the push has landed, work the held batch — **read back from state, not
from memory**, because after a compaction your recollection of it is the one
witness that may be incomplete:

```bash
<skill-dir>/scripts/drive-state.ts held [PR]
```

Process it **one item at a time from a fresh read, releasing each key the
instant its own external operation succeeds** — never accumulate every
resolve/answer and release `--all` in one call at the end. The two kinds use
different mechanisms, because concurrent drivers in sibling worktrees can be reading
this same `held` snapshot right now and the two dispatch calls have different
idempotency:

### Draining a `kind: thread`

**`kind: thread`** — resolved with `resolve-held-thread.ts --key K --pushed-sha
"$(git rev-parse HEAD)"`, never with `resolve-thread.ts` directly: the raw
mutation is unconditional and has no notion of which push justifies it. The wrapper checks the following before it calls that mutation at
all: `--pushed-sha` is the PR's live head *and* this worktree's clean HEAD
(the same ordering `answer-summary-finding.ts` enforces below), **and**,
atomically together (`drive-state.ts claim-held --kind thread`), the round `hold` recorded at reply time still equals the
current round **and** `--pushed-sha` equals **this hold's own recorded
`verifiedSha`** (`drive-state.ts stamp-held`, § 2 above — the marker a real
`guarded-push.ts` leaves behind). Round equality alone is not enough: it only
advances when a *counting* `drive-status.ts` gate runs, so a push that lands
without ever going through one — an intervening push, a bypassed step 6 —
leaves the round unchanged and would read as a match even though it was never
the push this hold was waiting on. The stamp closes that, because nothing but
`stamp-held` writes it. Folding both checks and the removal from
`held` into one lock hold is also what makes two concurrent resolves on the
same key mutually exclusive: whichever claims first empties the slot, and the
second sees "no held item" rather than resolving against state the first has
already changed — this doubles as the thread's *own* claim, so there is no
separate `claim-held`/`release-held` call for you to make; skip straight to
dispatching via the wrapper. After the claim, the wrapper re-reads the
thread's live comments and refuses (restoring the hold) when anything landed
after the held reply — except a thread already resolved on GitHub, which
drains without a mutation, and CodeRabbit's own confirmation follow-up
(`coderabbit-skip-review-comment-follow-up` marker, no outcome token), which
is compatible with the hold. Calling `release-held --key` on a thread
afterward finds nothing there and refuses loudly, by the same "no silent
no-op on an already-released key" design `release-held` uses everywhere else.
A refusal — round mismatch, `verifiedSha` mismatch, or racing another claim —
means go back to step 3 and reconcile
(re-hold if the reply still stands, resolve under whatever outcome actually
applies if it does not), then retry. Once the mutation is actually called, it
is idempotent, so a retry after a crash is harmless — and a failure calling it
(not a refusal to claim) restores the item to `held` via `drive-state.ts
restore-held`, carrying every field back *exactly* as `claim-held` printed it
— never re-derived and never "now". The round, because a concurrent driver's
`bump-round` can move `.rounds` on while the network call is in flight and
stamping "now" would launder the very check the round comparison exists to enforce; the
`actor`, so the restored hold still belongs to the driver that made its
promise; and the `verifiedSha`, because `stamp-held` has already run for
this push and will not run again, so an entry restored without it could never
be claimed at all. Nothing is lost either way. And if the
driving *process itself* is killed between a successful claim and the
mutation returning — not a mutation failure this script can catch, an
interruption that ends the script entirely — nothing runs to restore it:
`held` is left without the item, but the GitHub reply from step 3 still
stands, unresolved. The ordinary recovery already covers this: a successor's
next round-1 enumeration finds that thread unresolved with its
`**accepted**`/`**moot**` reply already on it, which step 3's reconciliation
re-holds exactly as it would any other stale entry — no separate mechanism
needed.

## Concurrency: who may drive, and who may finish a hold

**The provenance model, and what it does about a second driver.**
This state file is shared by every driver of the PR — `drive-state.ts` keeps
it in the per-clone state directory precisely so two linked worktrees see one
round budget and one held batch. A single PR-global `verifiedSha` would
therefore be moved by whichever driver pushed last, and would then vouch for
every held item on the PR: driver A holds a thread and stalls before pushing
its own fix; driver B does unrelated work and calls `stamp-held` without ever
bumping the round; A's worktree later syncs to B's head and retries, and every
check passes against a push that never contained A's promised fix.

So provenance is recorded **per hold**, and reads as these facts on the item
itself:

- **`actor`** — which working tree made the promise, stamped by `hold`. It is
  derived from `git rev-parse --show-toplevel` and is not settable by `hold` or
  `stamp-held` (`restore-held` only carries back the value printed by
  `claim-held`): `drive.ts` holds a single-instance lock keyed by the same
  tree, so "one tree" and "one driver" are the same thing, and a managed
  worktree is its own tree. Two *sessions* in one tree are what the lease below
  handles — the actor alone cannot separate them.
- **`verifiedSha`** — the push that carries *this hold's* fix. `stamp-held`
  writes it onto the holds **the calling tree owns**, and leaves every other
  driver's alone. So B's push can never answer A's promise, and A's can never
  answer B's.
- **Absent until that push happens.** `hold` builds a fresh record every time,
  so re-holding a key *clears* any previous stamp. A reply posted now promises
  a fix that is not pushed yet, by definition — the only push that may answer
  it is a later one.

What this deliberately does **not** do is require the same actor to *finish* a
hold. The check is on the item's stamp, not on who is claiming, so once a fix
is genuinely on the PR any driver may resolve the thread — a driver that dies
mid-round strands nothing, and § 3's ordinary reconciliation still recovers it.

**Two drivers in one tree: the session lease.** The actor above is
sound only because `drive.ts`'s lock keeps one *driver* per tree — and that
lock covers `drive.ts`, nothing else. An interactive pass (an agent walking
these steps by hand) takes no lock, so two agent sessions in one tree derive the
**same** actor: `hold` upserts by key, so the second session's hold silently
replaces the first's; `stamp-held` stamps both; the claim path cannot tell
them apart. Measured: all seventeen threads one session had just
replied to carried **two** `**accepted**` replies, which corrupts the
reviewer-scoring sample and cannot be repaired once posted.

So every **state-mutating** `drive-state.ts` command except the explicit
`clear-lease` recovery command takes a lease over *(this working tree, this
PR)* and **exits 11** when another live session holds it, naming that session's
pid and how to check it. `clear-lease` is the documented way *out* of a lease
whose holder is gone, so gating it behind the lease it exists to remove would
make the refusal unrecoverable; `lease` and `handoff` are outside for the
milder reason that neither changes leased state. You do not invoke any of this
— it is in the tooling precisely so it is not a step anyone can forget. What
you do need to know:

- A session is a **pid**: `$DRIVE_PR_SESSION` when set (`drive.ts` exports its
  own, so a whole unattended drive — driver plus every round's pass — is one
  session), else the harness's agent process, else no lease at all. Export
  `DRIVE_PR_SESSION=<agent pid>` to opt a harness this ladder does not know into
  the protection. Without either, the *cross-tree* half below still applies —
  what "no lease at all" means there is a record held by the tree rather than by
  a session, which is the only half a pid-less runtime can be given.
- **§ 1's gate raises it too**, as exit `11` with `state: "SESSION_LEASE_HELD"`
  — its round-counting `bump-round` is a mutating call, and being the opening
  command of every pass it is where a second session actually meets the lease.
  Same code, same meaning, same diagnostic on stderr; it is deliberately not
  flattened into the gate's `INDETERMINATE`.
- It **self-clears**: a session whose pid is gone loses the lease immediately,
  and one that stops mutating state loses it after the staleness window
  (`$DRIVE_PR_LEASE_STALE_MIN`, default 360m). A crashed driver never wedges a
  PR.
- If you are refused and you know the named session is gone or must be taken
  over: `drive-state.ts clear-lease [PR]`. It reports the record it dropped.
  `drive-state.ts lease [PR]` reads it without changing anything.

**Two sessions in one tree, different PRs: the tree lease.** The
lease above is scoped to *(working tree, PR)*, which is exactly right for two
sessions driving the *same* PR — but leaves the *same* tree unguarded when two
interactive sessions drive two *different* PRs: each resolves its own
per-(tree, PR) lease file, neither sees the other's, and both are admitted
into the *same* checkout, which they can then edit, commit, and push over one
another. This is not a milder variant of the same-PR hazard — it is the
identical damage (measured: two `drive.ts` processes in
one checkout, different PRs, cross-shipped each other's uncommitted edits).
`drive.ts`'s worktree-wide single-instance lock already closes it for the
*unattended* path; an interactive pass takes no lock of any kind, so without
a second lease this gap stays open for exactly the sessions this whole
mechanism exists to protect.

So a *second* lease exists alongside the per-PR one, keyed by the working tree
*alone* — every state-mutating command from an identified session claims both.
A sessionless command claims both too, as `holder: 'worktree'` *presence* records
rather than a session's (on the per-PR file, so two sessionless resolvers on
the *same* PR from different trees exclude each other; and on the tree-wide
file, so two of them on *different* PRs from *one* tree do as well). Ownership of a tree-held record turns on its `pr`
rather than on a pid there is none of: same pr is a renewal, any other pr — or a
session-held record, whichever pr it names — is foreign. Either check
**exits 11** on a
conflicting holder — with the identical `clear-lease [PR]` remedy (which
drops both this tree's per-PR lease *and* its tree lease in one call, since
a refusal whose suggested fix leaves the tree still locked is not a remedy).
A single session driving several PRs from one tree renews its *own* tree lease
on every one of them without ever refusing itself — only a *different*
session in the same tree collides. A tree-held record cannot do that last part:
with no pid to tell two sessionless resolvers apart, one that finishes PR X and
moves straight to PR Y is refused like a rival would be, and `clear-lease [PR]`
(or completion, above) is the way on.

**Two drivers in two trees: PR-wide admission.** The lease above is
scoped to *(working tree, PR)*, so two linked worktrees are two leases — the
topology is supported, and is the whole reason the actor is the tree. That is
no reason to let both trees *triage*: two worktrees enumerating the same
unresolved threads and each replying with its own outcome is the identical
damage measured within one tree, reached across trees instead. The clone-wide
state file gives them one round budget and one held batch; PR-wide admission
is the gate.

So a claim answers two questions, and a refusal tells you which it is:

| Exit | Means | What to do |
|---|---|---|
| `11` | Another live **session in your tree** holds it | Almost always stop. `clear-lease [PR]` if you know that session is gone |
| `13` | Another live **working tree** is driving this PR | Stop. It names the tree's path, and its session pid when it has one |

- It is **derived, not stored** — read off the lease files that already exist,
  by the same `leaseAlive` test — so it self-clears exactly as the per-session
  half does. A dead or idle worktree never wedges the PR for the others.
- **A second worktree keeps every read** (`get`, `held`, `held-keys`,
  `parked-keys`, `verified`, `rounds`, `lease`) **and every other PR.** What it
  may not do is mutate *this* PR's drive state, which is the same thing as
  posting outcome replies to it.
- **`drive-state.ts lease [PR] --all`** is the detection surface: every live
  lease on the PR from any tree, each with its worktree path, its `holder`
  (`session` or `worktree` — see below), its `pid` field (`0` for a `worktree`
  holder, which has no session to name) and a `self` flag; `[]` when nobody
  holds it. It is the *only* sound check. A hold's
  durable `actor` looks like one and is not — a hold deliberately outlives its
  driver (see the provenance block above), so a foreign `actor` proves a hold
  was made elsewhere, never that anyone is still driving.
- **`drive-state.ts clear-lease [PR] --all`** is the takeover path, and the only
  one that reaches a tree you are not standing in — one that was deleted, or
  lives on another machine. It drops every tree's lease on the PR, live ones
  included, and prints each record it overrode.
- **§ 1's gate raises it too**, as exit `13` with
  `state: "DRIVE_HELD_BY_OTHER_WORKTREE"` — kept distinct from `11` all the way
  out, because a driver told `SESSION_LEASE_HELD` goes looking in its own tree
  for a session that is not there.
- **A runtime that identifies no session is covered too**. The refusal is
  read off lease files, so it needs *one* side to have left one; a ladder
  tier 3 that left none would admit two sessionless resolvers in two trees,
  and both would reply. So tier 3 writes a record whose
  **holder is the working tree** instead of a session. No pid is invented for
  it: the cross-tree question is one `actor.ts` already answers without one, and
  inventing a per-invocation identity is the thing tier 3 exists to refuse (it
  would make two concurrent calls from *one* agent refuse each other). So the
  intra-tree behaviour is the same in both directions — a sessionless caller
  still never refuses its own sibling call, and an identified session upgrades
  its own tree's record rather than being refused over it.
- **What it costs, since it has no pid to test.** A tree-held record cannot be
  liveness-tested, so a sessionless resolver that *dies* mid-drive keeps other
  trees out for up to `$DRIVE_PR_LEASE_STALE_MIN` (default 360m) — the same
  bound a lease whose pid lives on another *host* already carries, since that
  one cannot be tested either. `clear-lease [PR] --all` ends it immediately, and
  a refusal naming such a record says so instead of printing a pid that does not
  exist. Exporting `DRIVE_PR_SESSION=<agent pid>` where the harness makes it
  stick is still strictly better: a session lease clears the instant its pid
  does. In `lease [PR] --all`, `holder` tells the two apart.
- **A resolver that finishes does not pay that window**. If staleness were
  the only way a tree-held record cleared, the asymmetry would be worse than it
  has to be: an identified session gets its release for free the moment its
  pid dies, while a sessionless one that completed cleanly would keep every
  other tree out for six hours. `scripts/release-sessionless-lease.ts` is the
  release, and `resolve-review-comments`'s `converge.ts` — the loop that spawns
  each sessionless pass, and the only process that knows when it will spawn no
  further one — *spawns* it at every terminal exit of that loop (the same
  cross-skill shape, and the same reasoning, as `assert-post-allowed.ts`; see
  [post-fence.md](post-fence.md)). Read the scope narrowly, because staleness is
  still the fallback everywhere outside it:
  - **Only a `holder: 'worktree'` record.** A session lease is never dropped —
    it self-releases with its pid, and touching it would put an automated
    cleanup path inside the pid-recycling reasoning session ownership carries.
  - **The tree record only while it still names the PR being released.** A tree
    that has moved on to another PR keeps its protection; that is why
    `clear-lease`, which is unconditional by design (a human override), is not
    what runs here.
  - **Only from a `converge.ts` run that actually spawned a pass**, at that
    loop's terminal exits. Never a bare interactive pass (no defined "done"
    moment to hook); and never a run that reached a terminal exit having
    started nothing — a `--dry-run`, a forwarded-flag usage error that
    `await-round.ts` refuses on iteration 0, an ordinary invocation against an
    already-converged PR, a pass command that failed to *spawn* (`run()` never
    rejects; it reports 127, which a real child may also exit with), or
    `--max-rounds 0`, whose loop body never runs at all. Those are examples, not
    a list to keep complete: *every* one of converge.ts's terminal returns is
    reachable with no pass having run, so the gate is "did a pass run" — not
    "which return was reached", and not the exit code either: a run that claimed
    nothing can only be holding a *sibling* resolver's record, and dropping that
    admits another worktree — the hazard, reintroduced by a cleanup
    step. Gating on where the call is placed, or on the exit code, leaves
    those routes open.
  - **Best effort, never a gate.** A `drive-pr` not installed beside that skill,
    a failed spawn, a contended state mutex — each leaves the record to expire by
    staleness, and none changes `converge.ts`'s exit code. Safe in that
    direction precisely because the release authorises nothing: the worst
    outcome is the staleness bound alone.
  - The residual it leaves is tier 3's own identity floor: two
    sessionless resolvers in *one* tree on one PR are indistinguishable, so one
    finishing releases a record the other also relies on. Bounded — that record
    never excluded a caller in its own tree anyway, and the sibling's next
    mutating command re-claims it.

If you *are* refused by either, the right response is almost never to clear the
lease — it is to stop. A live second driver on one PR doubles every outcome
reply it reaches, and that damage is already unrepairable by the time you see
it.

**Self-recognition — the one "second driver" that never is.** Before treating a live driver as a competing one, compare its pid
to `$DRIVE_PR_SESSION`. When they match, that "driver" is your own parent: you
are the pass `drive.ts` spawned to work this round, and the lock you found is
held *for* you. Standing down here is not caution — it is the whole unattended
drive silently doing nothing while the driver counts each refusal as a
completed round (measured: up to ten wasted rounds on one PR, and a PR merged
over live findings because the log read as driven).
`drives.ts` answers it on **every** surface a pass can read, so the fact is in
the census output itself rather than only here: a `self:` line on the holder in
the text listing, `"self": true` on the row in `--json`, and a `--here` banner
that names your own parent driver instead of warning about a rival. Each reads
one predicate, and each withholds the `--stop` hint for that holder — bystander
advice, and a command that would end the drive you are a round of. Every
surface must agree: a label derived at the text print site alone leaves a pass
that censuses with `--json` with no signal, to stand down against its own
parent and burn rounds. The predicate
compares `$DRIVE_PR_SESSION` to the holder's pid, and, whenever the *caller*'s
own environment carries `$DRIVE_PR_SESSION_STARTED`, requires the claim's own
acquisition token to match it too — refusing outright if the claim carries no
token at all, since a pid the OS recycled onto your parent would otherwise
vouch for a dead driver's diagnostics-bearing claim. Only a
caller with no token of its own — an older driver or a hand-opted-in
harness (`DRIVE_PR_SESSION=<agent pid>`, above) — still falls back to
comparing pid+host alone, and even then only against an equally
diagnostics-free claim. The second-driver rule —
including everything in the paragraph above — applies only to a holder that
fails it.

The backstops bound the damage when a pass gets this wrong, and neither is the
protocol: a pass running under `claude -p` never ends its round by asking the
operator a question (there is no operator — the question lands in a log nobody
reads while the round is counted as done; act, or state a terminal outcome and
say why), and `drive.ts` itself stops with exit `14` after
`$DRIVE_PR_STALL_ROUNDS` (default 2) consecutive passes that changed nothing
observable — see `references/terminal-states.md` § the stall stop.

**The lease also fences the `POST`, not only the state write.**
Everything above guards what this clone *believes*. The act that cannot be
taken back is the comment. If `reply-to-thread.ts` and `answer-summary-finding.ts`
met the lease only *afterwards*, at the `hold` that records what they had
already posted, a pass whose driver had died, and whose lease a replacement had
taken over, would still get its `**accepted**` onto the thread first. So these
scripts consult `scripts/assert-post-allowed.ts` immediately before
their mutation and refuse with the same exit `11` and the same diagnostic. You
do not invoke it; it is wired in already. The following points apply:

- **Absence of a lease is never a refusal.** `resolve-review-comments` stays
  usable standalone, and a pass legitimately holds none before its first
  mutating `drive-state.ts` call. Only a lease held by *another live* session
  refuses; one whose owner is gone does not.
- **But absence has to be established, not assumed.** Anything the fence cannot
  read is a refusal, not an all-clear: a lease file it can enumerate but not
  parse or open, a failed `git` probe in a tree that *is* a repository, or a
  `drive-pr` installed with its fence script missing. "Is this a repository" is answered from the filesystem, never from
  git's exit status — `128` is git's generic fatal and also covers dubious
  ownership and corruption, where a live lease may well already exist.
- **A pass carrying a dead `$DRIVE_PR_SESSION` is refused outright**, before
  any lease is read — that is the opening shape, a detached pass
  outliving the `drive.ts` that exported its pid.
- **The fence is an optional dependency of `resolve-review-comments`, and that
  is settled.** That skill is usable standalone, in repositories
  where `drive-pr` — and so this fence — does not exist, so its caller probes
  for the sibling root and skips only on a positively-confirmed absence with the
  directory that root would sit in still intact. Post
  safety does vary by installation shape; it is sound because `drive-pr` is the
  only lease *writer*, because the dependency is on an executable rather than on
  a file format, and because a checkout with no `drive-pr` **and no drive
  running in it** reaches no state the fence would have refused. That second
  clause is checked, not assumed: a `drive.ts` started before the directory went
  keeps `$DRIVE_PR_TARGET` exported, so the caller refuses outright rather than
  skipping. What it cannot see — a process carrying no drive context at all,
  beside a lease that outlived the directory — is the residual, stated and
  bounded rather than closed. Vendoring the lease reader and declaring the
  integration in a manifest were both considered and lose.
  [post-fence.md](post-fence.md) is the record, including that
  residual — do not re-decide it in review.
- **The window that remains is stated, not closed.** GitHub has no
  conditional-write primitive for a comment, so the check and the `POST` are two
  moments: a lease revoked in between still lets that one comment through.
  `lib/state/lease.ts`'s header carries this with the module's other residuals.

## Draining a `kind: finding`

**`kind: finding`** — because concurrent drivers in sibling worktrees can be reading
this same `held` snapshot right now, **claim a key before dispatching its
external mutation**. The claim carries `--pushed-sha` and makes the *same*
per-hold provenance check the thread path does — a finding needed it more than
a thread did, not less: `answer-summary-finding.ts` only checks that the SHA is
the PR's live head and a clean local HEAD, which a concurrent driver's push
satisfies perfectly, and its dispatch is not idempotent, so a wrong answer is a
permanent standing claim on the PR that no later round undoes.

```bash
if TOKEN=$(<skill-dir>/scripts/drive-state.ts claim-held [PR] --key K --kind finding --pushed-sha "$(git rev-parse HEAD)"); then
  echo "dispatch (answer-summary-finding.ts), then release:"
  echo '  drive-state.ts release-held [PR] --key K --token "$TOKEN"'
else
  rc=$?   # captured in the `else`, NOT after `if !` — negating the condition
          # with `!` also overwrites `$?` with the NEGATED status by the time
          # a `then` branch runs, so `rc` there would always read 0
  echo "do NOT dispatch (rc=$rc) — see below for what rc means"
fi
```

This block deliberately has no `case`/no dummy per-branch bodies: a
placeholder like `1) : ;;` looks like it enforces something but is a no-op —
a literal caller falls straight past it and can dispatch anyway on exits that
were supposed to forbid it, which is exactly the mistake an earlier version of
this doc made. The `if`/`else` shape above is the only thing that has to be
correct, and it is: dispatch code exists *only* inside the `then` branch, so
there is nothing on the `else` side for a reader to fall through into.

Exit `0` means you hold it: proceed to dispatch, then release. Every non-zero
exit means **do not dispatch** — skip the key without touching GitHub — but the
exits call for different next steps, not the same one: `1` *usually* means
another driver's claim is live, so continuing with a different key from the
same `held` read is safe — it also covers the case where `--pushed-sha` is not
the push recorded against *this* hold, which is likewise per-key (reconcile
that one via § 3 rather than retrying it with a different SHA) — but
`claim-held` also returns `1` when the coordination lock itself could not be
acquired (breaking a stale claim, or confirming a fresh one), which is a
*coordination*-level problem, not per-key contention. Treat a `1` conservatively
rather than assuming it is
always safe to shrug off: if it recurs across several different keys in the
same pass, that pattern — not the exit code alone — is what should make you
stop and inspect (`drive-state.ts get [PR]`) rather than keep skipping through
an entire batch one silently-failing key at a time. `4` means the snapshot
you're iterating is stale, so re-read `held` before trusting anything else in
it — do not assume the key is "already finished" without checking; `3` means
the state file itself could not be read — the same "malformed, refuse"
condition every other `drive-state.ts` command already fails closed on —
which is not a per-key problem, so stop the round entirely rather than keep
operating on unreadable state.

This deliberately shows the per-key decision only, not a complete driving
loop: how a caller structures retries, backoff, and the read-refresh cadence
around it is a caller concern, not this mechanism's. Note that `drive.ts`'s
own pass bound (`bump-attempt`/`--max-rounds`) does NOT substitute for that —
it counts completed passes on a head, and cannot intervene while a single
pass is still running, so a caller that retries a failing key in a tight loop
*within* one pass is not protected by it. A caller *must* bound its own per-item
retries (and back off between them) rather than relying on the outer pass
counter to catch an inner loop it cannot see.

This is the actual double-dispatch guard: `answer-summary-finding.ts` posts a
new top-level comment on the none-answered path — the branch that dispatches
when no live marker exists yet for the fingerprint, as opposed to refusing a
*mixed* batch where some fingerprints already carry one — and that path is
**not** idempotent — so two drivers both reading the same held
snapshot and both dispatching for the same key is what corrupts the PR with a
duplicate comment. The claim closes that
for the ordinary case — only the one that wins `claim-held` may call
`answer-summary-finding.ts` for that key this round — but it is a lease with
a finite window, not a guarantee against every interleaving: a dispatch that
outlives the staleness window can still overlap its own reclaimer
(`DRIVE_PR_CLAIM_STALE_MIN`'s own comment in `lib/state/claims.ts`), and a
driver that dies after a successful `POST` but before `release-held` leaves the
key held at the SHA it answered under. If the PR head moves on before that
stale claim is reclaimed, the reclaimer's reconciliation asks for a marker at
the *new* head and misses the one sitting at the old one — and then `claim-held`
refuses it, since the held record's stamp is still the old head. That refusal
is the *right* answer (it is what stops a duplicate answer being posted) but it
is also permanent: no `--pushed-sha` will ever match that entry again, and
nothing re-enumerates it, because `summary-findings.ts`'s `unaddressed` list
already excludes an answered finding. The refusal prints both recoveries —
`release-held --key K --if-present` if the answer is genuinely already on the
PR, re-hold via § 3 if it is not — because only the PR can tell you which. Both
are narrow residuals, accepted rather than closed with heavier machinery — see
those two comments for why.

Then dispatch and **release the instant the external operation succeeds,
passing the token back**:

```bash
<skill-dir>/scripts/drive-state.ts release-held [PR] --key K --token "$TOKEN"
```

A `finding` is answered with `answer-summary-finding.ts --pushed-sha
"$(git rev-parse HEAD)"`, piping the item's own `.reason` field **verbatim** —
never re-composed or re-derived from memory, which is exactly the recollection
this batch exists not to depend on. `--pushed-sha` must be the PR's live head
and this worktree's clean HEAD, so the marker cannot precede the push; it does
not attempt to prove a commit landed for this particular finding, and § 3's
"one limit to plan around" says why nothing here can.

That call reconciles the exact fingerprint/SHA markers already on the PR first,
and then follows the paths below — read them separately, because only the
posting path mutates the PR:

- **Every fingerprint already answered** → idempotent no-op, exit 0. Nothing is
  posted, so a crash-recovery retry of a batch that already dispatched is safe.
- **Some answered, some not** → refused outright (`fail(2)`), nothing posted.
  Re-run with only the still-unanswered fingerprints, which the error names.
  Do not expect a mixed retry to dispatch the remainder — it will abort.
- **None answered** → posts a new top-level comment. This path is not
  idempotent: call it twice and the PR carries two comments, which is what the
  per-key claim above exists to prevent.

If the dispatch itself fails (a transient API error, not a crash), give the
claim back immediately rather than leaving it to expire on its own:

```bash
<skill-dir>/scripts/drive-state.ts unclaim-held [PR] --key K --token "$TOKEN"
```

so a retry — this round or the next — is not blocked behind the staleness
window. The retry itself must still start with a fresh `claim-held`: the
token above is dead, and dispatching without one defeats the whole guard.
A genuine crash needs no explicit `unclaim-held` call at all: an abandoned
claim is self-recovering, exactly like the per-PR lock it mirrors.

(For a `kind: thread`, skip all of the claim/release choreography above —
`claim-held` already removed it the moment `resolve-held-thread.ts` claimed
it, whether or not the mutation that followed succeeded on the first try: a
failed mutation call restores the item via `restore-held` at its original
round rather than leaving `claim-held`'s removal standing, so on success
there is nothing left in `held` for a `release-held` call to find.)

Never accumulate every resolve/answer and release `--all` in one call at the
end — a pass killed after resolving three of five held items and before a
single end-of-batch release would re-answer all five next round, duplicating
comments on the three already done. Release right after each one instead, so
the batch a successor reads back always holds only the genuinely unprocessed
remainder. `--all` still exists for the ordinary case where nothing failed and
the whole batch just resolved cleanly — but it refuses outright while any
held item still carries a live claim (another driver may be mid-dispatch on
it), so reach for it only once every item you claimed this round is already
released. The ordering rule holds either way — release **after** the
resolve, never before: a batch released early is a batch lost, just as
silently as never recording it. If the state lists a key you do not
recognise, it is yours — you replied to it in an earlier, interrupted pass and
the reply predates whatever ended that context. Resolve it (claiming it first
for a `finding`, same as any other key); do not re-reply — and if
`resolve-held-thread.ts` refuses a `thread` on a round mismatch (the earlier
pass crashed after that round advanced), reconcile via § 3 first: re-hold,
then resolve.
