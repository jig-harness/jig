# The `POST` fence is an optional dependency

**Where the fence is installed**, no **outcome reply or summary-finding answer**
reaches GitHub without first meeting the lease, so a pass whose lease another
live session has taken over cannot get an irreversible `**accepted**` onto a
thread ([round-finish.md](round-finish.md) § Concurrency: who may drive, and
who may finish a hold).

Stating that precondition is the point of this page rather than a hedge on it.
Where the fence is **not** installed the reply posts without any lease being
read at all — and the argument that this loses nothing, the conditions under
which it holds, the guard that enforces them, and the residual where it does
not, are what follows. Take the guarantee as conditional and read on; do not
quote the first sentence on its own.

The guarantee is also scoped to the fenced callers below and
not to every drive-authored post: `announce-merge-ready.ts` posts and deletes
its own announcement comment directly, with no fence — it is gated on
convergence, CI and a clean tree instead, and its comment is one this repo's
own tooling withdraws rather than an unrepairable entry in the
reviewer-scoring sample. Extending the fence to it is a separate question this
page does not decide. The fenced callers meet it differently, and that is the
whole subject of this page:

- `answer-summary-finding.ts` lives in `drive-pr` and **imports** the fence
  (`resolveFenceContext` / `assertRemoteMutationAllowed` from
  `lib/state/lease.ts`). It is never installed without them.
- `reply-to-thread.ts` lives in `resolve-review-comments` and **spawns**
  `scripts/assert-post-allowed.ts` — which exists as a standalone CLI for
  exactly this caller. Importing would close a dependency cycle, since
  `drive-pr` already spawns *that* skill's scripts.

The spawned path is the one that can be missing. `resolve-review-comments` is
usable on its own: a repository can run a copy of it without `drive-pr`
beside it. So the caller probes for the sibling skill root and skips the fence
when — and only when — the probe positively confirms it absent.

**Decision: the boundary stays inferred from the sibling skill's
presence on disk.** Post safety does therefore vary with what is installed. That
is sound for the reason below, the alternatives are worse, and this page is
the record so the next review reads a decision rather than re-taking one.

## Why an absent `drive-pr` may skip

These points hold together, and the sibling-worktree one is usually the point
that gets missed.

1. **`drive-pr` is the only writer, and no drive can start here.** A lease is
   taken only through `claimLease` in `lib/state/lease.ts`, reachable only from
   `drive-pr/scripts/**`. With the skill root confirmed absent from this
   checkout, nothing can take one.

   **That is not the same as "no drive is running here", and the difference is
   reachable.** A
   `drive.ts` that started while the skill *was* installed does not die when a
   checkout, base merge, or sync removes the directory underneath it; its
   already-spawned pass keeps running with `$DRIVE_PR_TARGET` exported. The
   `lstat` then reports an honest `ENOENT` while a live lease exists and, worse,
   while the pass holds exactly the PR-wide context that makes the fence sweep
   *every* worktree rather than just this one. So absence of the directory is
   only half the premise. The other half is checked directly:
   `assertNoDriveContext` in `reply-to-thread.ts` refuses the skip whenever
   `$DRIVE_PR_TARGET` is set — the one signal that survives the directory it
   describes, and one `drive.ts` alone writes. A standalone
   `resolve-review-comments` install never carries it, so the case the skip
   exists for is untouched.

   Not `$DRIVE_PR_SESSION`, which `drive.ts` also exports: that one is
   *additionally* documented as a hand-set opt-in for unidentifiable harnesses
   ([round-finish.md](round-finish.md) § Concurrency), so a standalone install may hold one with no drive in
   existence. Refusing on it would deny the very posts this skip is for.

2. **The dependency is on code, not on a data format.** The fence is a *spawn of
   the sibling's own executable* — the same shape `current-round.ts` uses for
   `drive-state.ts` — never a read of its files. An optional code dependency's
   absence is exactly a filesystem question, because there is no second policy
   to pick between: there is a subject that exists or does not. This is the
   distinction the "post safety should not vary with ambient directory presence"
   objection elides. What varies is not the rule applied to a drive; it is
   whether a drive is a thing that can exist here at all.

3. **A sibling worktree cannot smuggle one in.** Drive state is clone-wide
   (`store.ts` keys it by the clone's `--git-common-dir`, deliberately not
   `--git-dir`), so a *different* worktree of this clone, checked out at a commit
   that does carry `drive-pr`, can hold a live lease against the same store
   while this tree has no `drive-pr` at all. Skipping loses nothing even then:
   with no `--pr` and no `$DRIVE_PR_TARGET`, `assertRemoteMutationAllowed`
   checks **actor-wide** — this working tree's own leases — which the sibling's
   are not. The PR-wide sweep across every worktree is what would see them, and
   it engages only when a PR is named; `$DRIVE_PR_TARGET` is exported by
   `drive.ts` alone, so a process carrying one is refused by (1) before
   reaching here rather than skipping past it.

   What this point does **not** claim is that such a tree holds no leases of
   its own — by (1) it can, if a drive ran here before the directory went. That
   is the residual below, and it is a different mechanism from the sibling
   worktree this point is about.

So the fence, had it been installed in that checkout, would have returned
*allowed* in every state that checkout can reach **with no drive live in it** —
and a posting process that **carries drive context** is refused outright by (1)
rather than skipped. Within that scope the skip is not a weaker answer to the
same question; it is the same answer, reached without spawning anything.

Note the gap between those two phrasings, because it is the residual and not a
looseness of wording: what (1) detects is the *posting process's own* context,
not the existence of a drive. A live drive whose lease this tree holds, with the
poster carrying no context, is live and not refused. § The residual is that
case.

### A rule against compatibility paths does not reach this

Repositories that forbid backward-compatibility shims forbid dual-path
tolerance: compat valves, renamed-but-kept columns, "accepts both old and new"
parsers. Those are two
shapes of *one* repository at two points in *time*, where one branch is dead
weight kept alive for data that no longer exists. This is two different
*installations* at the same time — both live, neither superseding the other,
with no legacy branch to delete. Extending the rule here would not remove a
tolerated old path; it would remove a supported install.

## Why the fence is not vendored into `resolve-review-comments`

Every part of `lib/state/lease.ts` that a reader would have to reproduce was
hardened against: state-dir swap-and-recreate races straddling the
enumeration, PR canonicalization for leading zeros and for values past
`Number.MAX_SAFE_INTEGER`, dangling symlinks, and lease records that enumerate
but cannot be opened. A "small read-only lease reader" at that specification
does not exist.

The coupling is the deciding cost, not the size. `resolve-review-comments`
already carries parity copies of `lib/cli.ts` and `lib/proc.ts`, but those copy
*process plumbing*, whose contract belongs to the runtime. A lease reader would
copy `drive-pr`'s on-disk **file format** into a skill that ships to repositories
with no `drive-pr` to produce one, and make every lease-schema change a
two-skill change. A drifted copy is worse than no copy: it refuses posts a live
drive would allow, or allows posts it would refuse, and reports neither.

## Why the integration is not declared in a manifest

A manifest or capability file both skills read moves the variance from an
inferred fact to a declared one, and a declaration can disagree with reality in
both directions — assert "nothing to fence" while a drive is live, or assert
"fenced" where no fence exists and refuse every post. The probe cannot: it reads
the same filesystem the fence would be spawned from, so it is wrong only in
states where the spawn would have been wrong too. And the manifest would have to
ride every distribution of the skill into repositories where its only correct
value is exactly what the probe already derives — a hand-maintained restatement
of a mechanically derivable fact.

## The residual

Stated, not closed: a poster carrying **no** drive context at all — an
interactive session, or a harness that exports neither variable — in a tree
whose `drive-pr` went absent while a live lease against that same tree
survives. `assertNoDriveContext` has nothing to read there, so the skip fires
and a fence that existed would have refused.

The **creation** direction belongs here too, and is a race rather than a state.
The probes establish absence at the moment they
run; nothing holds it. `drive-pr` can be restored — a checkout, an install —
and a drive can take a lease between the probe and the `POST`, and a
context-free poster then posts unfenced. Note what is NOT the fix: the fence is
already the last local act before the mutation, with nothing between it and the
call, so "check later" has nowhere left to move. Two path probes cannot make an
absence durable, and no third probe can either; a check-then-act pair is what
this is. The durable answer is the capability boundary in
§ What would change this decision — moving the fence into the skill that is
always present, so there is no absence to establish — not a tighter probe here.

It is narrow on both sides. The lease has to belong to *this* working tree
(actor-wide is what an unnamed PR checks), so it has to have been written by a
drive that ran here before the directory went, and it expires on its own once
that session dies or goes idle. Closing it needs this side to read a lease
record rather than run one, which is exactly the vendoring
§ Why the fence is not vendored into `resolve-review-comments` rejects on its
merits — the trade is a real, silent file-format coupling
against a state that needs a mid-drive checkout and a surviving foreign
session to reach.

The residual is not someone hand-exporting `$DRIVE_PR_TARGET` in a
`drive-pr`-less checkout: `drive.ts` exports the variable into every pass it
spawns, so that state is the ordinary one a `git checkout` produces mid-drive,
and it is refused rather than merely documented.

Distinct from the residual in `lib/state/lease.ts`'s header, which applies
wherever the fence *does* run: GitHub has no conditional-write primitive for a
comment, so the check and the `POST` are two moments.

## What would change this decision

- Every install of `resolve-review-comments` also carries `drive-pr` — as the
  `jig` plugin does — and no standalone copy remains in use. The probe
  then guards nothing and should go.
- `assert-post-allowed.ts` moves into `resolve-review-comments` and `drive-pr`
  spawns it in the other direction. That inverts the optional edge onto the
  skill that is always present, and is the only shape that makes the fence
  unconditional without copying a file format.

Absent one of those, re-raising this is re-deciding it.

## Note: a second cross-skill spawn exists, and it is NOT a fence

Recorded here because this page is where a reader looks for the cross-skill
boundary, and because the inventory above would otherwise read as complete.
`release-sessionless-lease.ts` is a second standalone CLI in
`drive-pr` written for one caller in `resolve-review-comments` — `converge.ts`,
which spawns it when a run of its loop that actually worked a round reaches a
terminal exit, to hand back the
`holder: 'worktree'` records a sessionless pass leaves behind. It takes the same
shape as `assert-post-allowed.ts` for the same reasons: a spawn of this skill's
executable rather than an import of `lib/state/lease.ts`, so the standalone
install keeps working and no lease *file format* crosses the skill boundary.

Everything above about *failure* inverts for it, and that is the part not to
carry across by analogy. This page argues at length that the `POST` fence must be
established before it may be skipped, because the act behind it is
irreversible. The release authorises no act at all: not releasing simply leaves
the record to expire by staleness (`$DRIVE_PR_LEASE_STALE_MIN`), the same
bound that applies with no release at all. So its probe skips on *any* unreadable answer
rather than only a confirmed `ENOENT`, its non-zero exits are swallowed, and it
needs no `assertNoDriveContext` counterpart — there is no state it could reach
in which skipping costs anything. Read `references/terminal-states.md`
§ A tier-3 record also clears on *completion* for what it may and may not drop;
nothing in this page's decision changes, and no new gate is owed.

## Note: the existing parity copies have no drift gate

Recorded because it is the cost any future vendoring would inherit. `scripts/lib/cli.ts` and `scripts/lib/proc.ts`
exist in both skills as deliberate parity copies — supersets of each other rather
than byte-identical, since each skill's own needs have grown them apart — and
**no gate fails when they drift**. A fix landing in one is ported to the
other by hand; the file headers name each other so the search is one grep.

That is not a theoretical exposure: `ghCall` — the deadline chokepoint both
files exist for — has diverged in contract before, with a caller-supplied
`timeoutSec` clamp present in one copy and structurally impossible in the
other, until the clamp was ported by hand. A byte-comparison gate cannot work
here (the copies are *meant* to differ), so a drift check would have to
compare the *shared* export set symbol by symbol; none exists.

None of that changes the decision above — it argues for it. The reason to keep
the lease reader out of `resolve-review-comments` is precisely that a hand-ported
copy drifts, and the copy that drifted here is the cheap one, whose contract
belongs to the runtime. A copy of `drive-pr`'s lease file format would be the
expensive one, and its drift would be silent in the direction that posts.
This decision introduces no new copy, so it adds no gate.
