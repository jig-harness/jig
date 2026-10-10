/**
 * The SESSION lease: which driving session may mutate one PR's drive state from
 * one working tree.
 *
 * `actor.ts` identifies a driver by its WORKING TREE, and says why that is
 * sound: `drive.ts` holds a single-instance lock keyed by the same tree, so at
 * most one driver runs per tree. That premise covers `drive.ts` and nothing
 * else. An INTERACTIVE pass — an agent walking SKILL.md's steps by hand — takes
 * no lock at all, so two agent sessions in ONE tree (an interactive session plus
 * a forked or background one) both derive the same actor and the state model
 * cannot tell them apart:
 *
 *   - `hold` upserts by key, so the second session's hold silently REPLACES the
 *     first's — same key, same actor, a different `commentUrl`;
 *   - `stamp-held` stamps "the holds this tree owns", which is now both
 *     sessions' holds;
 *   - `claim-held` has nothing to compare, so neither claim is refused.
 *
 * Measured on PR #4057 (2026-08-13): all seventeen threads one session had just
 * replied to carried TWO `**accepted**` replies, its own and a concurrent
 * session's minutes later — which corrupts the reviewer-scoring sample the
 * outcome vocabulary feeds (AGENTS.md § Addressing PR Comments), and is not
 * repairable after the fact because the comments are posted.
 *
 * So this module adds the component the actor is missing: a SESSION. The lease
 * is scoped to (working tree, PR) — the same universe the actor already covers.
 *
 * ── And PR-WIDE admission on top of it ───────────────────────────
 *
 * That per-tree scoping used to be the whole story, on the reasoning that two
 * Conductor worktrees driving one PR is the supported topology and the whole
 * reason the actor is the tree in the first place. Both halves of that are
 * still true — and neither is a reason to let both trees TRIAGE the same PR.
 * The damage is identical to the one-tree case and arrives by the same route:
 * nothing stopped two worktrees enumerating the same unresolved threads and
 * each replying with its own outcome, so every thread both reached carried two
 * outcome replies — unrepairable once posted, and corrupting the
 * reviewer-scoring sample the outcome vocabulary feeds. The clone-wide state
 * file gave them one round budget and one held batch, but no admission gate.
 *
 * So a claim now has these conditions, and they answer different questions:
 *
 *   - per-tree — is another SESSION in MY tree driving? (exit 11, above)
 *   - PR-wide  — is another WORKING TREE driving this PR? (exit 13, below)
 *
 * The second is not a second lease file. It is a rule read off the lease files
 * that already exist: `leaseFilesFor` enumerates every tree's lease for a PR,
 * `leaseAlive` says which of them are still being driven, and a claim is
 * admitted only when none of the live ones belongs to another tree. Deriving it
 * rather than storing it is what makes it self-clearing for free — a dead or
 * idle holder stops being live by exactly the test the per-session lease
 * already uses, so a crashed worktree cannot wedge the PR for the others.
 *
 * Deriving it also fixed its one limit, which took two more passes to close:
 * the refusal needs ONE SIDE TO HAVE LEFT A LEASE. A sessionless resolver
 * walking in on a tree that is identified was closed first (taking a lease and
 * reading someone else's are different capabilities, and only the first needs
 * an identity). Two SESSIONLESS resolvers in two trees survived that, because
 * neither wrote the artefact the other would read — and could still put two
 * outcome replies on every thread they both reached. Tier 3 of the ladder below
 * is where that is closed, by giving the tree itself a holder record; the whole
 * argument for why that needs no pid, and what it costs, is stated there
 *.
 *
 * What it deliberately does NOT do is make a second worktree useless. Every
 * READ command is ungated (`get`, `held`, `parked-keys`, `lease`, …), so a
 * second tree can inspect the drive completely; what it may not do is mutate
 * this PR's drive state, which is the same thing as posting outcome replies to
 * it. And the per-hold `actor` provenance is untouched and still
 * load-bearing, because holds OUTLIVE the tree that made them: admission says
 * who may drive now, provenance says whose push answers a promise made earlier.
 *
 * ── And TREE-WIDE admission across DIFFERENT PRs too ─────────────
 *
 * The per-PR lease above is scoped to (working tree, PR) — deliberately, so
 * two Conductor worktrees driving different PRs stay independent. But that
 * scoping leaves ONE tree's two INTERACTIVE sessions unguarded when they drive
 * TWO DIFFERENT PRs: each resolves its own `leasePathFor` file, neither sees
 * the other's, and both are admitted — into the SAME checkout, which they can
 * then edit, commit, and push over one another. This is not a variant of the
 * (working tree, PR)-scoped hazard above; it is the hazard `drive.ts`'s
 * worktree-wide single-instance lock (`store.ts`'s `worktreeLockName`) already
 * closes for the UNATTENDED path (measured on PR #4031 round 8: two `drive.ts`
 * processes in one checkout, different PRs, cross-shipped each other's
 * uncommitted edits) — this header used to attribute that same guarantee to
 * interactive passes too, which was never true: that lock excludes at most one
 * `drive.ts` PROCESS, and an interactive pass takes no lock of any kind.
 *
 * `TreeLease` is what actually closes it for the interactive path: a SECOND
 * lease, alongside the per-PR one, keyed by ACTOR ALONE rather than (actor,
 * pr) — see `claimTreeLease`. Every identified session claims both leases on
 * every mutating command, so a session driving PR A and a session driving PR B
 * from the same tree now collide on the ONE tree lease even though their
 * per-PR leases never would. Exit 11, the identical contract as the per-tree
 * refusal above, because it is the identical situation: another live session
 * in YOUR tree, whichever PR it names.
 *
 * Ladder tier 3 (no session identity) claims this SAME tree lease too, as a
 * `holder: 'worktree'` presence record rather than a session's — see
 * `claimSessionlessTreeLease` and the ladder's tier-3 entry
 * below for what identity a runtime with none can still prove, and at what
 * cost.
 *
 * ── Why a lease rather than a lock ──────────────────────────────────────────
 *
 * There is no long-lived process to hold a lock for an interactive session:
 * every `drive-state.ts` invocation is a fresh process that exits in
 * milliseconds. What persists is the AGENT process behind them, so the lease
 * records that process's pid and is renewed by each mutating call. Liveness is
 * then the same two-part test `drive.ts` applies to its own locks — a pid that
 * is gone means stale HOWEVER young, and a pid that answers is honoured only
 * while the lease keeps being renewed, because the OS hands a dead process's
 * number to a stranger and a stranger never renews.
 *
 * ── Who "this session" is ───────────────────────────────────────────────────
 *
 * A ladder, in this order, and each tier is a pid because a pid is the only
 * identity a refusal can tell a human how to VERIFY:
 *
 *   1. `$DRIVE_PR_SESSION`. `drive.ts` exports its own pid here before it
 *      spawns anything, which is what makes a whole unattended drive — the
 *      driver plus every round's pass, each a separate agent process — count as
 *      ONE session for as long as the driver lives. It is also the documented
 *      channel for a harness this ladder does not know: export the agent
 *      process's pid and the lease works exactly as it does under tier 2.
 *   2. `$CLAUDE_PID` — the Claude Code agent process, set by the harness in
 *      every tool call's environment. Two sessions in one tree are two such
 *      processes with two pids, which is precisely the case measured above (and
 *      the same signal the manual `pgrep`-based detection used before this
 *      existed).
 *   3. Nothing — and this tier holds a record whose HOLDER IS THE WORKING TREE
 *      rather than a session. No pid is invented for it, because the
 *      tempting fallback is `process.ppid` and it is wrong in the one direction
 *      that matters: under an agent that spawns a fresh shell per tool call
 *      every invocation would be its own "session", so two concurrent calls
 *      from ONE agent refuse each other, and a false refusal wedges work that
 *      was never in conflict.
 *
 *      What that reasoning rules out is a SESSION identity, not a record. The
 *      two questions this module answers are different: "is another session in
 *      MY tree driving?" needs one, "is another WORKING TREE driving this PR?"
 *      does not — `actor.ts` already answers the second, without a pid and
 *      without guessing. So tier 3 writes a `holder: 'worktree'` lease, which
 *      is scoped to the tree it names and therefore CANNOT refuse a sibling
 *      invocation of its own agent (every one of them resolves the same actor,
 *      and the PR-wide gate filters on exactly that). It excludes only other
 *      trees, which is the whole and only thing it is for.
 *
 *      Its liveness is `lastSeen` freshness alone, since there is no pid to
 *      test — see `leaseAlive`, and `Lease.holder` for why that is a
 *      discriminant rather than a sentinel pid. That is strictly weaker than a
 *      session lease's two-part test, and the cost is bounded and stated: a
 *      sessionless resolver that dies mid-drive keeps other trees out for at
 *      most one staleness window, the same bound a lease held on a FOREIGN HOST
 *      already carries (`pidAlive` counts a foreign host as alive, so staleness
 *      is its only clear too) and the same one `unreadableLeaseFilesFor`
 *      accepts for a file it cannot parse. `clear-lease --all` ends it
 *      immediately, and every refusal that names a tree-held record says so.
 *
 *      INTRA-TREE BEHAVIOUR IS UNCHANGED by all of this, deliberately: tier 3
 *      never refused a caller in its own tree and still does not. A tree that
 *      already holds a live SESSION lease is represented in the PR-wide gate
 *      already, so a sessionless caller there writes nothing and keeps the old
 *      path (`claimLease` returns `null`, `drive-state.ts` fences it with
 *      `assertNoForeignDriveNow`); and an identified session may take over its
 *      own tree's presence record freely, because that record was never a claim
 *      about sessions. The residual that leaves — two sessionless resolvers in
 *      ONE tree — is the same one tier 3 has always had, for the same reason:
 *      they are indistinguishable to every identity this runtime exposes.
 *
 * SESSIONS SHARING ONE AGENT PROCESS are one session to this model — an
 * in-process subagent inherits its parent's `$CLAUDE_PID` by construction.
 * Separating those needs an identity that outlives the subagent's individual
 * tool calls but expires when the subagent does, and the harness exposes none:
 * the available per-subagent id is not liveness-checkable, so a finished
 * subagent's lease would block its own parent for a whole staleness window.
 * That is the residual, and it is the same trade `actor.ts` documents for its
 * own: refuse to guess in the direction that wedges live work.
 *
 * ── The fence over EXTERNAL mutations ────────────────────────────
 *
 * Everything above guards DRIVE STATE — what this clone believes. It does not
 * guard the one act a pass performs that cannot be taken back: posting to
 * GitHub. `reply-to-thread.ts` and `answer-summary-finding.ts` meet the lease
 * only AFTERWARDS, when they record the outcome via `drive-state.ts`, by which
 * time the duplicate `**accepted**` reply is on the thread and unwithdrawable —
 * precisely the corruption an earlier change exists to prevent, reached through the one
 * operation the state fence does not sit in front of.
 *
 * `assertRemoteMutationAllowed` below is that fence, and it is deliberately a
 * different shape from `assertLeaseUnchanged`: those callers hold no admitted
 * lease to compare against, so it re-derives the session and asks only whether
 * SOMEONE ELSE is now driving this tree. Its rules, and why each is the way it
 * is, are on the function.
 *
 * Its callers, and the boundary is IRREVERSIBILITY rather than "writes to
 * GitHub". `reply-to-thread.ts` and `answer-summary-finding.ts` each POST a new
 * comment: a second one stands forever, carries its own marker, and enters the
 * reviewer-scoring sample twice. `resolve-thread.ts` / `unresolve-thread.ts`
 * are not fenced, and that is a decision rather than an oversight — resolving
 * an already-resolved thread is a no-op, and the state is reversible by the
 * sibling script, so a doubled call leaves nothing behind to repair. Fencing
 * them would spend a subprocess per thread to prevent nothing.
 *
 * EVERY OTHER OUTCOME REFUSES, which is the correction round 1 of PR #4107
 * forced and the rule to apply to any later addition here: this fence may
 * allow only on a POSITIVELY ESTABLISHED absence, never on a failure to look.
 * Separate paths read a failure as "no lease" and posted — an
 * enumerable-but-unreadable lease record, a `git` probe that never ran, and a
 * sibling skill installed with its fence script missing — and independent
 * reviewers found several of them in one round, one with a reproduction. They
 * were the same defect wearing different faces, so they are fixed as a class
 * and each carries its own probe.
 *
 * THE RESIDUALS it does not close, stated rather than implied:
 *
 *   1. THE CHECK AND THE POST ARE TWO MOMENTS. Every state-side fence in this
 *      module is made to hold THROUGH its mutation by the state mutex — the
 *      revocation paths take it, so a takeover cannot land between
 *      `assertLeaseUnchanged` and the write it guards. Nothing can do the same
 *      here, because the write is on GitHub: there is no conditional-write
 *      primitive for a comment (no `If-Match`, no idempotency key on the
 *      REST comment endpoint), so a lease revoked after the check and before
 *      the POST still lets that ONE comment through. Holding the state mutex
 *      across an outbound `gh` call would not fix it either — it would block
 *      every other command on this PR for a whole network round-trip while
 *      still proving nothing about the moment GitHub accepted the write.
 *      Narrowed from "an entire pass may keep posting after its lease is gone"
 *      to "one in-flight comment may", which is the same class of residual
 *      `answer-summary-finding.ts` already documents for its reconciliation.
 *      The state-DIRECTORY identity checks `assertRemoteMutationAllowed` and
 *      `resolveFenceContext` perform together (PR #4107 findings A and C —
 *      a rename-and-recreate that let an enumerated lease read back as
 *      `absent`, closed at two different windows: the driver-established
 *      `$DRIVE_PR_STATE_DIR_IDENTITY` baseline for a swap that predates the
 *      pass, and the enumeration-time identity re-confirmed at every `absent`
 *      read for one landing during the fence) narrow a DIFFERENT gap but are
 *      bound by this exact same limit: they can prove the directory's
 *      identity up to the instant this function returns, never through the
 *      POST that follows.
 *
 *   2. A LEASE THAT WAS REVOKED AND NOT RECLAIMED READS AS ABSENT. `reset`
 *      sweeps this PR's leases, and a `clear-lease` with no successor leaves
 *      the file simply gone — which the fence reads as "no lease", the
 *      standalone case it must not refuse. It cannot tell the two apart: a
 *      lease holds nothing but a claim about right now, and `readLease` has no
 *      tombstone to consult (deliberately — see its own comment on why a
 *      malformed lease is ABSENT rather than fail-closed). The exposure is
 *      bounded by what revocation without a successor means: nobody else is
 *      driving, so there is no second writer to double-post against, which is
 *      the harm this fence exists to prevent.
 *
 *   3. A TOKENLESS SESSION'S OWNERSHIP TEST IS STILL (pid, host), AND A PID IS
 *      RECYCLABLE. `sessionStarted` makes ownership non-recyclable for every
 *      session that carries a token, but tier 2 (`$CLAUDE_PID`) never
 *      populates one — so for two tokenless sessions on one host, a pid handed
 *      from a dead session to a live successor makes that successor's lease
 *      read as the caller's own, skipping the refusal. See `isMine` for why
 *      neither alternative is available: refusing tokenless callers breaks a
 *      Claude Code session against the lease it just wrote, and minting a
 *      token needs a process start time no `node:`-only API exposes for
 *      another pid. Bounded by requiring a same-host pid reuse inside one
 *      staleness window, between two sessions that both identify themselves
 *      only by pid (chatgpt-codex-connector, a reference-implementation pull request round 17).
 *
 *      an earlier change closes the ADMISSION-side counterpart of this same hazard —
 *      `claimLease` (per-tree) and `assertNoForeignDrive` / `clearAllLeases`
 *      (PR-wide) — for the one case it can PROVE: BOTH sides carry a
 *      token, so `isMine`'s mismatch is backed by a timestamp `isRecycledPid`
 *      can order (see that function's own doc for the full criterion and the
 *      proof — several review rounds of this PR, #4128, were needed to arrive
 *      at "both sides timestamped" as the exact, final boundary; earlier
 *      revisions tried narrower carve-outs for a tokenless side and each was
 *      defeated).
 *      Before an earlier change, those three asked `leaseAlive` whether a
 *      foreign-by-`isMine` lease's owner was still running, and once a
 *      recycled pid is the CALLING session's own, that question is
 *      tautologically "yes" — so a per-tree claim stayed refused (not
 *      silently merged, but not a takeover either) for a full staleness
 *      window instead of minting the new generation the collision requires,
 *      a PR-wide claim was refused identically (exit 13) for a rival that
 *      could not exist, and `reset` reported a demonstrably dead lease as a
 *      live one to preserve. `isRecycledPid` is the fix common to all three:
 *      it strips `leaseAlive`'s pid evidence out of the decision precisely
 *      where `isMine` has already proven it cannot mean what it normally
 *      means — but ONLY where a timestamp exists on both sides to prove
 *      DIRECTION as well as difference. EITHER side tokenless — this
 *      residual's own case (both tokenless, where `isMine` returns `true`
 *      and no takeover decision is ever reached) and its mirror (exactly one
 *      side tokenless, where `isMine` returns `false` but no ordering
 *      evidence exists) — gets no fast path and relies on the ordinary
 *      staleness wait; `isRecycledPid`'s own doc names this R4.
 *
 *      `assertRemoteMutationAllowed` (the external-mutation fence)
 *      is DELIBERATELY NOT part of this fix, despite reading the identical
 *      `isMine`/`leaseAlive` pair — see its own comment at the `isMine(held,
 *      ctx.session, ctx.actor) || !leaseAlive(held)` check. It guards a POST
 *      with no undo rather than an admission with a cheap retry, so it keeps
 *      refusing on ANY non-mine live pid, `isRecycledPid`-provable or not;
 *      the "session-started token (PR #4107 finding B — pid recycling)"
 *      suite locks that in and would have caught an `isRecycledPid` carve-out
 *      added there in error (it was, once, in an earlier iteration of this
 *      change).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fail, isDigits } from "../cli.ts";
import {
  git,
  gitCallTimeoutSeconds,
  pidAlive,
  pidCheckCommand,
} from "../proc.ts";
// The code itself, not two hand-written literals (`11`/`13`) repeated here:
// this module's own exported exit constants below mean what
// TERMINAL_STATES says they mean, and an independent literal is exactly how
// that stops being true (the same reasoning DRIVE_HELD_ELSEWHERE_EXIT
// already carried before this constant existed).
import { outOfBandExitCode } from "../status/terminal-states.ts";
import { resolveActor, worktreeRoot } from "./actor.ts";
import { atomicWrite } from "./fsutil.ts";
import { legacyFootprint, migratedMarkerPath } from "./legacy-state.ts";
import {
  createLock,
  LOCK_ACQUIRE_MAX_SEC,
  LockAcquireTimeoutError,
  lockHeartbeatMs,
  type PathLock,
} from "./lock.ts";
import { peekDefaultStateDirFor } from "./store.ts";

/** The persisted record. Every field is required; a partial record is debris. */
export interface Lease {
  /**
   * WHO holds this record, and therefore how its liveness may be tested
   *.
   *
   *   - `session` — the ordinary case, every tier-1/tier-2 lease. A pid holds
   *     it, so liveness is the two-part test `leaseAlive` has always applied:
   *     the pid answers AND the record has been renewed inside the window.
   *   - `worktree` — the tier-3 PRESENCE record. No session could be
   *     identified, so there is no pid to record and none to test; the WORKING
   *     TREE is the holder, and freshness is the only liveness it has.
   *
   * A discriminant rather than "`pid === 0` means sessionless", because every
   * reader that must treat the two differently should have to name which one it
   * is looking at. `parseLease` enforces the correspondence in both directions,
   * so the pid field can never disagree with this one.
   */
  holder: "session" | "worktree";
  /** The session's pid — see the ladder above. `0` for a `worktree` holder. */
  pid: number;
  /** Where that pid lives, because a pid alone is only meaningful per host. */
  host: string;
  /**
   * `process.platform` of the session that wrote this, so a refusal on ANOTHER
   * machine can name a liveness check that host can actually run.
   *
   * Recorded rather than inferred: the reader's platform says nothing about the
   * writer's, and inferring it handed a Windows holder an `ssh <host> ps -p`
   * that cannot run there (docomply-review round 9, a reference-implementation pull request).
   */
  platform: string;
  /** The working tree the lease is scoped to (`actor.ts`'s id), for readers. */
  actor: string;
  /**
   * That tree's PATH — diagnostics only, never compared (`actor` is the id).
   *
   * A cross-worktree refusal has to name a place a human can go: the actor is
   * a sha256 prefix, so a refusal that carried only `wt-3f9c…` told the reader
   * which tree holds the PR in the one form they cannot act on. Recorded by the
   * writer rather than derived by the reader for the same reason `platform` is
   * — the reader is in a DIFFERENT tree by construction here, so it has no way
   * to resolve someone else's path.
   */
  worktree: string;
  /** When this session first took the lease. */
  startedAt: string;
  /** When it last ran a mutating command — the renewal this lease lives by. */
  lastSeen: string;
  /** Which command that was. Diagnostics only; never compared. */
  command: string;
  /**
   * The GENERATION token the admission fence compares (`assertLeaseUnchanged`).
   *
   * Preserved across one session's renewals and regenerated by every takeover,
   * so it answers "is this still the lease my command was admitted on" rather
   * than "has anything been rewritten".
   *
   * A random nonce rather than a timestamp. `startedAt` was the obvious
   * candidate and is wrong: ISO text has millisecond resolution, so a
   * `clear-lease` plus a same-session reclaim inside one millisecond produces
   * an identical `(pid, host, startedAt)` tuple and the fence would accept a
   * lease that had genuinely been revoked and recreated (docomply-review round
   * 8, PR #4069). An identity must not be derived from a clock it can tie on.
   */
  generation: string;
  /**
   * The writing session's OWN acquisition token — `$DRIVE_PR_SESSION_STARTED`,
   * minted once by `drive.ts` (`diag.started`) and inherited unchanged by
   * every pass it spawns — or `''` when that session carried none.
   *
   * `generation` cannot serve here: it identifies an ADMISSION EPOCH on THIS
   * lease record, which presupposes a lease this caller already claimed.
   * `isMine` (below) has no such thing to compare against — the external-
   * mutation fence never admits — and its (pid, host) comparison alone is
   * exactly as recyclable as the pid it reads: if this session's own driver
   * dies and the OS later hands its exact pid to an unrelated NEW drive-pr
   * session, that session's fresh lease matches (pid, host) alone and reads
   * as "ours" — skipping the `leaseAlive` check that would otherwise have
   * refused a live, genuinely foreign session (chatgpt-codex-connector,
   * a reference-implementation pull request round 8, finding B). `sessionStarted` is the identical
   * instance-token correlation `drives.ts`'s `ownParentDriver` already uses
   * for the same hazard on `claims.ts`'s admission locks — ported here, not
   * reimplemented; see that function's doc comment for the exact fallback
   * semantics `isMine` mirrors.
   *
   * REQUIRED in `readLease` like every other field — the KEY must be present
   * and a string. The VALUE `''` is legal and is what a session carrying no
   * token writes, so the case that actually needs to keep working does.
   *
   * An earlier revision read this leniently (missing → `''`) to keep
   * pre-field leases parsing. That is an accepts-both-shapes parser and the
   * pre-GA BWC stance rules it out (`CLAUDE.md` § Backward Compatibility);
   * worse, it quietly kept the weaker pid/host-only ownership decision alive
   * for exactly the records that omitted the key. Lease state is ephemeral —
   * it expires on its own and `clear-lease` drops it — so a superseded record
   * failing to parse is a rollout detail, not a migration
   * (chatgpt-codex-connector, a reference-implementation pull request round 15).
   */
  sessionStarted: string;
}

/**
 * The TREE-WIDE session lease: admits at most one live session per
 * WORKING TREE, whichever PR it is driving.
 *
 * `Lease` above answers "who may mutate (this tree, this PR)"; nothing
 * answered "who may mutate this tree at all", so two interactive sessions
 * driving two DIFFERENT PRs resolved two different `leasePathFor` files, each
 * saw no conflict, and both were admitted to the SAME checkout — which they
 * can then edit, commit, and push over one another. `drive.ts`'s
 * worktree-wide single-instance lock (`store.ts`'s `worktreeLockName`) gives
 * the unattended path exactly this guarantee already; this is its interactive
 * counterpart, built the same way `Lease` itself was — as a LEASE, not a lock,
 * because there is no long-lived process behind a `drive-state.ts` invocation
 * to hold one for (see this module's header, "Why a lease rather than a
 * lock").
 *
 * Same shape as `Lease`, plus the one thing a per-tree record needs that a
 * per-PR one gets for free from its own filename: `pr` names which PR this
 * session is CURRENTLY (or most recently) driving, so a refusal can say what
 * the tree is busy with. Diagnostics only, exactly like `Lease.worktree`, and
 * never compared — ownership of the tree lease turns on (pid, host,
 * sessionStarted) alone, via the same `isMine` every per-PR lease uses, so one
 * session juggling several PRs from one tree renews its OWN tree lease on
 * every one of them without ever refusing itself.
 */
export interface TreeLease extends Lease {
  pr: string;
  /**
   * A FRESH random token minted on every single write to this path — never
   * preserved across a renewal, unlike `generation` — so two writes can never
   * be mistaken for one another even when every OTHER field coincides.
   * `lastSeen` only has millisecond resolution: two writes from the SAME
   * session, for the SAME pr and command, with `generation` preserved by a
   * renewal, can tie on it and produce byte-for-byte identical JSON. Round
   * 1/2's rollback compared the raw serialized bytes for exactly this reason
   * — to tell "the write THIS call made" apart from a sibling's — and that
   * comparison silently stopped working the moment two such writes collide,
   * letting one sibling's rollback revert or delete a LATER, successful
   * sibling admission that merely happened to serialize identically
   * (docomply-review, a reference-implementation pull request round 4). `rollbackTreeLease` now compares
   * THIS field specifically rather than relying on whole-record byte
   * equality.
   */
  revision: string;
}

export interface Session {
  pid: number;
  host: string;
  /** Which tier of the ladder answered, for the "no session" case and docs. */
  source: "DRIVE_PR_SESSION" | "CLAUDE_PID" | "none";
  /**
   * This session's own `$DRIVE_PR_SESSION_STARTED`, or `''` when it carries
   * none. Populated ONLY for `source === 'DRIVE_PR_SESSION'`, mirroring
   * `drives.ts`'s `ownParentDriver`, which checks pid+host BEFORE ever
   * consulting the token — the token is meaningless without that
   * precondition, and reading it for a `CLAUDE_PID`-tier session would risk
   * trusting a value left stale in the shell from an unrelated `drive.ts` run
   * earlier in the same session. See `Lease.sessionStarted` for what this
   * closes.
   */
  sessionStarted: string;
}

/**
 * How long a lease whose owner pid still ANSWERS may go un-renewed before it
 * counts as abandoned.
 *
 * The same quantity, for the same reason, as `drive.ts`'s
 * `HEARTBEAT_STALE_MIN_DEFAULT`: a pid that answers proves some process exists,
 * not that the DRIVER exists, and after a session dies the OS may hand its
 * number to an unrelated long-lived process that would otherwise refuse every
 * later start forever. A real session renews on every mutating command; a
 * recycled pid never does.
 *
 * Generous on purpose. Renewal here is driven by the WORK — an agent may think,
 * run gates, or wait on a Testbox for a long time between two mutating calls —
 * so unlike `drive.ts`, which renews on a timer of its own, there is no floor
 * this can be tightened against. Guessing too eagerly costs the two concurrent
 * drivers this exists to prevent; guessing too slowly costs a refusal a human
 * clears in one command, which the refusal itself names.
 */
const LEASE_STALE_MIN_DEFAULT = 360;

/** The renewal cap in `renewAfterMs` — the oldest a lease can be on admission. */
const RENEW_AFTER_MAX_MS = 30_000;

/**
 * Is a git repository in play here at all — answered WITHOUT asking git,
 * because git cannot answer it unambiguously.
 *
 * The obvious discriminator, and the one this first used, is `git rev-parse`'s
 * exit status: 128 for "not a git repository", 127 when the binary never ran.
 * It is not sound. 128 is git's GENERIC fatal status — dubious ownership, a
 * permissions failure, a corrupt object store all produce it — so reading 128
 * as "no repository, therefore no lease" authorises the POST on a tree that may
 * hold a live one (chatgpt-codex-connector P2 and docomply-review high, PR
 * #4107 round 2, independently).
 *
 * The first version of this argued the exposure was bounded by construction: a
 * driver in an unreadable tree could not have written a lease either, because
 * `claimLease` reaches `resolveActor`, whose own `git rev-parse` would fail the
 * same way. That reasoning is WRONG, and its refutation is worth keeping
 * because it is easy to re-derive: it holds only if the failure predates the
 * lease. A drive writes a live lease, the repository then becomes unreadable —
 * an ownership change, a permissions change, a half-finished operation — and
 * the lease is still sitting there, still live, while this probe now says 128.
 *
 * So the allow case is established POSITIVELY instead, from the filesystem:
 * there is no repository here if no `.git` exists anywhere from the working
 * directory up to the root, and no `GIT_*` variable asserts one. `.git` is
 * probed with `lstat` rather than as a directory because a linked worktree's is
 * a FILE (a gitdir pointer) — the normal case in this repository, which is
 * driven from Conductor worktrees.
 *
 * `lstat` rather than `existsSync`, because `existsSync` answers a DIFFERENT
 * question than the one this fence has to ask. It reports `false` for confirmed
 * absence and for every indeterminate failure alike, and the indeterminate ones
 * below are each reachable here AFTER a live lease has been written (measured,
 * PR #4107 round 4 — `existsSync` reports `false` for every one of them):
 *
 *   - a `.git` that is a BROKEN SYMLINK — `existsSync` follows the link and
 *     reports false, though the marker entry plainly exists (`lstat` succeeds);
 *   - a `.git` under an ancestor that became UNSEARCHABLE — `EACCES` is
 *     indistinguishable from `ENOENT` through `existsSync`, so the walk runs to
 *     the root and concludes no repository exists.
 *
 * Either one turns `resolveFenceContext` into `null` — post permitted, lease
 * never read — which is the same fail-open as the exit-128 check this replaced,
 * one step further in (chatgpt-codex-connector P2 and docomply-review high, PR
 * #4107 round 4, independently). So only ENOENT/ENOTDIR — a POSITIVE answer
 * that this directory holds no marker — continues the walk; any other error
 * means the filesystem could not answer, and an unanswered question fails
 * CLOSED, per `.claude/rules/document-scanning-gates.md` § 1.
 *
 * An asserted-but-broken environment (`GIT_DIR` naming something unusable)
 * returns `true` here, so the caller demands a working git and refuses when it
 * does not get one. That is the right direction: a caller who named a git
 * directory has claimed a repository exists, and a fence in front of an
 * irreversible mutation must not overrule that claim by looking away.
 */
function repositoryIsInPlay(): boolean {
  for (const v of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) {
    if ((process.env[v] ?? "") !== "") return true;
  }
  let dir = resolve(process.cwd());
  for (;;) {
    try {
      lstatSync(join(dir, ".git"));
      return true;
    } catch (e) {
      // ENOENT: nothing of that name. ENOTDIR: a path component is not a
      // directory, so no marker can be here either. Both are POSITIVE absence
      // at this level — keep walking up. Anything else (EACCES, ELOOP, EIO,
      // ENAMETOOLONG, …) is the filesystem declining to answer, and a fence in
      // front of an irreversible POST treats "unknown" as "in play".
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    const parent = dirname(dir);
    // `dirname('/') === '/'` — the root is its own parent, and the only
    // termination condition that does not assume a path depth.
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The smallest staleness window that cannot expire a lease out from under a
 * command that is already ADMITTED.
 *
 * `claimLease` always leaves the lease fresh — the locked path writes
 * `lastSeen: now`, and the fast path returns only within `renewAfterMs` — so a
 * lease is at most `RENEW_AFTER_MAX_MS` old the moment its command is admitted.
 * That command then waits on the state mutex, for at most
 * `LOCK_ACQUIRE_MAX_SEC` (the clamp in `lock.ts`). So the oldest a lease can be
 * when a concurrent `reset` reaches `clearAllLeases`'s `leaseAlive` check is the
 * sum of those two, and a window below it lets `reset` sweep a lease whose
 * command has not run yet.
 *
 * That is not a cosmetic ordering: `clearAllLeases` preserves a live foreign
 * lease precisely so a second session in that tree cannot claim an absent one
 * and mutate beside the admitted command under a single actor. An
 * expired-by-the-clock lease defeats that preservation while the command it
 * belongs to is still in flight — so the window is floored here rather than
 * left to whoever sets the env var. Flooring is enough on its own; no admission
 * token is needed, because the quantity the token would fence against is
 * bounded and can simply be out-waited by construction.
 */
function leaseStaleFloorMs(): number {
  return LOCK_ACQUIRE_MAX_SEC * 1000 + RENEW_AFTER_MAX_MS;
}

function leaseStaleMs(): number {
  const raw = process.env.DRIVE_PR_LEASE_STALE_MIN ?? "";
  const n = isDigits(raw) ? Number.parseInt(raw, 10) : LEASE_STALE_MIN_DEFAULT;
  return Math.max(
    Math.min(Math.max(n, 1), 10_080) * 60_000,
    leaseStaleFloorMs(),
  );
}

/** The staleness window in minutes — named in every refusal that depends on it. */
export function leaseStaleMin(): number {
  return Math.round(leaseStaleMs() / 60_000);
}

/** The `pr-drive-lease-<pr>-<actor>.json` prefix every lease path is built on. */
const LEASE_PREFIX = "pr-drive-lease-";

/** The lease file for one (working tree, PR) pair. */
/**
 * The ONE spelling of a PR used in a lease filename, for readers and writers
 * alike.
 *
 * Canonicalizing only the reader left the producer free to persist a
 * noncanonical spelling: `resolvePr()` preserves whatever it was given and
 * `drive-state.ts` accepts it on `isDigits` alone, so an explicit `0999`
 * wrote `pr-drive-lease-0999-*` while a posting caller canonicalized its own
 * target to `999` and filtered on that prefix — missing the live lease
 * entirely and authorizing an irreversible reply (chatgpt-codex-connector,
 * a reference-implementation pull request round 16, as fresh evidence after the earlier reader-only
 * leading-zero fix). Normalizing at the shared boundary is what makes the two
 * sides agree by construction rather than by both remembering to.
 *
 * `BigInt`, matching `assertRemoteMutationAllowed`: `Number` is lossy past
 * `MAX_SAFE_INTEGER` and `Infinity` past `MAX_VALUE`, either of which would
 * reintroduce the same mismatch from the other end.
 *
 * A non-digit string passes through untouched. Every caller validates with
 * `isDigits` upstream, so this is unreachable in practice; passing it through
 * keeps this helper from being a second, silent place a malformed PR could
 * change meaning.
 */
export function canonicalLeasePr(pr: string): string {
  return isDigits(pr) ? BigInt(pr).toString() : pr;
}

export function leasePathFor(
  stateDir: string,
  pr: string,
  actor: string,
): string {
  return join(stateDir, `${LEASE_PREFIX}${canonicalLeasePr(pr)}-${actor}.json`);
}

/**
 * The `drive-tree-lease-<actor>.json` prefix the TREE lease's path is built
 * on — deliberately OUTSIDE the `pr-drive-lease-` namespace
 * `LEASE_PREFIX` owns, so neither `filterLeaseFilesFor` nor
 * `filterLeaseFilesForActor` — both of which gate on that exact prefix, for
 * an earlier change's PR-wide admission and an earlier change's external-mutation fence — can
 * ever mistake a tree lease for a per-PR one, now or after either filter is
 * later widened. Those two mechanisms are untouched by this module: they keep
 * reading exactly the per-PR lease files they always have.
 */
const TREE_LEASE_PREFIX = "drive-tree-lease-";

/** The lease file for one working tree, whichever PR it is currently driving. */
export function treeLeasePathFor(stateDir: string, actor: string): string {
  return join(stateDir, `${TREE_LEASE_PREFIX}${actor}.json`);
}

/**
 * The `drive-pr-remote-lock-<pr>` prefix `prRemoteMutationLock`'s path is
 * built on — deliberately outside BOTH `LEASE_PREFIX` and
 * `TREE_LEASE_PREFIX`'s namespaces, for the identical reason `TREE_LEASE_PREFIX`
 * itself gives: neither `filterLeaseFilesFor` nor `filterLeaseFilesForActor`
 * may ever mistake this lock's directory for a lease file, now or after
 * either filter is later widened. It carries no persisted content at all
 * (unlike every OTHER path in this module) — it exists purely as a mutex
 * anchor, never read as a lease or a tree lease.
 */
const PR_REMOTE_MUTATION_LOCK_PREFIX = "drive-pr-remote-lock-";

/**
 * Where `assertRemoteMutationAllowed`'s own PR-wide lock lives —
 * ONE file per PR, contended by EVERY worktree driving it, unlike
 * `leasePathFor`'s one file per (PR, actor). Exported so a probe can acquire
 * it directly, mirroring `treeLeasePathFor`'s own export for the identical
 * purpose.
 */
export function prRemoteMutationLockPathFor(
  stateDir: string,
  pr: string,
): string {
  return join(
    stateDir,
    `${PR_REMOTE_MUTATION_LOCK_PREFIX}${canonicalLeasePr(pr)}`,
  );
}

/**
 * A pid, or `null` when `raw` is not one.
 *
 * `isDigits` alone is not enough, and the gap is not cosmetic: it admits `0`
 * and it admits digit strings too long to survive `Number.parseInt` (400 nines
 * parse to `Infinity`). Either one is written into the lease file and then
 * bounces off `readLease`'s own shape check — `0` fails its `> 0` test, and
 * `Infinity` serialises as JSON `null` — so the session ends up holding NO
 * lease while believing it holds one, and the next session is free to mutate
 * alongside it. That is exactly the concurrency this module exists to refuse,
 * reached by a path that reports nothing. Both env vars go through here.
 */
function parsePid(raw: string): number | null {
  if (!isDigits(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve this invocation's session — see the ladder in the header.
 *
 * `label` names the script in the refusals below. The external-mutation
 * fence resolves the session from `reply-to-thread.ts`'s process too, and a
 * refusal that says `drive-state.ts` there sends the reader to a command they
 * never ran. Exported for that fence and for nothing else — the LEASE is still
 * taken only through `claimLease`.
 */
export function resolveSession(label = "drive-state.ts"): Session {
  const explicit = process.env.DRIVE_PR_SESSION ?? "";
  const explicitPid = parsePid(explicit);
  if (explicitPid !== null) {
    // Syntactically a pid is not yet a SESSION. A lease whose owner is already
    // dead is takeover-able by anyone the moment it is written (`leaseAlive`
    // fails on the pid half however young the lease), so admitting one hands
    // this command an exclusion that excludes nobody — while it believes it is
    // protected. Reached when `drive.ts` is killed and a detached pass outlives
    // it still carrying the dead driver's pid: a replacement driver takes the
    // lease over as abandoned, and both passes go on working
    // (chatgpt-codex-connector, a reference-implementation pull request).
    //
    // Refused rather than downgraded to tier 3, for the same reason a
    // non-numeric value is: the caller named this session deliberately, so a
    // silent fallback would give them a different identity than the one they
    // asked for. The host is always local here, so `pidAlive` is a real answer
    // rather than the foreign-host "assume alive".
    if (!pidAlive(explicitPid, hostname())) {
      fail(
        2,
        `${label}: $DRIVE_PR_SESSION names pid ${explicitPid}, which is not running.`,
        "A lease taken under a dead pid is abandoned the instant it is written —",
        "any other session may take it over — so admitting one would report an",
        "exclusion that does not exist.",
        "",
        "This usually means the driver that exported it has exited while this",
        "process outlived it. Stop this pass rather than letting it work beside",
        "its replacement; unset the variable only if you mean to run without a",
        "session identity at all.",
      );
    }
    return {
      pid: explicitPid,
      host: hostname(),
      source: "DRIVE_PR_SESSION",
      // Only this tier ever reads the token — see `Session.sessionStarted`'s
      // own doc for why the other two tiers must not.
      sessionStarted: process.env.DRIVE_PR_SESSION_STARTED ?? "",
    };
  }
  // A non-empty value that is not a pid is a caller mistake, not a reason to
  // fall through: it would silently downgrade to a DIFFERENT session identity
  // than the one they meant to set, which is the failure this whole module is
  // about. Refuse instead of guessing.
  if (explicit !== "") {
    fail(
      2,
      `${label}: $DRIVE_PR_SESSION must be a process id — a positive integer small enough to be exact (got '${explicit}').`,
      "It names the long-lived process whose liveness this session is judged by —",
      "drive.ts exports its own pid here. Unset it to fall back to the harness's",
      "agent process.",
    );
  }
  // An unusable `$CLAUDE_PID` falls THROUGH to tier 3 rather than failing: the
  // harness sets that one, so a caller has nothing to correct, and tier 3's
  // "no lease, status quo" is the documented answer for a runtime this ladder
  // cannot identify. `$DRIVE_PR_SESSION` above refuses because a caller who
  // set it deliberately meant a specific session.
  const agentPid = parsePid(process.env.CLAUDE_PID ?? "");
  // A DEAD agent pid is unusable in the same way a malformed one is — a lease
  // under it excludes nobody — so it takes the same route: through to tier 3,
  // where no lease is claimed and nothing is falsely reported as held. Not a
  // refusal, because the caller did not set this variable and has nothing to
  // correct; tier 3's "no lease, status quo" is the documented answer for a
  // runtime this ladder cannot identify, and an unidentifiable session and a
  // dead one are the same thing to every reader of the lease.
  if (agentPid !== null && pidAlive(agentPid, hostname())) {
    return {
      pid: agentPid,
      host: hostname(),
      source: "CLAUDE_PID",
      sessionStarted: "",
    };
  }
  return { pid: 0, host: hostname(), source: "none", sessionStarted: "" };
}

/**
 * Read the lease, or `null` when there is none — and also when what is there
 * cannot be read as one.
 *
 * A malformed lease is treated as ABSENT rather than fail-closed, which is the
 * opposite of `store.ts`'s ruling on a malformed STATE file, and deliberately:
 * that file is the only record of parked decisions and a durable round budget,
 * so discarding it loses something. A lease holds nothing but a claim about
 * right now, and a record that cannot name a holder cannot produce the
 * actionable refusal that is this mechanism's entire contract — it would refuse
 * every session forever while telling nobody whose process to check.
 */
export function readLease(path: string): Lease | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseLease(raw);
}

/**
 * The validating half of `readLease`, over TEXT a caller already holds.
 *
 * Split out because a caller that has already read the bytes must decide from
 * THOSE bytes, never by re-opening the pathname: `readLeaseForFence` used to
 * read the file into `raw` and then call `readLease(path)`, which opened and
 * parsed the same name a second time. A foreign live lease renamed away
 * between the two reads and replaced with one that looks owned-by-this-session
 * or dead is accepted by the second read, `isMine`/`leaseAlive` waves it
 * through, and no directory-identity check can see it — the directory never
 * changed, only the file inside it did (chatgpt-codex-connector, a reference-implementation pull request
 * round 15). One snapshot in, one decision out.
 */
/**
 * The field-by-field shape check `parseLease` and `parseTreeLease` both build
 * on — extracted so the tree lease's parser can require every field
 * a per-PR lease requires PLUS its own `pr`, without a second copy of these
 * checks and the review history attached to each one drifting out of sync
 * with the original.
 */
function parseLeaseShape(v: Record<string, unknown>): Lease | null {
  // Required, and the pid check below is CONDITIONED on it rather than
  // merely coexisting with it. The two fields encode one fact
  // between them, so a record where they disagree — a `session` holder with
  // no pid, a `worktree` holder carrying one — is not a lease this module
  // knows how to test for liveness, and admitting it would mean guessing
  // which half to believe. Rejected here, which routes it to
  // `unreadableLeaseFilesFor` and so BLOCKS admission by mtime rather than
  // being silently skipped.
  if (v.holder !== "session" && v.holder !== "worktree") return null;
  if (v.holder === "session") {
    if (typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0)
      return null;
  } else if (v.pid !== 0) {
    return null;
  }
  if (typeof v.host !== "string") return null;
  if (typeof v.platform !== "string") return null;
  if (typeof v.actor !== "string") return null;
  // Required like every other field, which means a lease written before this
  // field existed does not PARSE — the module's standing ruling that a
  // partial record is debris, and the pre-GA answer BWC deferral asks for.
  //
  // "Does not parse" is not "absent", and the distinction is the whole point
  // of the two readers below. `readLease` returning null still means absent
  // to every caller that wants a HOLDER to name. The PR-wide gate asks a
  // different question and gets a different answer:
  // `unreadableLeaseFilesFor` counts this file, so it BLOCKS admission
  // (exit 13) until its mtime ages past the staleness window.
  //
  // An earlier version of this comment argued the opposite — that failing
  // closed here would wedge the PR forever, because a corrupt file carries
  // no liveness — and then the gate was built to fail closed anyway, leaving
  // the two contradicting each other (chatgpt-codex-connector). The argument
  // was right about the hazard and wrong about it being unavoidable: mtime
  // is the liveness a corrupt file still has, so failing closed is bounded
  // by the same window everything else here uses, not permanent.
  //
  // The rollout cost is therefore real and worth naming: while one worktree
  // runs older code, its live lease blocks other trees rather than
  // being ignored, for up to one staleness window after it stops writing.
  // That is the safe direction — the alternative admits a second resolver on
  // the strength of a file nobody could read — and `lease --all` lists such
  // files explicitly so the refusal is diagnosable rather than mysterious.
  if (typeof v.worktree !== "string") return null;
  if (typeof v.startedAt !== "string") return null;
  if (typeof v.lastSeen !== "string") return null;
  if (!Number.isFinite(Date.parse(v.lastSeen))) return null;
  if (typeof v.command !== "string") return null;
  if (typeof v.generation !== "string" || v.generation === "") return null;
  // REQUIRED, exactly like every check above. An earlier revision accepted a
  // missing or non-string value and normalized it to '', to keep leases
  // written before the field existed parsing — which is an accepts-both-
  // shapes parser, i.e. precisely the deprecated-field tolerance the pre-GA
  // BWC stance rules out (`CLAUDE.md` § Backward Compatibility; and
  // chatgpt-codex-connector, a reference-implementation pull request round 15, which named it). It also
  // silently retained the weaker pid/host-only ownership decision for any
  // record that omitted the key.
  //
  // Nothing is lost by requiring it, because the VALUE '' remains legal and
  // is what a genuinely token-less session writes (an interactive
  // `$CLAUDE_PID` session, or a hand-set `$DRIVE_PR_SESSION` per SKILL.md
  // § 6). What is now rejected is the KEY being absent, which only a lease
  // written by superseded code can be — and lease state is ephemeral by
  // construction: it self-expires within a staleness window, and
  // `clear-lease` drops it immediately. That is the rollout, per the same
  // finding.
  if (typeof v.sessionStarted !== "string") return null;
  return v as unknown as Lease;
}

export function parseLease(raw: string): Lease | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== "object" || v === null) return null;
    return parseLeaseShape(v);
  } catch {
    return null;
  }
}

/**
 * `parseLease`'s counterpart for the TREE lease: every field
 * `parseLease` requires, via the shared `parseLeaseShape`, PLUS `pr` — a
 * digit string naming which PR this session is currently driving. Required
 * like every other field, for the identical reason `parseLeaseShape` treats a
 * partial record as debris rather than parsing it leniently — see its own
 * comment on `sessionStarted`; the same pre-GA BWC ruling applies to a field
 * this module adds, not only to one it already had.
 */
export function parseTreeLease(raw: string): TreeLease | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== "object" || v === null) return null;
    const base = parseLeaseShape(v);
    if (base === null) return null;
    if (typeof v.pr !== "string" || !isDigits(v.pr)) return null;
    // REQUIRED, exactly like every other field this module treats as debris
    // when absent (see `sessionStarted`'s own comment on why a partial record
    // does not parse rather than defaulting leniently) — a tree lease written
    // by pre-round-4 code has no per-write identity a rollback CAS can trust,
    // so it is debris here precisely as an unparseable file already is.
    if (typeof v.revision !== "string" || v.revision === "") return null;
    return { ...base, pr: v.pr, revision: v.revision };
  } catch {
    return null;
  }
}

/**
 * `readLease` for the tree lease — same absent-vs-unreadable
 * ruling as `readLease`, for the identical reason: a lease that cannot name a
 * holder cannot produce an actionable refusal.
 */
export function readTreeLease(path: string): TreeLease | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseTreeLease(raw);
}

/**
 * `readLease` for the external-mutation fence, which needs the one distinction
 * `readLease` deliberately erases: is this file ABSENT, or is it there and
 * unreadable?
 *
 * `readLease` collapses both to `null`, and says why — a record that cannot
 * name a holder cannot produce an actionable refusal, so for CLAIMING it is
 * better treated as absent than as a permanent refusal of every session. That
 * ruling is right for the path it was written for and wrong for this one: here
 * `leaseFilesForActor` has just enumerated the filename, so the file existed a
 * moment ago, and reading `null` as "no lease" lets a file-level `EACCES`,
 * malformed JSON, or a torn partial record permit the irreversible POST while a
 * live foreign driver holds that very lease (docomply-review, a reference-implementation pull request round 1,
 * high).
 *
 * The polarities differ for the same reason they differ over ladder tier 3:
 * claiming must not take an exclusion it cannot justify, while checking must
 * not hand out an all-clear it cannot justify. Different callers, different
 * directions to fail in — one shared reader would have to pick the wrong one
 * for somebody.
 *
 * `absent` stays an ALL-CLEAR rather than a refusal, because it is the
 * documented revoked-without-successor residual: a `clear-lease` or `reset`
 * between the enumeration and this read genuinely means nobody is driving.
 */
type FenceLeaseRead =
  | { kind: "lease"; lease: Lease }
  | { kind: "absent" }
  | { kind: "unreadable"; why: string };

function readLeaseForFence(path: string): FenceLeaseRead {
  // `lstat` first, not `readFileSync`'s own errno: a DANGLING SYMLINK at this
  // exact path — the directory entry `leaseFilesForActor` just enumerated
  // still exists — makes `readFileSync` report ENOENT for the missing
  // TARGET, indistinguishable from the errno for an entry that is not there
  // at all. `lstat` does not follow the link, so it is the one call that
  // tells "gone" apart from "here, but broken" (the same reasoning
  // `repositoryIsInPlay` applies to `.git`; docomply-review, a reference-implementation pull request round
  // 4, and chatgpt-codex-connector, round 6, on this exact function).
  try {
    lstatSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", why: code ?? String(e) };
  }
  // The entry positively exists, so nothing below may fall back to `absent` —
  // that residual is already ruled out by the `lstat` above. A dangling
  // symlink or a deletion racing this very read is an anomaly the fence
  // cannot vouch for, not the documented revoked-without-successor case.
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    return { kind: "unreadable", why: code === "" ? String(e) : code };
  }
  // `parseLease(raw)`, NOT `readLease(path)`: deciding from the bytes just
  // read rather than re-opening the name is what stops a file-only swap
  // between the two reads — see `parseLease`'s own doc.
  const lease = parseLease(raw);
  if (lease !== null) return { kind: "lease", lease };
  return {
    kind: "unreadable",
    why: `not a readable lease record (${raw.length} bytes)`,
  };
}

/**
 * A directory's on-disk identity — device + inode — captured once so a LATER
 * read against the same PATH can be told apart from a read against a
 * DIFFERENT directory that has since been swapped in at that path.
 *
 * Identity rather than the path string, because the path is exactly what a
 * rename-and-recreate leaves UNCHANGED: renaming the state directory away and
 * creating an EMPTY one at the same pathname raises no `ENOENT` anywhere a
 * later, per-file `lstatSync` could see — the enumerated name simply is not
 * there anymore, and `readLeaseForFence` reports `absent` for a lease that is
 * still live in the directory that moved (chatgpt-codex-connector, a reference-implementation pull request
 * round 13, and round 14 on the gap that fix itself left: freezing the NAME
 * LIST does not free the per-candidate CONTENT read from being a second,
 * genuine filesystem touch). Device+inode is what actually changes when the
 * directory is swapped, so it is what `assertStateDirIdentityUnchanged` below
 * re-confirms before trusting a read taken through it.
 */
/**
 * `bigint`, not `number`. Node's numeric `stat` fields round 64-bit device and
 * inode identifiers past `Number.MAX_SAFE_INTEGER`, and filesystems do expose
 * values above it — on such a filesystem a decimal round-trip either compares
 * two ROUNDED identities as equal (a swap the fence should have caught) or
 * fails the safe-integer check and refuses every child fence even though the
 * directory never changed (chatgpt-codex-connector, a reference-implementation pull request round 17).
 * `statSync(..., { bigint: true })` is exact, and BigInt survives the decimal
 * transport through the environment without loss.
 */
interface DirIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * `statSync`, NOT `lstatSync` — the opposite choice from `readLeaseForFence`
 * and `repositoryIsInPlay`, and for a reason that inverts with the question
 * being asked.
 *
 * Those two want to catch a DANGLING symlink as a positively-existing
 * anomaly, so they must stop at the link. This wants the identity of the
 * directory the fence will actually READ THROUGH, and `readdirSync` — plus
 * every per-candidate lease read — follows the final symlink. Stopping at the
 * link observes the link's own inode, which a target rename-and-recreate
 * leaves completely untouched: the baseline and the closing check would both
 * match while the enumeration ran against the replacement, and the fence
 * would authorize the POST with the live lease still in the moved target
 * (chatgpt-codex-connector, a reference-implementation pull request round 16 — this helper had reintroduced
 * the `lstat` that an earlier round of this same PR removed for exactly this
 * reason).
 *
 * A dangling link now yields `null` here rather than a link-inode identity,
 * which every caller already treats as "identity could not be established"
 * and fails closed on — the same answer `readdirSync` gives that path anyway.
 */
function statDirIdentity(dir: string): DirIdentity | null {
  try {
    const st = statSync(dir, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function sameDirIdentity(a: DirIdentity, b: DirIdentity | null): boolean {
  return b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * The both-sides-nullable comparator, for bracketing an enumeration whose
 * directory may legitimately not exist at all.
 *
 * Both absent agree: on the non-override path a state directory that has
 * never existed is the ordinary un-driven-tree case, and its enumeration
 * correctly yielded nothing. Every other combination disagrees — including
 * absent-then-present, which is not merely odd: the enumeration read an empty
 * set from a directory that was not the one now standing at this path, so the
 * emptiness it reported vouches for nothing.
 */
function sameDirIdentity2(
  a: DirIdentity | null,
  b: DirIdentity | null,
): boolean {
  if (a === null) return b === null;
  return sameDirIdentity(a, b);
}

/**
 * A `DirIdentity` rendered for transport through the environment, or `''`
 * when the directory could not be stat'd. `drive.ts` exports this as
 * `$DRIVE_PR_STATE_DIR_IDENTITY` beside `$DRIVE_PR_STATE_DIR`; the fence
 * parses it back with `parseDirIdentityToken`.
 *
 * Exported so the driver and the fence share ONE rendering — a second
 * hand-rolled `${dev}:${ino}` on the producing side is a format the consumer
 * can silently stop agreeing with.
 */
export function stateDirIdentityToken(dir: string): string {
  const id = statDirIdentity(dir);
  return id === null ? "" : `${id.dev}:${id.ino}`;
}

/**
 * The inverse, and deliberately strict about SHAPE while lenient about
 * ABSENCE: `''`/unset means "no baseline was inherited", which is the
 * ordinary case for an interactive session and for any older driver,
 * and must not refuse. A value that is PRESENT but unparseable is a different
 * thing entirely — something set this variable and this process cannot tell
 * what it meant — so it returns `null` and the caller fails closed, per
 * `.claude/rules/document-scanning-gates.md` § 1.
 */
export function parseDirIdentityToken(
  token: string,
): { kind: "absent" } | { kind: "ok"; id: DirIdentity } | { kind: "bad" } {
  if (token === "") return { kind: "absent" };
  const m = /^(\d+):(\d+)$/.exec(token);
  if (m === null) return { kind: "bad" };
  // `BigInt`, with no safe-integer ceiling: a 64-bit device or inode above
  // `Number.MAX_SAFE_INTEGER` is a legitimate value on some filesystems, and
  // rejecting it here would refuse every child fence on such a machine even
  // though the directory never changed (chatgpt-codex-connector, a reference-implementation pull request
  // round 17). The regex has already established both groups are digits, so
  // this cannot throw.
  return {
    kind: "ok",
    id: { dev: BigInt(m[1] as string), ino: BigInt(m[2] as string) },
  };
}

/**
 * Re-confirm the state directory is still the one an earlier enumeration
 * read, or fail closed — the primitive that closes the class of races PR
 * #4107 spent three rounds narrowing (statSync-then-later-read ordering,
 * then an `ENOENT`-only indeterminate flag on the later read, both defeated
 * by a rename-and-recreate that raises no `ENOENT` anywhere) instead of
 * patching the next specific window a reviewer finds.
 *
 * `expected === null` means the enumeration this identity would defend found
 * no directory at all — the ordinary un-driven-tree case for the non-override
 * path (see `assertRemoteMutationAllowed`'s own comment on why that differs
 * from the override path), not a baseline to defend — so this is a no-op.
 *
 * Exit 1, matching `readLeaseForFence`'s "unreadable" refusal: this is the
 * same epistemic status. A directory-identity mismatch does not prove a live
 * foreign lease exists (that would be exit 11/13), only that the question
 * "was the `absent` read just taken actually true?" went unanswered — and an
 * outcome reply has no undo, so an unanswered question in front of it must
 * refuse rather than assume (`.claude/rules/document-scanning-gates.md` § 1).
 */
function assertStateDirIdentityUnchanged(
  label: string,
  stateDir: string,
  expected: DirIdentity | null,
  when: string,
): void {
  if (expected === null) return;
  const now = statDirIdentity(stateDir);
  if (sameDirIdentity(expected, now)) return;
  fail(
    1,
    `${label}: the drive state directory was replaced ${when}:`,
    `  ${stateDir}`,
    "",
    now === null
      ? "It no longer exists at all."
      : "It now has a different on-disk identity than the one this check enumerated.",
    "",
    "Refusing to post. A directory swap here is exactly how a lease file this",
    "check enumerated can read back as `absent` while it is still live in the",
    "directory that moved — the file never raises ENOENT, only this path does",
    "(PR #4107). An outcome reply has no undo, so this refuses rather than trust",
    'a read that cannot tell "nobody is driving" from "the directory moved".',
  );
}

/**
 * Is the lease's owner still driving? Both halves must hold: the pid answers
 * (`proc.ts`'s shared liveness test, which counts a foreign host as alive and
 * leaves the window below to bound it), AND the session has renewed within the
 * window. Either one alone is the recycled-pid hazard
 * `LEASE_STALE_MIN_DEFAULT` describes, from opposite sides.
 *
 * A `worktree` holder has only the second half, because it has no pid — see
 * `Lease.holder`. That is a genuinely weaker test and it is the one this
 * module can actually run: inventing a pid for a runtime that supplied none is
 * what tier 3 refuses to do. It is not, however, a WEAKER PROMISE than the
 * `pidAlive` half already makes in the case it cannot answer: a lease whose pid
 * lives on another host is counted alive unconditionally, so freshness is the
 * sole clear there too, and both are bounded by the same window.
 */
function leaseAlive(l: Lease): boolean {
  if (l.holder === "session" && !pidAlive(l.pid, l.host)) return false;
  return Date.now() - Date.parse(l.lastSeen) <= leaseStaleMs();
}

/**
 * Every LIVE lease on this PR, from every working tree — the read the PR-wide
 * admission gate decides on, and the one `drive-state.ts lease --all` reports.
 *
 * "Live" is `leaseAlive`, the same test `reset` already uses to decide which
 * lease it may not sweep, and using it rather than mere presence is the whole
 * self-clearing property: a hold's durable `actor` proves only that some tree
 * made a promise once (holds deliberately outlive their driver, so another
 * driver can finish them — `drive-pr/SKILL.md` § 6), whereas a live lease is
 * the only artefact that means someone is driving RIGHT NOW. Detection built on
 * the actor instead would wedge a legitimate successor forever, which is worse
 * than the race it was meant to prevent.
 *
 * A lease file that cannot be READ as one is skipped, matching `readLease`'s
 * own ruling and for the same reason: a record that cannot name a holder cannot
 * produce the actionable refusal that is this mechanism's entire contract.
 * Enumeration FAILING is different and is not skipped — `leaseFilesFor` throws
 * on anything but a missing directory, so "read nothing" can never be mistaken
 * for "nobody is driving".
 */
export function liveLeasesFor(stateDir: string, pr: string): Lease[] {
  const out: Lease[] = [];
  for (const f of leaseFilesFor(stateDir, pr)) {
    const l = readLease(f);
    if (l !== null && leaseAlive(l)) out.push(l);
  }
  return out;
}

/**
 * Lease files for this PR that EXIST but cannot be read as a lease — the
 * population a gate must not silently drop.
 *
 * `readLease` answers `null` for both "absent" and "unreadable", which is the
 * right ruling where it was written (a record that cannot name a holder cannot
 * produce an actionable refusal) and the wrong one for an ADMISSION decision:
 * there, an unreadable file is evidence that some tree wrote something, and
 * skipping it widens admission on exactly the input the gate understands least
 * (docomply-review, medium). `.claude/rules/document-scanning-gates.md` § 1
 * states the general form — a scanning gate that cannot read its input has
 * verified nothing, and must never report an empty population.
 *
 * Bounded by MTIME so failing closed cannot wedge the PR forever. An unreadable
 * file has no `lastSeen` to age out and no pid to test, so liveness cannot
 * speak for it; its mtime can. Within the staleness window it blocks, past it
 * it is debris — the same window, and the same self-clearing promise, the
 * readable path gets. A file being rewritten right now is covered without
 * either property: `atomicWrite` renames, so a reader sees the old lease or the
 * new one, never a partial.
 */
export function unreadableLeaseFilesFor(
  stateDir: string,
  pr: string,
): string[] {
  const out: string[] = [];
  for (const f of leaseFilesFor(stateDir, pr)) {
    if (readLease(f) !== null) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(f).mtimeMs;
    } catch {
      // Vanished between the enumeration and the stat, or is unstattable. A
      // file that is no longer there cannot be a live holder, and one that
      // cannot be stat'ed at all is not something a refusal could tell a human
      // how to check.
      continue;
    }
    if (Date.now() - mtimeMs <= leaseStaleMs()) out.push(f);
  }
  return out;
}

/**
 * `liveLeasesFor`'s single-file counterpart for the TREE lease — is a
 * genuinely live session still behind this actor's tree lease right now?
 *
 * `git worktree list` is not an exact existence predicate for the directory a
 * tree lease names: its registration can be pruned or lost by a git operation
 * elsewhere while the checkout, and a process still holding the lease, remain
 * (docomply-review, reap-state.ts PR #4197). This is the veto that lets a
 * retirement decision keyed on that list still fail closed against a lease a
 * live process is actively renewing, the same way `liveLeasesFor` does for
 * the per-PR case.
 */
export function liveTreeLeaseFor(stateDir: string, actor: string): boolean {
  const l = readTreeLease(treeLeasePathFor(stateDir, actor));
  return l !== null && leaseAlive(l);
}

/**
 * `unreadableLeaseFilesFor`'s counterpart for the retirement predicate, keyed
 * by (stateDir, actor) like `liveTreeLeaseFor` rather than by a bare path —
 * is this actor's tree lease present but unreadable, and young enough that a
 * genuinely live session could still be behind it?
 *
 * Without this, `liveTreeLeaseFor` alone treats "unreadable" the same as "no
 * lease at all" (both read `null` off `readTreeLease`), so a temporarily
 * malformed or partially-written lease from a genuinely live process would
 * fall straight through to the mtime age gate instead of failing closed the
 * way the per-PR predicate already does with `unreadableLeaseFilesFor`
 * (docomply-review, a reference-implementation pull request round 2).
 */
export function treeLeaseUnreadableAndFreshFor(
  stateDir: string,
  actor: string,
): boolean {
  return treeLeaseUnreadableAndFresh(treeLeasePathFor(stateDir, actor));
}

/**
 * `unreadableLeaseFilesFor`'s single-file counterpart for the TREE lease
 * — is THIS ONE PATH present but unreadable as a lease, and young
 * enough that a genuinely live session could still be behind it? Used by
 * `claimTreeLease` to fail closed on the SAME population `unreadableLeaseFilesFor`
 * protects for the PR-wide gate, rather than reading `readTreeLease`'s `null`
 * (absent-or-unreadable, collapsed on purpose for callers that want a HOLDER
 * to name) as license to mint a new generation over it.
 */
function treeLeaseUnreadableAndFresh(path: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Vanished or unstattable — nothing here to fail closed on; the caller's
    // own `readTreeLease` will correctly read this as absent.
    return false;
  }
  if (readTreeLease(path) !== null) return false;
  return Date.now() - mtimeMs <= leaseStaleMs();
}

/**
 * How fresh THIS tree's lease must be for a claim to skip the PR-wide check
 * below — half the staleness window.
 *
 * The check costs a directory read, so it is skipped on the renewal paths, and
 * that skip has to be an argument rather than an optimisation. It is this: a
 * foreign tree may only be admitted after observing our lease as NOT alive, and
 * every admission does that observation while holding the state mutex, having
 * read the same file. So while our `lastSeen` is inside this margin, no foreign
 * admission can have happened — its own `leaseAlive` read of our file is
 * unambiguously true, by a margin of hours rather than by a boundary two
 * processes could straddle. Past the margin the claim takes the state mutex and
 * re-checks, which is the same treatment a takeover gets.
 */
function leaseFreshMarginMs(): number {
  return Math.floor(leaseStaleMs() / 2);
}

/**
 * The "is that session still alive?" line every lease refusal ends with.
 *
 * One function so the two refusal sites — `claimLease`'s exit 11 and `reset`'s
 * preserved-lease report — cannot drift, and so the unknown-platform case is
 * answered the same way in both. A lease written before `platform` existed, or
 * by a runtime that reported none, gets words rather than a fabricated command:
 * a check the reader cannot run is what this line exists not to produce.
 */
export function leaseLivenessHint(l: Lease): string {
  // A tree-held record names no process, so there is nothing to check and the
  // reader must be told that rather than handed a command about pid 0 (which
  // on POSIX addresses the caller's own process group — the single most
  // misleading answer this line could give). What it gets instead is the only
  // thing that IS true of such a record: it clears on the clock, or by hand.
  if (l.holder === "worktree") {
    return `That record names no session — it was written by a runtime that identified none (ladder tier 3), so there is no process to check. It clears on its own once ${leaseStaleMin()}m pass without a mutating command from ${l.worktree || l.actor}.`;
  }
  const cmd = pidCheckCommand(l.pid, l.host, l.platform);
  const remote = l.host !== "" && l.host !== hostname();
  if (cmd === null) {
    return `Check whether that session is still alive — pid ${l.pid} ON ${l.host}, whose platform this lease does not record, so run that host's own process check.`;
  }
  return remote
    ? `Check whether that session is still alive — ON ${l.host}, where its pid lives:  ${cmd}`
    : `Check whether that session is still alive:  ${cmd}`;
}

/**
 * How a refusal NAMES the thing holding a lease — one function so no message
 * can hand the reader a pid a `worktree` holder does not have.
 *
 * "session pid 0 on this host" is not merely unhelpful, it is wrong twice over:
 * there is no such session, and pid 0 addresses the caller's own process group
 * on POSIX, so a reader who acts on it acts on themselves.
 */
export function leaseHolderLabel(l: Lease): string {
  return l.holder === "worktree"
    ? "a sessionless resolver (ladder tier 3 — no session identity to name)"
    : `session pid ${l.pid} on ${l.host || "this host"}`;
}

function ageLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

/**
 * The lease file's OWN mutex, so that reading a lease and installing one is a
 * transaction: two sessions starting at the same instant must not both observe
 * "no lease" and both install one.
 *
 * A lock of its own, NOT the state store's. The store's mutex is the one every
 * command's real work contends for, and this claim runs BEFORE that work — so
 * borrowing it would have inserted a lock acquisition ahead of `claim-held`'s
 * deliberately unlocked, `O_CREAT|O_EXCL` claim-file creation, which that
 * protocol requires to be its first act (`drive-state.ts`'s `claimFinding`
 * explains why). It is a separate path, so nothing that guards drive state can
 * be delayed or reordered by this; and since a lease hold never reaches for the
 * state lock, the two can never deadlock against each other.
 */
function leaseLock(path: string, pr: string) {
  return createLock(path, "drive-state.ts (lease)", pr);
}

/**
 * The tree lease's OWN mutex — same role as `leaseLock`, but keyed
 * by ONE file per tree rather than one per (tree, PR). That is the whole
 * reason it closes the race a per-PR mutex cannot: two sessions claiming
 * leases for two DIFFERENT PRs from one tree take two different `leaseLock`s
 * and never meet, but they take the SAME `treeLeaseLock`, so the second one
 * to arrive here observes the first one's write.
 */
function treeLeaseLock(path: string) {
  return createLock(path, "drive-state.ts (tree lease)", "tree");
}

/**
 * `assertRemoteMutationAllowed`'s OWN lock — same shape as
 * `treeLeaseLock`, but keyed the OTHER way: by PR alone rather than by actor
 * alone. `treeLeaseLock` admits at most one live session per WORKING TREE;
 * this one admits at most one live IRREVERSIBLE REMOTE MUTATION (a
 * `guarded-push.ts` push, an `answer-summary-finding.ts` POST) per PR,
 * whichever worktree is making it — the axis `assertRemoteMutationAllowed`'s
 * old point-in-time-only check left open (see its own doc comment).
 *
 * ── Lock ordering ────────────────────────────────────────────────────────
 *
 * `prRemoteMutationLock(pr)` is acquired FIRST, before every other lock a
 * caller might also hold — never the reverse, anywhere. The full order each
 * caller follows:
 *
 *   `claimPrLease` (via `withLeaseLock`):
 *     `prRemoteMutationLock(pr)` → per-PR state mutex → `leaseLock(path)`
 *   `guarded-push.ts` / `answer-summary-finding.ts`:
 *     `prRemoteMutationLock(pr)` → `treeLeaseLock(actor)`
 *
 * `claimPrLease` HOLDS `prRemoteMutationLock` through its entire critical
 * section — including the state mutex, `leaseLock`, and the admission
 * write — not merely a brief acquire-then-release gate (that was this
 * fix's own first cut; nesting the lock INSIDE the state mutex meant a new
 * claimant waiting out an in-flight push held the state mutex for the
 * whole wait, blocking every other mutation on the PR — docomply-review,
 * a reference-implementation pull request round 5). Acquiring it first, outside the state mutex, is what
 * keeps that wait from blocking anything else.
 *
 * Nothing anywhere takes `prRemoteMutationLock` after `treeLeaseLock`:
 * `claimPrLease`'s own touch of it happens AFTER `claimTreeLease` has
 * already released `treeLeaseLock` for that call — the two are never held
 * simultaneously by one caller in that direction either. A single,
 * consistent order across every caller that holds more than one of this
 * module's locks at once is what rules out a cycle; see `lock.ts`'s own
 * header for why a mkdir-based mutex has no cheaper way to detect one.
 */
function prRemoteMutationLock(stateDir: string, pr: string) {
  return createLock(
    prRemoteMutationLockPathFor(stateDir, pr),
    "drive-state.ts (pr remote mutation)",
    pr,
  );
}

/**
 * Is `l` the lease `s` itself holds? (pid, host) alone answers this only when
 * neither side can prove more — a pid is RECYCLABLE, so once `s` carries its
 * own acquisition token the on-disk lease must carry the SAME one, mirroring
 * `drives.ts`'s `ownParentDriver` exactly (see `Lease.sessionStarted` for the
 * hazard this closes and PR #4107 finding B for the reproduction):
 *
 *   - `s` carries a token → `l` must carry the SAME token. A pid+host match
 *     alone is no longer sufficient once a token is available to check,
 *     because a recycled pid can genuinely belong to a different session now.
 *   - `s` carries no token → fall back to bare pid+host, but ONLY when `l`
 *     carries none either. This is the older-shaped harness that
 *     exports neither (SKILL.md § 6) — demanding a token there would falsely
 *     refuse a session against its own lease, the exact "stand-down" bug
 *     `ownParentDriver`'s own comment warns about. A lease that DOES carry a
 *     token can never be this tokenless caller's own write (only a
 *     token-bearing session ever writes one), so it is proof of a different
 *     process and must not fall back to trusting pid+host over that evidence.
 *
 * KNOWN RESIDUAL, stated here rather than left as an implication of the two
 * bullets above (chatgpt-codex-connector, a reference-implementation pull request round 17). For the SECOND
 * bullet — both sides tokenless — pid+host IS the ownership test, and a pid is
 * recyclable: if a tokenless session dies and the OS hands its pid to a new
 * tokenless session on the same host, that successor's live lease satisfies
 * this branch and is read as the caller's own, skipping the `leaseAlive`
 * refusal. So "pid and host alone are not ownership" is true of a
 * token-BEARING session and false here; that asymmetry is the price of the
 * fallback, not an oversight.
 *
 * Neither alternative is available today. Refusing tokenless callers outright
 * would refuse a Claude Code session against the lease IT JUST WROTE — tier 2
 * (`$CLAUDE_PID`) never populates `sessionStarted`, so the by-hand drive flow
 * documented in SKILL.md § 6 would break on its second mutation. Minting a
 * non-recyclable token for a tokenless session needs that session's process
 * START TIME, and there is no `node:`-only way to read it for another pid —
 * `pidAlive` uses `process.kill(pid, 0)` precisely to stay portable to
 * Windows, where `ps` is not present. Revisit if either changes: a harness
 * that exports `$DRIVE_PR_SESSION_STARTED` for interactive sessions, or a
 * portable process-identity API, closes this immediately by making every
 * session token-bearing and letting the fallback be deleted.
 */
function isMine(l: Lease, s: Session, actor: string): boolean {
  // A tree-held record is owned by the TREE, so `actor` decides and
  // the session fields are not consulted at all. Both directions of that matter
  // and neither is symmetric with the session case:
  //
  //   - a SESSIONLESS caller owns its own tree's record — which is what keeps
  //     tier 3 from refusing a sibling invocation of its own agent, since every
  //     one of them resolves this same actor. Without the `actor` argument this
  //     branch would fall through to (pid, host) and match ANY tree's record,
  //     since a tier-3 session and a tree-held record both carry pid 0: the
  //     external-mutation fence would then read a foreign tree's live record as
  //     its own and post straight past it.
  //   - an IDENTIFIED caller owns its own tree's record too, which is how a
  //     session upgrades a presence record it finds in its own tree into a real
  //     lease instead of refusing itself over it. Cross-tree it is never
  //     "mine", which is the exclusion this whole record exists to produce.
  if (l.holder === "worktree") return l.actor === actor;
  // Not `actor`-qualified, deliberately: one session legitimately drives from
  // two trees, and demanding actor equality here would make its own second
  // tree's lease read as foreign and refuse a post it is entitled to make.
  if (l.pid !== s.pid || l.host !== s.host) return false;
  if (s.sessionStarted !== "") return l.sessionStarted === s.sessionStarted;
  return l.sessionStarted === "";
}

/**
 * Is `l` PROVABLY a dead predecessor's lease that the OS has since handed
 * `s`'s exact pid — the case `isMine` closes for but `leaseAlive`
 * cannot, because `leaseAlive`'s pid half is `pidAlive(l.pid, l.host)`, and
 * once `l.pid === s.pid` that call answers about `s` ITSELF. It is trivially
 * "alive" not because the recorded owner survives but because the CALLER is
 * that pid — the exact tautology this predicate exists to strip out before
 * `claimLease` decides renewal vs. takeover from it.
 *
 * `!isMine(l, s)` is required, not incidental: the only way `l.pid === s.pid
 * && l.host === s.host` can coexist with "not mine" is one of `isMine`'s two
 * token-checked branches — a token MISMATCH, or a token on `l` that a
 * tokenless `s` cannot have written — and both are the same proof `isMine`
 * already established: a DIFFERENT session wrote `l`, so the shared pid can
 * only be the OS recycling it. (The one case this does NOT fire for is
 * `isMine`'s own KNOWN RESIDUAL — both sides tokenless — where recycling is
 * indistinguishable from a renewal and `isMine` itself returns `true`; this
 * predicate is never reached for it, which is correct: there is no token
 * evidence here to strip a false liveness reading from.)
 *
 * THE CRITERION (PR #4128 round 5, final — chatgpt-codex-connector +
 * docomply-review, threads PRRT_kwDOO7knac6apDDF / apaEL / apaEN / apalY /
 * apwqU, all four prior rounds' findings resolving to one root cause): this
 * predicate must PROVE `l`'s writer is dead. The only available proof is
 * TEMPORAL — the OS hands a pid onward only to a session that starts AFTER
 * the pid's previous holder dies — and using a temporal proof requires BOTH
 * pid claims to be TIMESTAMPED. `sessionStarted` timestamps a pid claim only
 * because `drive.ts` mints `$DRIVE_PR_SESSION` and `$DRIVE_PR_SESSION_STARTED`
 * together (`(pid, sessionStarted)` is a coherent, jointly-minted pair); `''`
 * is an UNTIMESTAMPED pid claim, and an untimestamped claim cannot be ordered
 * against anything. So no proof exists whenever EITHER side is empty, and
 * `isRecycledPid` returns `true` in EXACTLY ONE shape: both sides non-empty,
 * both strictly ISO-valid, `l` strictly earlier.
 *
 * The proof for that one surviving case, spelled out because it is what makes
 * a round-6 finding on this exact mechanism answerable by citation rather
 * than another investigation: suppose the ordering passes (`T_l < T_s`) and
 * yet `l`'s writer W is alive holding pid P. Tokens differ (`!isMine`), so
 * `s`'s claim was minted by some session M ≠ W that held P. Two processes
 * cannot hold P at once, so M released P before W acquired it, so M died
 * before W started, so `T_s` (M's start) < `T_l` (W's start) — contradicting
 * `T_l < T_s`. Hence ordering-passes ⇒ W is not a live holder of P.
 *
 * A driver's own pid is inherited UNCHANGED by every pass it spawns
 * (`Session`'s own doc), so a pass detached from a driver that was killed
 * mid-round keeps identifying with that driver's pid and token long after the
 * driver is gone — and if that exact pid is recycled to a brand-new driver
 * before the detached pass exits, BOTH now satisfy `l.pid === s.pid &&
 * l.host === s.host && !isMine` against each other's lease. The ordering is
 * what keeps this from firing in both directions at once: the new driver
 * reads the stale pass's lease as its own recycled pid (correctly — proved
 * above), but the stale pass, reading the new driver's fresher lease, fails
 * the SAME ordering test against ITS OWN (older) token and falls through to
 * an ordinary `leaseAlive`-based refusal against the newer, live session
 * instead of alternating takeovers with it.
 *
 * Several rounds of this PR tried narrower carve-outs for a tokenless side —
 * "a tokenless caller can never have WRITTEN a token-bearing lease, so a
 * pid+host match with a token on one side alone proves a dead predecessor" —
 * and each one was defeated by the SAME counterexample restated: `Session.pid`
 * is an inherited CLAIM, not proof of the caller's own actual OS pid, so a
 * caller with no token could itself be a stale detached claimant rather than
 * the genuine current holder — `l.pid === s.pid` proves both sides claim the
 * same pid VALUE, never that either one is the pid's true, currently-live
 * occupant. `Session.source` (`'DRIVE_PR_SESSION'` vs `'CLAUDE_PID'`) carries
 * no evidentiary value here either — `$CLAUDE_PID` is inherited by every
 * process the agent spawns exactly as `$DRIVE_PR_SESSION` is, and
 * `resolveSession`'s `pidAlive` check only confirms SOMEONE holds that pid,
 * never that the caller does. There is no tier, source, or presence-alone
 * signal that substitutes for a timestamp; only a timestamp does.
 *
 * Every non-empty token is parsed as a strict ISO instant — `Date.parse`
 * alone is too lenient (it also accepts non-ISO formats `toISOString` never
 * produces), so a token is trusted only when it ROUND-TRIPS: re-serializing
 * the parsed instant reproduces the exact string. Either side failing that
 * fails the whole predicate CLOSED (`false`), not open: `resolveSession`
 * (this file) accepts `$DRIVE_PR_SESSION_STARTED` from the environment with
 * no format check, so a malformed or non-ISO value — a broken or
 * intentionally hostile harness — must not be trusted to prove an ordering
 * that authorizes a takeover; the safe failure is the ordinary
 * `leaseAlive`-based refusal, never "assume it's older". The comparison is
 * strictly `<`, not `<=`: two sessions minting the identical millisecond is
 * not an ordering proof either, and `Lease.generation`'s own doc already
 * rules out deriving identity from a clock that can tie.
 *
 * Every call site already ORs `isRecycledPid` with `!leaseAlive`, so `false`
 * here is never a dead end — it is a deliberate downgrade from an INSTANT
 * proof to the ordinary `leaseAlive` staleness wait (`leaseStaleMs`, default
 * 360min). That trade is asymmetric on purpose and matches this module's own
 * stated polarity (fail toward refusal or preservation, never toward an
 * unwithdrawable mutation): every wrong-direction outcome of a missing
 * timestamp is a FALSE REFUSAL — a per-tree claim or `assertNoForeignDrive`
 * admission waiting out the staleness window against a demonstrably dead
 * lease, or `reset` preserving a dead lease as live a beat longer than
 * necessary — each recoverable in one command (`drive-state.ts clear-lease`,
 * named in the refusal itself). The alternative, a FALSE TAKEOVER admitted on
 * an unproven "probably dead" guess, produces the harm this whole
 * module exists to prevent: an unwithdrawable duplicate `**accepted**` reply
 * once two sessions both believe themselves sole driver.
 *
 * RESIDUALS, stated explicitly rather than left implicit — an earlier change's own
 * acceptance criteria ask for exactly this:
 *
 *   - R1 (KNOWN, pre-existing): two WELL-FORMED tokens whose relative order a
 *     backward system-clock step (e.g. an NTP correction) reverses are
 *     indistinguishable from a genuine reversal. There is no portable,
 *     `node:`-only, cross-process MONOTONIC session order to compare instead
 *     (the same missing primitive `isMine`'s own KNOWN RESIDUAL cites), and
 *     `leaseAlive`'s staleness window already trusts the identical wall clock
 *     for `lastSeen`/`startedAt`, so replacing only this comparison would
 *     harden one decision while leaving a clock-rollback-sized hole open in
 *     every sibling one. Revisit both together if a portable monotonic
 *     primitive becomes available.
 *   - R2 (KNOWN, pre-existing, now the CENTRAL one once R4 below closes):
 *     a harness that exports a `(pid, sessionStarted)` pair it did not mint
 *     TOGETHER — claiming a pid it does not actually own, paired with a
 *     newer-than-reality token — is OUTSIDE this predicate's threat model,
 *     the same class as a caller exporting an arbitrary live foreign pid,
 *     which `resolveSession`'s tier-1 contract explicitly delegates to the
 *     caller's own honesty. No revision of this predicate has ever defended
 *     against a caller lying about its own identity; it defends against
 *     confusing an inherited claim for a fresh one, which is different.
 *   - R3 (KNOWN, pre-existing): both sides tokenless — `isMine` itself
 *     returns `true` for this case, so `isRecycledPid` is never reached; see
 *     `isMine`'s own KNOWN RESIDUAL for why recycling is indistinguishable
 *     from a renewal there and why that is accepted.
 *   - R4 (this round, closes an earlier change's own open question): EITHER side
 *     tokenless gets NO fast path at all and relies entirely on the
 *     `leaseAlive` staleness window — this is the "Tier 2's residual… whether
 *     a shorter default staleness window is the right partial mitigation"
 *     question an earlier change's issue asked to have answered explicitly. It is not:
 *     `LEASE_STALE_MIN_DEFAULT`'s own reasoning is that renewal is
 *     work-driven with no natural floor to tighten against, and the cost
 *     asymmetry above (one named recovery command vs. an unrepairable
 *     duplicate reply) favors leaving the window as-is rather than trading
 *     recovery speed for a shorter fuse on the one case a wrong guess is
 *     irreversible.
 */
function isRecycledPid(l: Lease, s: Session, actor: string): boolean {
  // `l.holder === 'worktree'` (a tier-3 presence record) carries
  // `pid: 0` and no session token — it can never satisfy the pid-match guard
  // below against a real session's nonzero pid, and against another tree-held
  // record `isMine`'s own `actor` check already decides identity without any
  // temporal claim to strip out. `actor` is threaded through purely to keep
  // this call's `isMine(l, s, actor)` signature-compatible; it plays no role
  // in the temporal proof below.
  if (l.pid !== s.pid || l.host !== s.host || isMine(l, s, actor)) {
    return false;
  }
  if (l.sessionStarted === "" || s.sessionStarted === "") return false;
  const lMs = parseStrictIsoInstantMs(l.sessionStarted);
  const sMs = parseStrictIsoInstantMs(s.sessionStarted);
  if (lMs === null || sMs === null) return false;
  return lMs < sMs;
}

/**
 * Parse `s` as an ISO instant, trusting it only when it ROUND-TRIPS —
 * `new Date(s).toISOString()` reproduces `s` exactly. Plain `Date.parse`
 * accepts many non-ISO formats (`toISOString` never emits them), which would
 * let a malformed `$DRIVE_PR_SESSION_STARTED` parse to SOME instant rather
 * than being recognized as untrustworthy. Returns `null` — not `NaN`, not
 * `0` — for anything that does not round-trip, so `isRecycledPid` can fail
 * closed on it rather than silently ordering against an unintended epoch.
 */
function parseStrictIsoInstantMs(s: string): number | null {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString() === s ? ms : null;
}

/**
 * The exit code every PER-TREE lease refusal in this module uses: another live
 * SESSION in THIS working tree holds the drive lease for this PR.
 *
 * Distinct from `DRIVE_HELD_ELSEWHERE_EXIT` below, because the two are
 * different situations with different remedies and a caller must be able to
 * tell them apart without parsing prose. `11` says "another session in YOUR
 * tree" and points at `clear-lease`, which the reader can run where they
 * stand. `13` says "another tree entirely" — the reader is very likely not
 * the person who should clear it, and the correct response is almost always
 * to stop rather than to take over. `drive-status.ts` reports them as
 * `SESSION_LEASE_HELD` and `DRIVE_HELD_BY_OTHER_WORKTREE` for the same
 * reason.
 *
 * Derived from `TERMINAL_STATES` via `outOfBandExitCode` rather
 * than an independent literal — the same binding `DRIVE_HELD_ELSEWHERE_EXIT`
 * below already had. Consumed by `drive-status.ts`'s own `case 0` sites and
 * by `finish-round.ts`'s `isLeaseExit`, neither of which hand-writes `11`
 * anymore. This module's OWN internal per-tree refusals (`fail(11, ...)` at
 * several sites below) are NOT threaded through this constant — that is a
 * separate, much larger residual (a `fail` call argument, not a `return`
 * statement, at every one of those sites), out of this issue's scope and
 * tracked instead as its own follow-up rather than silently folded in here.
 */
export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode("SESSION_LEASE_HELD");

/**
 * The exit code a PR-WIDE refusal carries: another WORKING TREE is driving this
 * PR.
 *
 * Distinct from `SESSION_LEASE_HELD_EXIT` above — see its own doc comment for
 * why the two must stay tellable apart.
 *
 * Derived from `TERMINAL_STATES` via `outOfBandExitCode` rather
 * than an independent literal that merely happened to match — the same
 * reasoning `finish-round.ts`'s own comment on this constant's import
 * already states for why it is imported here rather than hand-written at
 * each call site.
 */
export const DRIVE_HELD_ELSEWHERE_EXIT = outOfBandExitCode(
  "DRIVE_HELD_BY_OTHER_WORKTREE",
);

/**
 * Refuse this claim when any OTHER working tree holds a live lease on this PR.
 *
 * Called only from inside the state-mutex hold, which is what makes it a gate
 * rather than a hint: every admission that could newly grant a tree the PR
 * takes that mutex, so enumerating under it serialises the decision. Two trees
 * starting at the same instant cannot both observe an empty set — the second to
 * take the mutex reads the first's lease, which the first wrote before
 * releasing it.
 *
 * Refuses on the FIRST foreign holder rather than reporting all of them: more
 * than one live foreign lease means the PR was already being driven from two
 * other trees, which this gate exists to make impossible going forward and
 * which `lease --all` is the surface for diagnosing. A refusal's job is to name
 * one holder precisely enough to act on.
 */
/**
 * `assertNoForeignDrive` for a caller that has not resolved an actor — the
 * no-session tier's admission FENCE.
 *
 * Exists because that tier holds no lease, so `assertLeaseUnchanged` has
 * nothing to compare and the ordinary fence cannot run. Installed by
 * `drive-state.ts` on the sessionless path, where it fires inside every locked
 * section with the state mutex held, which is what turns the preflight in
 * `claimLease` from a racy check into one continuous admission protocol
 * (docomply-review round 2).
 */
export async function assertNoForeignDriveNow(
  stateDir: string,
  pr: string,
): Promise<void> {
  assertNoForeignDrive(stateDir, pr, await resolveActor());
}

function assertNoForeignDrive(
  stateDir: string,
  pr: string,
  actor: string,
): void {
  // Resolved fresh rather than threaded in from a caller, so every entry
  // point — the tier-3 no-session fence, the standalone `admit` preflight,
  // and the tokened/tokenless call inside `claimLease`'s `underLocks` — gets
  // the SAME recycled-pid protection without a parameter every call site has
  // to remember to pass. Pure given a fixed environment, so re-deriving it
  // here agrees with whatever `claimLease` already resolved for this process.
  const session = resolveSession();
  const foreign = liveLeasesFor(stateDir, pr).filter(
    (l) => l.actor !== actor && !isRecycledPid(l, session, actor),
  );
  const l = foreign[0];
  if (l === undefined) {
    // Nothing READABLE is driving. Before admitting, account for the files this
    // gate could not read at all — otherwise "no live foreign lease" is a claim
    // about the subset that happened to parse, and a corrupted or
    // mixed-version live lease reads as an empty PR (docomply-review, medium).
    //
    // This tree's OWN unreadable lease is excluded: `claimLease`'s locked path
    // is about to overwrite it, and refusing there would wedge a tree out of
    // its own PR over its own debris — recoverable only by deleting a file the
    // refusal would be telling it not to touch.
    const self = leasePathFor(stateDir, pr, actor);
    const unreadable = unreadableLeaseFilesFor(stateDir, pr).filter(
      (f) => f !== self,
    );
    if (unreadable.length === 0) return;
    fail(
      DRIVE_HELD_ELSEWHERE_EXIT,
      `drive-state.ts: PR #${pr} has ${unreadable.length} lease file(s) from another working tree that cannot be read as a lease.`,
      ...unreadable.map((f) => `  ${f}`),
      "",
      "Refusing to treat unreadable as absent. A lease file exists because some",
      "tree wrote one, so admitting this command would be a claim about the",
      "files that happened to parse — and being the second resolver on a PR",
      "double-replies every thread both reach.",
      "",
      `Read them to see whose they are. If they are debris, drive-state.ts clear-lease ${pr} --all`,
      `clears every tree's; otherwise they stop blocking on their own once ${leaseStaleMin()}m`,
      "pass without modification.",
    );
  }
  const where = l.worktree === "" ? l.actor : `${l.worktree} (${l.actor})`;
  fail(
    DRIVE_HELD_ELSEWHERE_EXIT,
    `drive-state.ts: PR #${pr} is already being driven from ANOTHER working tree — ${where}.`,
    `That tree is held by ${leaseHolderLabel(l)}; it took the lease at ${l.startedAt} and last mutated drive state ${ageLabel(l.lastSeen)} ('${l.command}').`,
    ...(foreign.length > 1
      ? [
          `(${foreign.length} live foreign leases in total — run 'drive-state.ts lease ${pr} --all' to see them.)`,
        ]
      : []),
    "",
    "Two resolvers on one PR put TWO outcome replies on every thread they both",
    "reach, which is not repairable once posted and corrupts the reviewer-scoring",
    "sample. Refusing to be the second.",
    "",
    "Nothing here stops this tree READING the drive: get, held, held-keys,",
    "parked-keys, verified, rounds and lease are all ungated. Only mutating this",
    "PR's drive state — which is the same thing as replying to its threads — is.",
    "",
    leaseLivenessHint(l),
    `If it is gone, or you are taking the PR over deliberately:  drive-state.ts clear-lease ${pr} --all`,
    `Otherwise the lease clears itself once that tree has left drive state`,
    `untouched for ${leaseStaleMin()}m, and this tree is admitted with no further action.`,
  );
}

/**
 * How long a lease this session already holds may go un-rewritten before the
 * next mutating command bothers to renew it. A quarter of the staleness window,
 * capped, so a renewal is always many times more frequent than the expiry it
 * defends against.
 */
function renewAfterMs(): number {
  return Math.min(RENEW_AFTER_MAX_MS, Math.floor(leaseStaleMs() / 4));
}

/**
 * What `claimLease` grants: the per-PR lease (`Lease`)
 * and the tree-wide lease (`TreeLease`) together — every session that claims
 * one now claims the other in the SAME admission, identified or not.
 *
 * Ladder tier 3 (no session identity) used to be the exception — it claimed
 * only a durable PER-PR presence record (`holder: 'worktree'`) and
 * left the tree-wide axis a stated residual, `{ lease: Lease; treeLease:
 * null }`. an earlier change closes that: tier 3 now claims a `holder: 'worktree'`
 * TREE lease too (`claimSessionlessTreeLease`), so that variant is gone —
 * every admission is now either BOTH non-null or BOTH null, and the two
 * fields never need checking independently.
 *
 * The one remaining `{ lease: null; treeLease: null }` case is narrower than
 * "sessionless": it is tier 3 finding this tree's OWN per-PR lease already
 * belongs to a live IDENTIFIED session, and deferring to it rather than
 * writing anything — see `claimLease`'s own tier-3 branch.
 */
export type LeaseAdmission =
  | { lease: Lease; treeLease: TreeLease }
  | { lease: null; treeLease: null };

/**
 * The read-only half of the DEFERRED sessionless case's tree-wide check
 *, shared by the PREFLIGHT (`checkNoForeignSessionInTree`,
 * called directly by `claimLease`'s deferred branch) and the FENCE
 * (`acquireSessionlessTreeGuardNow`) — same evidence, same refusal,
 * different callers.
 *
 * Reached only when `claimLease` deferred (`{ lease: null, treeLease: null
 * }`): this tree's own per-PR lease already belongs to a live identified
 * session, so tier 3 claims nothing of its own here either — see
 * `claimLease`'s own tier-3 branch — and the only question left to ask is
 * whether the tree lease shows someone else already driving here. Every
 * OTHER tier-3 admission now claims a tree lease of its own
 * (`claimSessionlessTreeLease`) and is fenced by
 * `assertTreeLeaseUnchanged` instead, the same fence an identified session
 * gets.
 *
 * Fails closed on an unreadable-but-fresh file the identical way
 * `claimTreeLease`'s own writer path does (`treeLeaseUnreadableAndFresh`,
 * PR #4131 round 1): a record that exists but cannot be parsed is evidence
 * SOME session wrote it, and `readTreeLease` collapsing that to `null` must
 * not read as "nobody is here" for a sessionless caller either
 * (chatgpt-codex-connector, a reference-implementation pull request round 2).
 */
function checkNoForeignSessionInTree(path: string): void {
  if (treeLeaseUnreadableAndFresh(path)) {
    // Exit 11, not a generic 1 — the SAME exit this function's own confirmed
    // case a few lines down uses ("this working tree is already being driven
    // by a live session"). Not `DRIVE_HELD_ELSEWHERE_EXIT` (13): that code
    // names the PR-wide gate's cross-TREE refusal, a different question from
    // this tree-wide, within-this-tree one — using it here would trade one
    // inconsistency (an unnamed 1) for a worse one (11 and 13 both meaning
    // "another session already holds THIS tree" in the same function)
    // (coderabbitai, PR #4131 round 3; exit 13 was its literal suggestion,
    // corrected to 11 to match this function's own sibling case rather than
    // the differently-scoped PR-wide gate).
    fail(
      11,
      `drive-state.ts: this working tree's TREE lease exists but could not be read as one:`,
      `  ${path}`,
      "",
      "Refusing to treat unreadable as absent. This process could not identify",
      "its own session, so it cannot take a lease of its own to compare against —",
      "but a record that exists and cannot be parsed is exactly the evidence of",
      "whether another live session already holds this tree (mirroring",
      "the identified claim path's unreadable-and-fresh check).",
      "",
      `If it is debris, remove it deliberately:  rm '${path}'`,
      `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
      "without modification.",
    );
  }
  const held = readTreeLease(path);
  if (held === null || !leaseAlive(held)) return;
  // `held` is reached here ONLY via the DEFER path (this tree's own per-PR
  // lease already belongs to a live identified session on the SAME pr), so
  // in normal operation `held` is that same session's tree record — but a
  // holder-type branch is cheap insurance against the narrow edge case where
  // an operator's manual `rm`/debris cleanup left the two records out of
  // sync (`clear-lease` itself always drops both together), so this can
  // never print a fabricated "pid 0".
  if (held.holder === "worktree") {
    fail(
      11,
      `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr}.`,
      `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "This process could not identify its own session ($DRIVE_PR_SESSION and",
      "$CLAUDE_PID are both unset or dead), and a live sessionless resolver",
      "already holds this tree — mutating anyway would run beside it, in the",
      "same checkout.",
      "",
      leaseLivenessHint(held),
    );
  }
  fail(
    11,
    `drive-state.ts: this working tree is already being driven by a live session (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
    `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
    "",
    "This process could not identify its own session ($DRIVE_PR_SESSION and",
    "$CLAUDE_PID are both unset or dead), so it can take no lease of its own —",
    "but a live one already held here means mutating anyway would run beside",
    "it, in the same checkout.",
    "",
    leaseLivenessHint(held),
  );
}

/**
 * The FENCE half of the DEFERRED sessionless case (PR #4131 round
 * 2): acquires `treeLeaseLock` and runs `checkNoForeignSessionInTree` UNDER
 * it, then returns the lock STILL HELD for the caller to hand to
 * `store.setExtraLock` — which keeps it held through the mutation the fence
 * guards, not merely through the check.
 *
 * Reached only when `claimLease` deferred (this tree's own per-PR lease
 * already belongs to a live identified session, so tier 3 claimed no tree
 * lease of its own either — see `claimLease`'s own tier-3 branch). Every
 * OTHER tier-3 admission now claims a `TreeLease` of its own
 * (`claimSessionlessTreeLease`) and is fenced by
 * `acquireIdentifiedTreeGuardNow` below instead, the same fence an
 * identified session gets — that function's name predates an earlier change and is
 * no longer literal (it fences ANY admitted `TreeLease`, not only one an
 * identified session wrote), kept as-is to avoid a rename rippling through
 * every comment that already names it.
 *
 * That "through the mutation" part is the whole fix. A plain re-check under
 * a lock that releases immediately after answering still leaves a gap: this
 * command holds only ITS OWN pr's state mutex, while `claimTreeLease`'s own
 * takeover/creation for a DIFFERENT pr takes THAT pr's mutex — never this
 * one — before reaching for `treeLeaseLock`. So a foreign claim can land in
 * the instant between "the fence said clear" and "the mutation actually
 * ran", and both proceed in the same checkout regardless of how carefully
 * the check itself was synchronized (docomply-review + chatgpt-codex-
 * connector, PR #4131 round 2, reported independently). Holding
 * `treeLeaseLock` across that whole window is what closes it: any
 * `claimTreeLease` call for ANY pr in this tree needs the SAME lock before
 * it can write, so it queues behind this command's entire critical section
 * instead of slipping into the gap after the check.
 *
 * Lock order is state-mutex(thisPr) → `treeLeaseLock` — `locked` has
 * already acquired the state mutex before `runFence` ever runs, and this
 * acquires `treeLeaseLock` only after that — the SAME order `claimTreeLease`
 * itself uses (state-mutex(X) → `treeLeaseLock`) whenever X happens to equal
 * thisPr, so two commands can never each hold the lock the other is waiting
 * on.
 */
export async function acquireSessionlessTreeGuardNow(
  stateDir: string,
): Promise<PathLock> {
  const actor = await resolveActor();
  const path = treeLeasePathFor(stateDir, actor);
  const lock = treeLeaseLock(path);
  // EXPLICIT bound, not the bare default — see this function's own comment
  // on why "no caller-settable deadline" (chatgpt-codex-connector, a reference-implementation pull request
  // round 5) is a real, if narrow, concern: `acquire()`'s implicit default
  // reads `$DRIVE_PR_LOCK_TIMEOUT`, a PROCESS-WIDE env var that can be raised
  // for an unrelated outer acquisition and would then silently inflate this
  // NESTED one too, called while the PR's own state mutex is already held —
  // compounding the wait every OTHER command on that PR queues behind.
  // Pinning it to `LOCK_ACQUIRE_MAX_SEC` — the same hard ceiling every lock
  // in this module is already bounded by — keeps this acquisition's worst
  // case fixed regardless of that env var. True cooperative cancellation
  // (an AbortSignal threaded from the caller) would bound it further and is
  // a larger, deferred change: no lock in this module accepts one today, and
  // adding the primitive is its own review surface.
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    checkNoForeignSessionInTree(path);
  } catch (e) {
    lock.release();
    lock.dispose();
    throw e;
  }
  return lock;
}

/**
 * The counterpart of `acquireSessionlessTreeGuardNow` for every admission
 * that carries a genuine `TreeLease` token:
 * acquires `treeLeaseLock`, runs `assertTreeLeaseUnchanged` UNDER it, then
 * returns the lock STILL HELD for the caller to hand to
 * `store.setExtraLock` — the identical "through the mutation, not just the
 * check" fix round 2 gave the sessionless branch, which this branch never
 * received (chatgpt-codex-connector, a reference-implementation pull request round 3).
 *
 * Originally reached only for an IDENTIFIED session — hence the name — and
 * now, since an earlier change, for tier 3's own `holder: 'worktree'` claim too
 * (`claimSessionlessTreeLease`): either way, admission left this call site
 * an actual `TreeLease` to compare against, so it re-checks via
 * `assertTreeLeaseUnchanged` rather than asking `checkNoForeignSessionInTree`'s
 * coarser "is anyone here at all" question — but a point-in-time re-check
 * with the lock released right after still leaves the identical gap open: a
 * DIFFERENT pr's claim (`claimTreeLease` or `claimSessionlessTreeLease`)
 * takes only THAT pr's state mutex before reaching for `treeLeaseLock`, so
 * it can land between "the fence found no takeover" and "the mutation
 * actually ran" exactly as it could before round 2 closed this for the
 * deferred sessionless caller. Holding the lock across that whole window
 * closes it here too, by the same reasoning — for either ladder tier.
 *
 * Lock order is unchanged: state-mutex(thisPr) → `treeLeaseLock` — this
 * command already holds its own pr's state mutex by the time `runFence`
 * runs, and only reaches for `treeLeaseLock` after that, so it can never
 * deadlock against a `claimTreeLease` call that takes the SAME two locks in
 * the SAME order for a different pr.
 */
export async function acquireIdentifiedTreeGuardNow(
  stateDir: string,
  actor: string,
  admitted: TreeLease,
): Promise<PathLock> {
  const path = treeLeasePathFor(stateDir, actor);
  const lock = treeLeaseLock(path);
  // EXPLICIT bound — see `acquireSessionlessTreeGuardNow`'s identical
  // comment; the same reasoning applies unchanged here.
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    assertTreeLeaseUnchanged(stateDir, actor, admitted);
  } catch (e) {
    lock.release();
    lock.dispose();
    throw e;
  }
  return lock;
}

/**
 * Take or renew this session's TREE-WIDE lease — admits at most one
 * live session per WORKING TREE, whichever PR it names, closing the gap the
 * per-PR lease alone leaves open: two interactive sessions in one tree driving
 * TWO DIFFERENT PRs resolve two different `leasePathFor` files and never meet,
 * so neither refuses the other, even though they share one checkout they can
 * both edit, commit, and push.
 *
 * Mirrors the per-PR claim below — same fast path, same takeover refusal (exit
 * 11), same renewal-preserves-generation rule — over a lease file keyed by
 * ACTOR ALONE rather than (actor, pr). That is what closes the race a per-PR
 * mutex cannot: every claim in this tree, whichever PR it is for, serialises
 * on the SAME lock file (`treeLeaseLock`), where a create-vs-create race
 * between two different PRs would otherwise need a mutex the two never share
 * (each PR's `store.locked` section is keyed by that PR alone).
 *
 * A TAKEOVER (this session's own generation, minted fresh because the prior
 * holder is foreign and dead, or because there was none) additionally takes
 * THIS CALL'S OWN `pr`'s state mutex — the identical "mints a new generation
 * takes the state mutex" rule the per-PR claim below applies to itself, for
 * the identical reason: without it, a takeover here can land WHILE an
 * already-admitted command for that same PR is still inside its locked
 * section (its session killed mid-mutation, the subprocess still finishing),
 * and `assertTreeLeaseUnchanged` then refuses that command's OWN fence check
 * on the way out — turning a harmless, already-in-flight completion into a
 * spurious refusal (measured: `a dead-pid takeover cannot land while a
 * command holds the state mutex` red under a takeover with no such
 * coordination). Taking that PR's mutex here makes the takeover wait out
 * exactly that command, the same ordering guarantee the per-PR lease already
 * gives its own admission.
 *
 * Scoped to `pr` ALONE, and that is a real, stated boundary rather than full
 * coverage: a takeover for a DIFFERENT pr than the one an in-flight command
 * is finishing does not wait on it, because there is no single mutex that
 * spans every PR a tree might be mid-flight on. The residual is narrow — it
 * needs a session to die mid-mutation on PR X at the same moment a takeover
 * begins for a DIFFERENT PR Y in the same tree — and bounded the same way the
 * per-PR hazard always was: the takeover can only happen once THIS lease's
 * own staleness test has judged the previous holder abandoned, so the
 * exposure is to a session already presumed gone, not a live one.
 *
 * Called first, before the per-PR claim: a conflict here means the caller
 * never reaches — or writes — its own per-PR lease at all.
 */
/**
 * What `claimTreeLease` returns: the lease itself, plus the raw bytes a
 * ROLLBACK needs — NOT the parsed identity
 * (pid, host, generation) round 1's `rollbackTreeLease` compared.
 *
 * Two concurrent commands from the SAME session share (pid, host,
 * generation) identically whenever a renewal preserves the generation —
 * DELIBERATELY, since that identity is what lets one session juggle several
 * PRs from one tree without refusing itself. So identity alone cannot tell
 * "the write THIS call made" apart from "a sibling call's write, from the
 * same session" — a rollback keyed on it can restore a stale snapshot over,
 * or outright delete, a sibling's successful admission (measured: two
 * siblings racing a tree lease's CREATION can both capture `before: null`
 * from the same pre-write instant, and the loser's rollback then deletes the
 * winner's lease entirely). Round 2's fix was a compare-and-swap on the
 * EXACT BYTES this call wrote, captured and compared while holding the SAME
 * lock the write itself used — never derived from a snapshot read outside
 * it.
 *
 * Round 4 narrowed that comparison further: `lastSeen`'s millisecond
 * resolution lets two writes from the same session, same pr, same command
 * tie, producing byte-for-byte identical JSON — which made the raw-bytes CAS
 * itself ambiguous between "still my write" and "a sibling's later write
 * that happens to match" (docomply-review, a reference-implementation pull request round 4). `wroteRaw` is
 * kept for the actual write/restore, but `rollbackTreeLease` now identifies
 * "the write THIS call made" by the fresh, per-write-only `revision` field
 * embedded in it, parsed and compared explicitly rather than assumed unique
 * by virtue of the bytes around it.
 *
 * `wroteRaw` is `null` on the fast path: no write happened, so there is
 * nothing for a rollback to undo. `beforeRaw` is only meaningful when
 * `wroteRaw` is not `null`, and is `null` there when nothing existed at this
 * path immediately before this call's write.
 */
interface TreeLeaseClaim {
  lease: TreeLease;
  wroteRaw: string | null;
  beforeRaw: string | null;
}

/**
 * `isMine`'s counterpart for the TREE-WIDE file specifically: is
 * `held` THIS caller's own claim?
 *
 * `isMine` itself is correct for the file it was built for — the PER-PR
 * presence record, already scoped to (tree, pr) by its own filename, where
 * actor equality is the only remaining question. Reused UNMODIFIED against
 * the TREE-WIDE file, it answers a DIFFERENT and wrong question: that file
 * is ONE PER TREE, covering every pr the tree might drive, and `isMine`'s
 * `holder === 'worktree'` branch does not even consult its `Session`
 * argument — so every caller in this tree, whichever pr it names, would
 * read a live `holder: 'worktree'` TREE record as its own. Before an earlier change
 * this was silently correct by construction, because nothing but an
 * IDENTIFIED session's own `claimTreeLease` ever wrote one here (always
 * `holder: 'session'`) — `isMine`'s session branch (pid/host/token) was the
 * only branch this file could ever actually reach. an earlier change makes tier 3
 * write `holder: 'worktree'` records to this SAME file, and `claimTreeLease`
 * — and the irreversible-post fence, `assertTreeMutationAllowed` — meeting
 * one now needs a different test: an identified session claiming PR 888
 * would otherwise silently take over, with no refusal and no takeover
 * diagnostic, a LIVE sessionless resolver's tree-wide claim on PR 999 in
 * the same tree — the exact cross-shipping hazard this whole mechanism
 * exists to close, reopened by treating the new record shape as
 * automatically "mine" (found in review, before this shipped).
 *
 * The fix mirrors `claimSessionlessTreeLease`'s own `samePr` reasoning: a
 * `holder: 'worktree'` record names a SPECIFIC pr, so ownership of it turns
 * on THAT pr matching the caller's, not on sharing a tree. A match is a
 * deliberate, intentional smooth handoff — the tree-wide mirror of
 * an earlier change's own per-PR ruling that "an identified session may take over
 * its own tree's presence record freely, because that record was never a
 * claim about sessions" — so an identified session finishing what a
 * sessionless resolver started on the SAME pr upgrades it without a
 * refusal or a takeover diagnostic, exactly as before this fix. A mismatch
 * — or no pr to compare at all (`pr === null`, `assertTreeMutationAllowed`'s
 * standalone `assert-post-allowed.ts` caller with no PR in play) — is never
 * "mine", and falls through to the ordinary live-refuse / stale-takeover
 * path, symmetric with how `claimSessionlessTreeLease` already treats a
 * foreign SESSION-held record.
 *
 * `held.holder === 'session'` is unaffected: ownership there is exactly
 * `isMine`, unchanged.
 */
function treeIsMine(
  held: TreeLease,
  session: Session,
  actor: string,
  pr: string | null,
): boolean {
  if (held.holder === "worktree") {
    return pr !== null && held.pr === canonicalLeasePr(pr);
  }
  return isMine(held, session, actor);
}

async function claimTreeLease(
  stateDir: string,
  actor: string,
  session: Session,
  worktree: string,
  pr: string,
  command: string,
): Promise<TreeLeaseClaim> {
  const canonicalPr = canonicalLeasePr(pr);
  const path = treeLeasePathFor(stateDir, actor);

  // Fast path — see the per-PR claim's own comment on why this is not merely
  // an optimisation: `claim-held` fans out one process per key, and each of
  // those legitimately renews this same tree lease concurrently.
  //
  // `seen.pr === canonicalPr` is REQUIRED here, not just `isMine` — this
  // session's OWN previous claim may have been for a DIFFERENT pr (one
  // session juggling several PRs from one tree, an earlier change's own acceptance
  // criterion), and the fast path returns `seen` UNCHANGED with no write, so
  // skipping this check would report the PREVIOUS pr in every diagnostic and
  // refusal until the lease next goes through the locked path for some other
  // reason (chatgpt-codex-connector / docomply-review, a reference-implementation pull request round 1).
  //
  // `seen.holder === 'session'` is ALSO required, and is not implied by
  // `treeIsMine` — that predicate answers "mine" for a `holder: 'worktree'`
  // record on a MATCHING pr too, but "mine" there means "I may UPGRADE this
  // record", not "this record already IS what I would write". Returning
  // `seen` unchanged in that case would leave the file `holder: 'worktree'`,
  // `pid: 0` forever — this session's own admission would then compare
  // (0, host, generation) against itself in every later fence, and the
  // record would never actually reflect that an identified session is now
  // driving (found in review: the SAME-pr upgrade test failed exactly this
  // way before this guard existed). An upgrade always takes the locked path
  // below, which writes the converted record — see `mine`'s own comment.
  const seen = readTreeLease(path);
  if (
    seen !== null &&
    seen.holder === "session" &&
    treeIsMine(seen, session, actor, pr) &&
    seen.pr === canonicalPr &&
    Date.now() - Date.parse(seen.lastSeen) < renewAfterMs()
  ) {
    return { lease: seen, wroteRaw: null, beforeRaw: null };
  }

  // `isRecycledPid` overrides `leaseAlive` here for the identical reason the
  // per-PR claim's own `mintsNewGeneration` does: once the OS hands a dead
  // predecessor's exact pid to this new session, `leaseAlive`'s pid check is
  // asking whether THIS process is running — tautologically yes — and says
  // nothing about the dead predecessor `isMine` has already proven wrote
  // `seen` (docomply-review round 9 / chatgpt-codex-connector round 8, PR
  // #4131: the tree-lease claim omitted this, blocking every PR in the
  // checkout until the stale lease aged out instead of recognizing the
  // takeover it actually was). Never true for a `holder: 'worktree'` `seen`
  // — `isRecycledPid` fails its own pid-match guard against pid 0 — so it is
  // harmless dead weight there, not a hazard.
  const mintsNewGeneration =
    seen === null ||
    (!treeIsMine(seen, session, actor, pr) &&
      (isRecycledPid(seen, session, actor) || !leaseAlive(seen)));
  return await withStateLock(mintsNewGeneration);

  async function withStateLock(holdState: boolean): Promise<TreeLeaseClaim> {
    const stateLock = holdState
      ? createLock(join(stateDir, `drive-pr-${pr}.json`), "drive-state.ts", pr)
      : null;
    if (stateLock) await stateLock.acquire();
    try {
      return await underLock(holdState);
    } finally {
      if (stateLock) {
        stateLock.release();
        stateLock.dispose();
      }
    }
  }

  async function underLock(holdState: boolean): Promise<TreeLeaseClaim> {
    const lock = treeLeaseLock(path);
    await lock.acquire();
    try {
      // A file that EXISTS but cannot be read as a lease is evidence some
      // session wrote it — treating that as absent would mint a new
      // generation over a possibly-still-live foreign session on the
      // strength of a record nobody could actually read, mirroring the exact
      // gap `unreadableLeaseFilesFor` closes for the PR-wide gate
      // (chatgpt-codex-connector / docomply-review, a reference-implementation pull request round 1).
      // Bounded by mtime for the identical reason that check is: an
      // unreadable file has no `lastSeen` a liveness test can read, so age is
      // the only signal left, and a genuinely old one is debris, not a live
      // claim.
      if (treeLeaseUnreadableAndFresh(path)) {
        // Exit 11, matching this function's OWN confirmed-live-foreign-
        // session case below, not `DRIVE_HELD_ELSEWHERE_EXIT` (13) — see
        // `checkNoForeignSessionInTree`'s identical fix for why 13 would be
        // the wrong precedent to follow here (coderabbitai, PR #4131 round
        // 3).
        fail(
          11,
          `drive-state.ts: this working tree's TREE lease exists but could not be read as one:`,
          `  ${path}`,
          "",
          "Refusing to treat unreadable as absent. That file is exactly the evidence",
          "of whether another live session already holds this tree, so admitting a",
          "takeover here would be a claim this process could not actually verify",
          "(mirroring the PR-wide gate's unreadableLeaseFilesFor).",
          "",
          `If it is debris, remove it deliberately:  rm '${path}'`,
          `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
          "without modification.",
        );
      }
      // The rollback preimage — read as RAW BYTES, under this exact lock,
      // immediately before this call's own write. Reading it any earlier (a
      // snapshot taken by the caller before ever reaching this lock) is
      // precisely the round-1 bug: a concurrent sibling from the same
      // session can write in between, and the outer snapshot would then be
      // stale by the time a rollback compares against it.
      let beforeRaw: string | null;
      try {
        beforeRaw = readFileSync(path, "utf8");
      } catch {
        beforeRaw = null;
      }
      const held = beforeRaw === null ? null : parseTreeLease(beforeRaw);
      const mine = held !== null && treeIsMine(held, session, actor, pr);
      // Same restart-under-both-locks rule as the per-PR claim: the unlocked
      // peek above can be stale by the time this lock is held. `isRecycledPid`
      // is threaded through here too — see `mintsNewGeneration`'s own comment
      // above for why `leaseAlive` alone is the wrong test once the pid has
      // been recycled onto this very caller.
      if (
        !holdState &&
        (held === null ||
          (!mine && (!leaseAlive(held) || isRecycledPid(held, session, actor))))
      ) {
        lock.release();
        lock.dispose();
        return await withStateLock(true);
      }
      if (held !== null && !mine) {
        // `isRecycledPid` overrides `leaseAlive` here for the same reason it
        // overrides it in `mintsNewGeneration`: once `held.pid ===
        // session.pid`, `leaseAlive`'s pid check is asking whether THIS
        // process is running, which is tautologically true and says nothing
        // about the dead predecessor `isMine` has already proven wrote `held`.
        // Never true for a `holder: 'worktree'` `held` — see `mintsNewGeneration`'s
        // own note.
        if (leaseAlive(held) && !isRecycledPid(held, session, actor)) {
          if (held.holder === "worktree") {
            // The direction of the hazard `treeIsMine` closes: this
            // identified session's own pr differs from the live sessionless
            // resolver's, so it is foreign, not an upgrade — refuse exactly
            // as `claimSessionlessTreeLease` refuses the mirror case, naming
            // no pid (there is none) rather than fabricating one.
            fail(
              11,
              `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr} — this command is for PR #${canonicalPr}.`,
              `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
              "",
              "This identified session and that sessionless resolver share the same",
              "checkout: they can edit and commit the same files concurrently, and",
              "one resolver's uncommitted changes can be pushed to the other's PR.",
              "Refusing to be the second.",
              "",
              leaseLivenessHint(held),
              `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
              "Otherwise the tree's presence record clears itself once that resolver",
              `has left drive state untouched for ${leaseStaleMin()}m.`,
            );
          }
          fail(
            11,
            `drive-state.ts: this working tree is already being driven by another live session (pid ${held.pid} on ${held.host || "this host"}) — it is on PR #${held.pr}, this command is for PR #${canonicalPr}.`,
            `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
            "",
            "Two sessions in ONE tree — even driving different PRs — share the same",
            "checkout: they can edit and commit the same files concurrently, and one",
            "session's uncommitted changes can be pushed to the other's PR. Refusing",
            "to be the second.",
            "",
            leaseLivenessHint(held),
            `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
            "Otherwise the tree lease clears itself once that session has left drive",
            `state untouched for ${leaseStaleMin()}m.`,
          );
        }
        console.error(
          held.holder === "worktree"
            ? `drive-state.ts: took over an abandoned TREE presence record (a sessionless resolver, gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`
            : isRecycledPid(held, session, actor)
              ? `drive-state.ts: took over a TREE lease whose pid (${held.pid}) the OS has recycled for this new, unrelated session (previous session last mutated drive state ${ageLabel(held.lastSeen)}, was on PR #${held.pr}).`
              : `drive-state.ts: took over an abandoned TREE lease (session pid ${held.pid} is gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`,
        );
      }
      const now = new Date().toISOString();
      const lease: TreeLease = {
        // `claimTreeLease` is only reached for an identified session — ladder
        // tier 3 claims its OWN tree-wide record via `claimSessionlessTreeLease`
        // instead — so this is always `'session'`, matching the
        // per-PR lease's own construction site.
        holder: "session",
        pid: session.pid,
        host: session.host,
        platform: process.platform,
        actor,
        worktree,
        startedAt: mine && held !== null ? held.startedAt : now,
        lastSeen: now,
        command,
        generation:
          mine && held !== null
            ? held.generation
            : randomBytes(16).toString("hex"),
        sessionStarted: session.sessionStarted,
        pr: canonicalPr,
        // Fresh on EVERY write, regardless of `mine`/renewal — see the
        // field's own doc comment on `TreeLease`. Never preserved, unlike
        // `generation`: its whole job is to make this exact write
        // distinguishable from any other.
        revision: randomBytes(16).toString("hex"),
      };
      const wroteRaw = `${JSON.stringify(lease, null, 2)}\n`;
      atomicWrite(path, wroteRaw);
      return { lease, wroteRaw, beforeRaw };
    } finally {
      lock.release();
      lock.dispose();
    }
  }
}

/**
 * Undo a `claimTreeLease` write when the per-PR claim that followed it
 * failed — restores `beforeRaw` (or removes the
 * file, when `beforeRaw` is `null`), but ONLY if the file on disk still holds
 * THIS call's own write.
 *
 * That compare-and-swap is load-bearing, not decoration — see
 * `TreeLeaseClaim`'s own comment for the concurrent-sibling hazard it closes
 * that an identity-based check (round 1's `(pid, host, generation)`
 * comparison) could not: two writes from the same session are
 * indistinguishable by identity alone. Round 1/2 compared raw serialized
 * BYTES instead, reasoning that every write stamps a fresh `lastSeen` — true,
 * but `lastSeen` only has millisecond resolution, so two writes from the same
 * session, same pr, same command, with `generation` preserved by a renewal,
 * CAN tie on it and produce byte-for-byte identical JSON. A rollback keyed on
 * raw bytes then can't tell "the write THIS call made" apart from a sibling's
 * later, coincidentally identical one, and can revert or delete a
 * successfully admitted sibling (docomply-review, a reference-implementation pull request round 4). The
 * comparison is therefore on `revision` — a fresh random token stamped on
 * EVERY write, never preserved across a renewal, whose only job is telling
 * writes apart — parsed from both sides rather than compared as bytes, so an
 * incidental whitespace/key-order difference could never make two DIFFERENT
 * writes look unequal either.
 */
async function rollbackTreeLease(
  path: string,
  wroteRaw: string,
  beforeRaw: string | null,
): Promise<void> {
  const wrote = parseTreeLease(wroteRaw);
  // `wroteRaw` is always this module's own just-serialized write — a
  // moment ago, under this same lock — so it must parse; if it somehow does
  // not, there is no `revision` to compare against and rolling back on raw
  // bytes alone would reintroduce the exact ambiguity this fix closes.
  if (wrote === null) return;
  const lock = treeLeaseLock(path);
  await lock.acquire();
  try {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return; // gone already — nothing to swap out from under
    }
    const currentParsed = parseTreeLease(current);
    if (currentParsed === null || currentParsed.revision !== wrote.revision) {
      return; // someone else's write since — leave it
    }
    if (beforeRaw === null) {
      rmSync(path, { force: true });
    } else {
      atomicWrite(path, beforeRaw);
    }
  } finally {
    lock.release();
    lock.dispose();
  }
}

/**
 * Ladder tier 3's own claim of the TREE-WIDE lease — the
 * `holder: 'worktree'` presence-record pattern an earlier change built for the per-PR
 * axis, extended to the axis an earlier change left open for the sessionless tier: a
 * durable record at the SAME path an identified session's `claimTreeLease`
 * writes to (`treeLeasePathFor`), so a second sessionless resolver in this
 * tree — even one driving a DIFFERENT pr — now finds something to read,
 * closing the gap chatgpt-codex-connector's PR #4131 review named and
 * `claimLease`'s own tier-3 comment used to leave as a stated residual.
 *
 * `isMine` cannot decide ownership here, and that is why this is a separate
 * function rather than a `claimTreeLease` branch: `isMine`'s `holder ===
 * 'worktree'` case answers `actor === actor`, which is exactly right for the
 * PER-PR presence record — that file is already scoped to (tree, pr) by its
 * own name, so actor equality is the only question left — but this file is
 * ONE PER TREE, covering every pr the tree might drive, so actor equality
 * alone would treat every sessionless caller in this tree as the SAME owner,
 * whichever pr it names. That is precisely the gap this issue closes, so
 * ownership here turns on `pr` too: a live record for THIS pr is a renewal,
 * a live record for ANY OTHER pr — or a live SESSION-held record, whichever
 * pr it names — is foreign.
 *
 * That is a real, stated cost, not a free extension: a sessionless resolver
 * that finishes with PR X and moves straight to PR Y, with no intervening
 * `clear-lease` and no full staleness window elapsed, is refused —
 * indistinguishable, on the evidence this runtime provides, from a SECOND
 * sessionless resolver that happens to start on PR Y while the first is
 * still working PR X (`claimLease`'s own tier-3 comment states the identical
 * trade for the per-PR axis; this is the same trade, paid again on the tree
 * axis, for the same reason — no identity the runtime does not supply). Two
 * remedies already exist and need nothing new: `clear-lease` drops this
 * record unconditionally regardless of which pr it names (see its own
 * comment), so it is the documented way to move on immediately; left alone,
 * the record clears itself the same way every tier-3 record does, once
 * `leaseStaleMin`m pass with no mutating command.
 *
 * Mirrors `claimTreeLease`'s own structure closely on purpose — same fast
 * path, same unreadable-but-fresh fail-closed check, same
 * mints-a-new-generation-takes-the-state-mutex rule, same
 * rollback-on-later-failure contract via the returned `TreeLeaseClaim` — so
 * `claimLease`'s tier-3 branch below can call this the same way its
 * identified branch calls `claimTreeLease`, rather than growing a differently
 * shaped protocol that would have to be reasoned about from scratch.
 */
async function claimSessionlessTreeLease(
  stateDir: string,
  actor: string,
  worktree: string,
  pr: string,
  command: string,
): Promise<TreeLeaseClaim> {
  const canonicalPr = canonicalLeasePr(pr);
  const path = treeLeasePathFor(stateDir, actor);

  // Fast path — mirrors `claimTreeLease`'s own: this call's OWN previous
  // claim may have been for a DIFFERENT pr (one resolver working several PRs
  // from one tree, in sequence, with `clear-lease` or staleness between
  // them), so `seen.pr === canonicalPr` is required here too, not merely
  // `seen.holder === 'worktree'` — skipping it would report the PREVIOUS pr
  // in every diagnostic until the lease next goes through the locked path.
  const seen = readTreeLease(path);
  if (
    seen !== null &&
    seen.holder === "worktree" &&
    seen.pr === canonicalPr &&
    Date.now() - Date.parse(seen.lastSeen) < renewAfterMs()
  ) {
    return { lease: seen, wroteRaw: null, beforeRaw: null };
  }

  // A live record — session-held, or worktree-held for a DIFFERENT pr — is
  // never a takeover on the strength of THIS unlocked peek alone; only a
  // genuinely dead-looking one mints a new generation and needs the state
  // mutex, matching `claimTreeLease`'s own `mintsNewGeneration` (`!isMine &&
  // (isRecycledPid || !leaseAlive)`) with the ownership half swapped for the
  // pr-based test this record uses instead of `isMine`.
  const mintsNewGeneration =
    seen === null ||
    (!(seen.holder === "worktree" && seen.pr === canonicalPr) &&
      !leaseAlive(seen));
  return await withStateLock(mintsNewGeneration);

  async function withStateLock(holdState: boolean): Promise<TreeLeaseClaim> {
    const stateLock = holdState
      ? createLock(join(stateDir, `drive-pr-${pr}.json`), "drive-state.ts", pr)
      : null;
    if (stateLock) await stateLock.acquire();
    try {
      return await underLock(holdState);
    } finally {
      if (stateLock) {
        stateLock.release();
        stateLock.dispose();
      }
    }
  }

  async function underLock(holdState: boolean): Promise<TreeLeaseClaim> {
    const lock = treeLeaseLock(path);
    await lock.acquire();
    try {
      // Fails closed on a file that exists but cannot be read as a lease —
      // the identical rule `claimTreeLease`'s own locked section applies,
      // for the identical reason (a record that exists and cannot be parsed
      // is exactly the evidence of whether another live claimant already
      // holds this tree).
      if (treeLeaseUnreadableAndFresh(path)) {
        fail(
          11,
          `drive-state.ts: this working tree's TREE lease exists but could not be read as one:`,
          `  ${path}`,
          "",
          "Refusing to treat unreadable as absent. This process could not identify",
          "its own session, so it cannot take a lease of its own to compare against —",
          "but a record that exists and cannot be parsed is exactly the evidence of",
          "whether another live claimant already holds this tree (mirroring",
          "the identified claim path's unreadable-and-fresh check).",
          "",
          `If it is debris, remove it deliberately:  rm '${path}'`,
          `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
          "without modification.",
        );
      }
      // The rollback preimage — see `TreeLeaseClaim`'s own comment on why
      // this must be raw bytes read under this exact lock, not a snapshot
      // taken earlier.
      let beforeRaw: string | null;
      try {
        beforeRaw = readFileSync(path, "utf8");
      } catch {
        beforeRaw = null;
      }
      const held = beforeRaw === null ? null : parseTreeLease(beforeRaw);
      const samePr =
        held !== null && held.holder === "worktree" && held.pr === canonicalPr;
      // Restart under both locks: the unlocked peek above can be stale by
      // the time this lock is held — mirrors `claimTreeLease`'s own restart
      // condition, minus the recycled-pid concern, which does not apply to
      // a holder that never carries a pid in the first place.
      if (!holdState && (held === null || (!samePr && !leaseAlive(held)))) {
        lock.release();
        lock.dispose();
        return await withStateLock(true);
      }
      if (held !== null && !samePr) {
        if (leaseAlive(held)) {
          if (held.holder === "session") {
            fail(
              11,
              `drive-state.ts: this working tree is already being driven by a live session (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
              `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
              "",
              "This process could not identify its own session ($DRIVE_PR_SESSION and",
              "$CLAUDE_PID are both unset or dead), and a live IDENTIFIED session",
              "already holds this tree — writing a sessionless presence record over",
              "it would only downgrade what that session already represents, so this",
              "claims nothing here.",
              "",
              leaseLivenessHint(held),
              `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
              "Otherwise the tree lease clears itself once that session has left drive",
              `state untouched for ${leaseStaleMin()}m.`,
            );
          }
          fail(
            11,
            `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr} — this command is for PR #${canonicalPr}.`,
            `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
            "",
            "Two sessionless resolvers in ONE tree — even driving different PRs —",
            "share the same checkout: they can edit and commit the same files",
            "concurrently, and one resolver's uncommitted changes can be pushed to",
            "the other PR. Refusing to be the second.",
            "",
            leaseLivenessHint(held),
            `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
            "Otherwise the tree's presence record clears itself once that resolver",
            `has left drive state untouched for ${leaseStaleMin()}m.`,
          );
        }
        console.error(
          held.holder === "session"
            ? `drive-state.ts: took over a TREE lease whose session (pid ${held.pid}) is gone or idle since ${held.lastSeen} (was on PR #${held.pr}).`
            : `drive-state.ts: took over an abandoned TREE presence record (a sessionless resolver, gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`,
        );
      }
      const now = new Date().toISOString();
      const lease: TreeLease = {
        holder: "worktree",
        pid: 0,
        host: hostname(),
        platform: process.platform,
        actor,
        worktree,
        startedAt: samePr && held !== null ? held.startedAt : now,
        lastSeen: now,
        command,
        generation:
          samePr && held !== null
            ? held.generation
            : randomBytes(16).toString("hex"),
        sessionStarted: "",
        pr: canonicalPr,
        revision: randomBytes(16).toString("hex"),
      };
      const wroteRaw = `${JSON.stringify(lease, null, 2)}\n`;
      atomicWrite(path, wroteRaw);
      return { lease, wroteRaw, beforeRaw };
    } finally {
      lock.release();
      lock.dispose();
    }
  }
}

/**
 * Take or renew this session's lease over (this working tree, this PR), or
 * refuse because another live session holds it — AND, first, the tree-wide
 * lease that admits this session to the tree at all, whichever
 * ladder tier is asking: tier 3 now claims a presence record of its own
 * there too, rather than only
 * checking one.
 *
 * Returns both leases this session now holds, or `{ lease: null, treeLease:
 * null }` in the one case that still claims nothing: this tree's OWN per-PR
 * lease already belongs to a live IDENTIFIED session (see the tier-3 branch
 * below) — the tree is represented there already, so a tier-3 claim here
 * would be a takeover it cannot justify.
 */
export async function claimLease(
  stateDir: string,
  pr: string,
  command: string,
): Promise<LeaseAdmission> {
  const session = resolveSession();
  const actor = await resolveActor();
  // Resolved HERE, not inside the locked section that records it: the memo in
  // `actor.ts` has already answered by now (`resolveActor` above went through
  // it), so this costs nothing — and it keeps the rule that no subprocess is
  // ever spawned while holding the state mutex every other command queues on.
  // Needed by BOTH branches below — the tier-3 presence record's `worktree`
  // field is the same one an identified session's lease carries.
  const worktree = await worktreeRoot();
  if (session.source === "none") {
    // Ladder tier 3 — no session identity, so no SESSION lease can be taken.
    // That is an earlier change's answer and it stands: a lease that records a pid, and
    // is written under no identity, excludes nobody.
    //
    // It does not follow that nothing can be recorded. What this tree can
    // always prove is that it is THIS TREE, which is precisely the question the
    // PR-wide gate asks — so it writes a `holder: 'worktree'` record instead,
    // and the ordinary path below does it: the presence record IS a lease in
    // every respect except how liveness is tested, which is what lets it reuse
    // the admission protocol (state mutex on creation, PR-wide check under it,
    // `assertLeaseUnchanged` as the fence) rather than grow a parallel one that
    // would have to be argued from scratch.
    //
    // EXCEPT when this tree's OWN per-PR lease is already an identified
    // SESSION's, and it is alive. Then the tree is represented in the PR-wide
    // gate already — and, since every identified claim writes its tree lease
    // together with its per-PR one, the tree-wide record below already names
    // that same session too — so writing a worktree presence record over
    // either would only downgrade tiers 1-2 to tier 3's liveness (the same
    // hazard the fast path's own `seen.holder === holder` check exists to
    // avoid on renewal). This path claims neither and lets `drive-state.ts`
    // fence with `assertNoForeignDriveNow` + `acquireSessionlessTreeGuardNow`
    // instead, exactly as it always has.
    //
    // What this check is narrower than matters: `own` names THIS pr's per-PR
    // file alone, so it says nothing about an identified session driving a
    // DIFFERENT pr from this same tree. `claimSessionlessTreeLease` below
    // covers that — it reads the ONE tree-wide file, whichever pr the caller
    // names, and refuses on a live SESSION-held record there regardless.
    assertNoForeignDrive(stateDir, pr, actor);
    const own = readLease(leasePathFor(stateDir, pr, actor));
    if (own !== null && own.holder === "session" && leaseAlive(own)) {
      return { lease: null, treeLease: null };
    }
    // Claimed FIRST, mirroring the identified branch below
    // exactly: a conflict here (another live session anywhere in this tree,
    // or another sessionless resolver already on a DIFFERENT pr) refuses
    // before this command ever writes its own per-PR presence lease.
    const treeClaim = await claimSessionlessTreeLease(
      stateDir,
      actor,
      worktree,
      pr,
      command,
    );
    let lease: Lease;
    try {
      lease = await claimPrLease();
    } catch (err) {
      // Mirrors the identified branch's own rollback below — see its comment
      // for why this must roll back the tree claim rather than leave it
      // durably wedging this tree over a pr that was never actually admitted.
      if (treeClaim.wroteRaw !== null) {
        try {
          await rollbackTreeLease(
            treeLeasePathFor(stateDir, actor),
            treeClaim.wroteRaw,
            treeClaim.beforeRaw,
          );
        } catch (rollbackErr) {
          console.error(
            `drive-state.ts: could not roll back this tree's TREE presence record after a failed admission (${(rollbackErr as Error)?.message ?? rollbackErr}).`,
          );
          console.error(
            `If it now wedges another session, clear it deliberately:  drive-state.ts clear-lease ${pr}`,
          );
        }
      }
      throw err;
    }
    return { lease, treeLease: treeClaim.lease };
  }
  const treePath = treeLeasePathFor(stateDir, actor);

  // Claimed FIRST. A conflict here (another session already
  // driving this tree, whichever PR) refuses before this command ever reads
  // or writes — or takes over — its own per-PR lease below.
  const treeClaim = await claimTreeLease(
    stateDir,
    actor,
    session,
    worktree,
    pr,
    command,
  );

  let lease: Lease;
  try {
    lease = await claimPrLease();
  } catch (err) {
    // The per-PR claim can still refuse or fail AFTER the tree lease above
    // was already written — a PR-wide conflict on a DIFFERENT
    // tree, or any other failure in `claimPrLease` — and `fail()` throws
    // rather than exiting the process, so without this the tree lease is
    // left durably on disk pointing at a PR that was never actually
    // admitted, wedging this tree for any OTHER identified session until the
    // staleness window passes (chatgpt-codex-connector / docomply-review,
    // a reference-implementation pull request round 1). Roll it back to what THIS call wrote — never on the
    // fast path, where nothing was written and there is nothing to undo.
    //
    // The rollback itself is wrapped: `rollbackTreeLease` can throw (a lock
    // timeout, an fs error), and letting THAT propagate unguarded would
    // replace `err` — the caller's actual admission failure, which is what
    // they asked this command for in the first place — with a diagnostic
    // about tree-lease bookkeeping instead (docomply-review, a reference-implementation pull request round
    // 6). The rollback failure is still surfaced, on stderr, with its own
    // remedy, but `err` is always what gets rethrown.
    if (treeClaim.wroteRaw !== null) {
      try {
        await rollbackTreeLease(
          treePath,
          treeClaim.wroteRaw,
          treeClaim.beforeRaw,
        );
      } catch (rollbackErr) {
        console.error(
          `drive-state.ts: could not roll back this tree's TREE lease after a failed admission (${(rollbackErr as Error)?.message ?? rollbackErr}).`,
        );
        console.error(
          `If it now wedges another session, clear it deliberately:  drive-state.ts clear-lease ${pr}`,
        );
      }
    }
    throw err;
  }
  return { lease, treeLease: treeClaim.lease };

  async function claimPrLease(): Promise<Lease> {
    const path = leasePathFor(stateDir, pr, actor);

    /** What this caller writes — see `Lease.holder` and ladder tier 3. */
    const holder: Lease["holder"] =
      session.source === "none" ? "worktree" : "session";

    // Fast path, deliberately LOCK-FREE: the lease is already ours and was
    // renewed moments ago, so there is nothing to decide and nothing to write.
    //
    // This is not an optimisation for its own sake. One session's mutating
    // commands are legitimately CONCURRENT — `claim-held` fans out one process
    // per key, and eight of them contending a mutex just to push the same
    // timestamp forward serialises a fan-out that conflicts over nothing (it
    // timed out the "only one of many concurrent claimants wins"
    // probe). The mutex exists to settle who OWNS the lease, and ownership is
    // not in question here.
    //
    // Reading unlocked cannot hand the lease to anyone: a foreign session may
    // only take one over after observing it as NOT alive, and this path returns
    // only when ours is alive by a wide margin (`renewAfterMs` is a fraction of
    // the staleness window). A torn or half-written read fails `readLease`'s
    // shape check and falls through to the locked path, which is also where a
    // lease that is missing, foreign, or due for renewal goes.
    const seen = readLease(path);
    if (
      seen !== null &&
      isMine(seen, session, actor) &&
      // A record of the OTHER kind is ours (same tree) but is not the one this
      // caller should be renewing, so it never short-circuits: an identified
      // session that found its own tree's tier-3 presence record must reach the
      // locked path and rewrite it as a SESSION lease. Skipping that would leave
      // the tree recorded pid-lessly for as long as the session kept renewing —
      // costing every other tree the fast dead-pid clear it is entitled to, and
      // silently downgrading tiers 1-2 to tier 3's liveness.
      seen.holder === holder &&
      Date.now() - Date.parse(seen.lastSeen) < renewAfterMs()
    ) {
      return seen;
    }

    // A TAKEOVER — overwriting another session's lease because its owner is dead
    // or has stopped renewing — is a REVOCATION, and every other revocation on
    // this PR coordinates with the state mutex: `clear-lease` takes it (round 8),
    // `reset` holds it across `clearAllLeases`. This path did not, which left the
    // one window the admission fence cannot see: the owner dies AFTER its child
    // passed `runFence()`, a replacement takes the lease over holding only the
    // lease mutex, and the old child then completes its mutation while the
    // replacement queues behind it — both writing under one actor, and for
    // `claim-held` both dispatching a non-idempotent answer (docomply-review and
    // chatgpt-codex-connector, round 11, PR #4069).
    //
    // Taking the state mutex here closes it: a takeover can no longer land while
    // any command holds that mutex, which is exactly the interval between the
    // fence and the mutation it guards.
    //
    // ORDER IS state → lease, matching `clear-lease` and `reset` — the only two
    // other places both are held. Nothing anywhere takes them the other way
    // round, so this cannot deadlock against them. It is also strictly BEFORE
    // the command's own `store.locked`, never nested inside it: `claimLease` runs
    // at admission and releases both locks before returning.
    //
    // Only on the takeover path, decided from the unlocked read above. The
    // ordinary cases — no lease, our own lease due for renewal — do not revoke
    // anything and keep the cheap single-lock path, which matters because
    // `claim-held` fans out one process per key and the fast path above is what
    // keeps that from serialising on a mutex.
    //
    // ── What exactly needs the state mutex ──────────────────────────────────
    //
    // The rule is: **any write that MINTS A NEW GENERATION takes the state
    // mutex.** That is one invariant covering both cases, and it is the one the
    // fence actually depends on, because a new generation is precisely what
    // invalidates an outstanding admission.
    //
    //   - takeover  (`held` exists, is foreign, and is not alive) — the original
    //     round-11 case;
    //   - CREATION  (`held` is absent) — round 13's. Scoping the mutex to
    //     takeovers alone left `reset` exposed to a tree it had never seen: a new
    //     actor's first claim writes a lease AFTER `clearAllLeases` enumerated,
    //     so the sweep reports no live foreign lease, `reset` deletes the shared
    //     state and claim files, and the freshly admitted command then runs
    //     against reset state seeing its own lease intact (docomply-review round
    //     13, PR #4069). Taking the mutex for creation makes enumeration and
    //     reset atomic with respect to new admissions, which is what that finding
    //     asks for.
    //
    // A RENEWAL preserves the generation, so it invalidates nothing and keeps the
    // cheap single-lock path — which is what matters for `claim-held`'s per-key
    // fan-out, since only the first of those can be a creation and the rest renew.
    //
    // ── And one more case, for the PR-WIDE gate ──────────────────
    //
    // A renewal of a lease that has gone QUIET past `leaseFreshMarginMs` takes
    // the state mutex too, and re-runs the PR-wide check under it. Both halves
    // are needed. A lease that quiet is approaching the point where a foreign
    // tree may legitimately observe it as dead and take the PR — so continuing to
    // renew it without looking is precisely how this session would resume beside
    // a successor that was correctly admitted while it was idle. The state mutex
    // is what makes that look authoritative rather than advisory.
    //
    // Inside the margin the check is SKIPPED, and that skip is an argument, not
    // an optimisation — see `leaseFreshMarginMs`. It is also what keeps the
    // `claim-held` fan-out off the state mutex: those renewals are seconds old.
    //
    // `isRecycledPid(seen, session)` is checked ALONGSIDE `!leaseAlive(seen)`,
    // not folded into it: `leaseAlive`'s pid half is meaningless evidence for
    // this specific `seen` once `seen.pid === session.pid`, because that call
    // is then asking whether `session` itself is running — trivially yes,
    // regardless of how long ago the dead predecessor who actually wrote `seen`
    // stopped renewing it. Without this, a pid the OS reused inside the
    // staleness window reads as a live FOREIGN lease (below) rather than a
    // takeover, which is exactly the collision: `isMine` correctly
    // says "not mine", but `leaseAlive` alone would keep saying "and it's still
    // out there" for as long as `session` — i.e. itself — keeps running.
    const mintsNewGeneration =
      seen === null ||
      (!isMine(seen, session, actor) &&
        (isRecycledPid(seen, session, actor) || !leaseAlive(seen)));
    const quietPastMargin =
      seen !== null &&
      Date.now() - Date.parse(seen.lastSeen) > leaseFreshMarginMs();
    return await withLeaseLock(mintsNewGeneration || quietPastMargin);

    async function withLeaseLock(holdState: boolean): Promise<Lease> {
      // Acquired BEFORE the state mutex, not nested inside it
      // (docomply-review, a reference-implementation pull request round 5): the first cut of this fix
      // nested the acquisition inside `underLocks`, below the state mutex
      // and `leaseLock` — so a NEW claimant waiting out an in-flight push
      // held the state mutex for the ENTIRE wait (up to
      // `LOCK_ACQUIRE_MAX_SEC`), blocking every OTHER `drive-state.ts`
      // mutation on this PR from ANY worktree — including a `claim-held`
      // fan-out's OTHER processes, and any already-admitted worktree's own
      // ordinary progress — behind a wait that has nothing to do with
      // them. Acquiring it first keeps the state mutex's own hold to what
      // it has always been: the brief read-decide-write section below, not
      // this wait. `guarded-push.ts` and `answer-summary-finding.ts` already
      // acquire this lock before anything else they hold, for the identical
      // reason; this makes every acquirer of `prRemoteMutationLock`
      // consistent about taking it FIRST, which is also what rules out a
      // new deadlock — see the lock-ordering note beside `treeLeaseLock`'s
      // own definition.
      //
      // Bounded the same way every OTHER acquisition in this module is —
      // `acquire()`'s own `limit` is `Math.min(LOCK_ACQUIRE_MAX_SEC,
      // $DRIVE_PR_LOCK_TIMEOUT ?? 30, …)`, so `LOCK_ACQUIRE_MAX_SEC` is
      // ALREADY the ceiling on every call regardless of whether it is
      // passed explicitly here — passing it changes nothing (it can only
      // ever LOWER `acquire()`'s own `maxWaitSec` term, never raise the
      // other two — see that function's own comment). It is passed anyway,
      // to say what this call intends rather than lean on that being true
      // of the current implementation.
      //
      // What genuinely differs from a bare `acquire()` is the CATCH below.
      // Contention on THIS lock, unlike the ordinary case `acquire()`'s own
      // generic timeout message is written for, can legitimately still be
      // live past whatever bound applied — a `git push` can run for the
      // whole of `$DRIVE_PR_PUSH_TIMEOUT` (an hour, by default) — so a
      // timeout here is not necessarily "wedged" the way it is everywhere
      // else `acquire()` throws. Reported as the SAME exit 11 every other
      // live-foreign-driver refusal in this module uses, with that
      // distinction spelled out, rather than `acquire()`'s own generic
      // exit 1 — which would read as a stuck lock rather than as the
      // outcome this actually is: another worktree is still actively
      // finishing an irreversible mutation. The residual this does NOT
      // close — a genuinely hour-long push can still outlast whatever this
      // call ends up bounded to, and a claim landing in that window is
      // refused rather than admitted after truly waiting the mutation
      // out — is the same one every other lock in this module accepts and
      // states rather than hides (see `LOCK_ACQUIRE_MAX_SEC`'s own doc).
      const remoteLock = holdState ? prRemoteMutationLock(stateDir, pr) : null;
      if (remoteLock !== null) {
        try {
          await remoteLock.acquire(LOCK_ACQUIRE_MAX_SEC);
        } catch (e) {
          // Never acquired, so nothing for `release()` to give back — but
          // `createLock` registers this handle's process-exit/signal
          // listeners unconditionally at construction, not on a successful
          // acquire, so `dispose()` still has real cleanup to do here
          // (docomply-review, a reference-implementation pull request round 1).
          remoteLock.dispose();
          // `LockAcquireTimeoutError` specifically, NOT the broader
          // `ExitError` every `acquire()` failure is (docomply-review, PR
          // #4164 round 3): `acquire()` also throws a plain `ExitError(1)`
          // when it wins the `mkdir` but then fails to create its
          // ownership marker (`EACCES`, `ENOSPC`, a read-only filesystem)
          // — an infrastructure failure with no rival holder involved at
          // all. Relabeling THAT as "another worktree has a mutation in
          // flight" would tell a human or an orchestrator to wait it out
          // instead of surfacing the broken state directory. Only the
          // deadline-exceeded case this lock genuinely waited out gets
          // converted to the live-contention exit 11 below; anything else
          // keeps its own exit code and message untouched.
          if (!(e instanceof LockAcquireTimeoutError)) throw e;
          fail(
            11,
            `drive-state.ts: PR #${pr} has an irreversible remote mutation (a push or a posted reply) in flight from another worktree, and it has not cleared yet.`,
            "",
            "Refusing this claim rather than admit alongside it — the identical",
            "cross-shipping hazard this PR-wide lock exists to close.",
            "This is not necessarily wedged: a push can legitimately run for the",
            "whole of $DRIVE_PR_PUSH_TIMEOUT (an hour, by default, pre-push hooks",
            "included), longer than this wait was bounded to. Retry once it",
            "completes.",
          );
        }
      }
      // Heartbeat `remoteLock`'s mtime for as long as it is held, starting
      // the instant it is acquired — including through `stateLock.acquire()`
      // and the whole of `underLocks()` below (docomply-review, a reference-implementation pull request
      // round 7): if `$DRIVE_PR_LOCK_STALE_MIN` is shorter than the time
      // those two genuinely take — an operator-shortened staleness window,
      // or ordinary contention on `stateLock`/`leaseLock` from a `claim-held`
      // fan-out — a contending `acquire()` elsewhere could otherwise treat
      // this still-live hold as abandoned and break it before the admission
      // write ever runs, reopening the exact overlap this lock exists to
      // prevent. The two remote-mutation callers (`guarded-push.ts`,
      // `answer-summary-finding.ts`) already heartbeat for the identical
      // reason across their own, longer-running mutation.
      const remoteLockHeartbeat =
        remoteLock === null
          ? null
          : setInterval(() => remoteLock.touch(), lockHeartbeatMs());
      const stateLock = holdState
        ? createLock(
            join(stateDir, `drive-pr-${pr}.json`),
            "drive-state.ts",
            pr,
          )
        : null;
      // Wrapped: `stateLock.acquire()` can itself throw (contention past its
      // own bound, or a broken lock directory), and it sits BEFORE the
      // `try/finally` below that would otherwise clean up. Left unguarded,
      // a throw here left `remoteLockHeartbeat` running and `remoteLock`
      // held forever — `runMain` only ever sets `process.exitCode`, never
      // calls `process.exit()`, so a live `setInterval` keeps the event
      // loop (and therefore the whole CLI process) alive indefinitely,
      // continuing to heartbeat a lock that guards every later claim,
      // push, or POST for this PR until something external kills the
      // process (docomply-review, a reference-implementation pull request round 8).
      if (stateLock) {
        try {
          await stateLock.acquire();
        } catch (e) {
          if (remoteLockHeartbeat !== null) clearInterval(remoteLockHeartbeat);
          stateLock.dispose();
          if (remoteLock !== null) {
            remoteLock.release();
            remoteLock.dispose();
          }
          throw e;
        }
      }
      try {
        return await underLocks(holdState);
      } finally {
        if (remoteLockHeartbeat !== null) clearInterval(remoteLockHeartbeat);
        if (stateLock) {
          stateLock.release();
          stateLock.dispose();
        }
        if (remoteLock !== null) {
          remoteLock.release();
          remoteLock.dispose();
        }
      }
    }

    async function underLocks(holdState: boolean): Promise<Lease> {
      const lock = leaseLock(path, pr);
      await lock.acquire();
      try {
        const held = readLease(path);
        const mine = held !== null && isMine(held, session, actor);
        // The unlocked peek can be wrong in the direction that matters: a lease
        // that looked alive (or looked ours) may have died between that read and
        // this one, which would take it over WITHOUT the state mutex — the same
        // hole, merely narrower. Restart under both locks instead. Bounded at one
        // retry: the second pass already holds the state mutex, so this branch
        // cannot be reached again. Releasing before re-acquiring keeps the
        // state → lease order intact; upgrading in place would invert it.
        //
        // The margin clause is the PR-wide gate's share of the same hazard: the
        // unlocked peek may have read a `lastSeen` that was inside the freshness
        // margin and is outside it by now (the peek is not instantaneous — a lock
        // acquisition sits between them). Re-deciding on the LOCKED read is what
        // keeps "skipped the check because we were comfortably fresh" true of the
        // moment the lease is actually written, rather than of a stale snapshot.
        if (
          !holdState &&
          (held === null ||
            (!mine &&
              (!leaseAlive(held) || isRecycledPid(held, session, actor))) ||
            Date.now() - Date.parse(held.lastSeen) > leaseFreshMarginMs())
        ) {
          lock.release();
          lock.dispose();
          return await withLeaseLock(true);
        }
        if (held !== null && !mine) {
          // `isRecycledPid` overrides `leaseAlive` here for the same reason it
          // overrides it in `mintsNewGeneration` above: once `held.pid ===
          // session.pid`, `leaseAlive`'s pid check is asking whether THIS
          // process is running, which is tautologically true and says nothing
          // about the dead predecessor `isMine` has already proven wrote `held`.
          if (leaseAlive(held) && !isRecycledPid(held, session, actor)) {
            fail(
              11,
              `drive-state.ts: PR #${pr} is already being driven from this working tree by another session (${leaseHolderLabel(held)}).`,
              `It took the lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
              "",
              "Two drivers in ONE tree share one actor id, so their holds overwrite each",
              "other and every thread ends up with two outcome replies — which is not",
              "repairable once posted. Refusing to be the second.",
              "",
              // Host-qualified on purpose: a pid is only meaningful on the host it
              // lives on, so an unqualified check run here would answer about an
              // unrelated local process and could read as "gone" for a lease that
              // is genuinely live elsewhere — the one mistake this refusal must
              // not invite. `pidAlive` already refuses to judge a foreign host for
              // the same reason. `pidCheckCommand` owns both that qualification
              // and the platform spelling (`ps -p` vs PowerShell's `Get-Process`).
              leaseLivenessHint(held),
              `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
              `Otherwise the lease clears itself once that session has left drive state`,
              `untouched for ${leaseStaleMin()}m.`,
            );
          }
          console.error(
            isRecycledPid(held, session, actor)
              ? `drive-state.ts: took over a drive lease on PR #${pr} whose pid (${held.pid}) the OS has recycled for this new, unrelated session (previous session last mutated drive state ${ageLabel(held.lastSeen)}).`
              : `drive-state.ts: took over an abandoned drive lease on PR #${pr} (${leaseHolderLabel(held)} — gone or idle since ${held.lastSeen}).`,
          );
        }
        // The PR-WIDE gate, run only on the path that holds the state
        // mutex — which is every path that could newly grant this tree the PR, by
        // the construction above. AFTER the per-tree refusal, so a session that
        // has both problems is told about the one in its own tree first: it is
        // the nearer fact and the one it can act on where it stands.
        //
        // Before the write, never after. A refusal that had already installed
        // this tree's lease would leave a live foreign lease of its own behind —
        // visible to `lease --all`, blocking `reset`, and, worse, one this
        // session's NEXT command would fast-path off without ever re-reaching
        // this check. Refusing first means a refused tree holds nothing.
        if (holdState) assertNoForeignDrive(stateDir, pr, actor);
        // The PR-wide remote-mutation lock is already held by
        // this point — `withLeaseLock`, above, acquires it BEFORE this
        // function's own state mutex and holds it through this entire
        // call, so the write below is protected without anything further
        // needed here. See that function's own comment for why it moved
        // there (docomply-review, a reference-implementation pull request round 5) and what it closes.
        const now = new Date().toISOString();
        const lease: Lease = {
          holder,
          // `session.pid` is already 0 on the tier-3 path (`resolveSession`
          // returns it), so `holder` and `pid` agree by construction rather than
          // by this site remembering to zero one of them — which is the
          // correspondence `parseLease` then refuses to read a record without.
          pid: session.pid,
          host: session.host,
          platform: process.platform,
          actor,
          worktree,
          // Preserved across renewals so the refusal can say how long the holder
          // has been driving, not merely when it last touched anything.
          startedAt: mine && held !== null ? held.startedAt : now,
          lastSeen: now,
          command,
          // Same preserve-or-regenerate rule as `startedAt`: a renewal by this
          // session keeps the admission its siblings were granted under, while
          // any takeover — including a same-session reclaim after the file was
          // cleared, where `mine` is false because there is nothing to be mine —
          // mints a new one and invalidates every outstanding admission.
          generation:
            mine && held !== null
              ? held.generation
              : randomBytes(16).toString("hex"),
          // Not preserve-or-regenerate like `generation` — this is simply
          // WHATEVER session is writing right now, which is correct on every
          // path (renewal, takeover, or fresh creation): the token identifies
          // the OS session holding the lease, not an admission epoch, and it is
          // stable for that session's whole lifetime by construction
          // (`drive.ts` mints it once and every pass it spawns inherits it
          // unchanged). See `Lease.sessionStarted`.
          sessionStarted: session.sessionStarted,
        };
        atomicWrite(path, `${JSON.stringify(lease, null, 2)}\n`);
        return lease;
      } finally {
        lock.release();
        lock.dispose();
      }
    }
  }
}

/**
 * The admission fence: is the lease this command was admitted on STILL the one
 * on disk, now that it finally holds the state mutex?
 *
 * Admission and mutation are not the same instant. `claimLease` returns, and
 * the command then queues for the state lock — for up to `LOCK_ACQUIRE_MAX_SEC`.
 * Everything that can revoke its admission happens in that gap, in another
 * process, silently: `reset`'s sweep, an operator's `clear-lease` (documented
 * for taking over a lease whose holder they believe is gone), a takeover after
 * the owning pid exits, or the staleness expiry. Preserving live leases in
 * `clearAllLeases` covers the first of those and nothing else, and no
 * wall-clock rule can cover the dead-pid path at all — `leaseAlive` goes false
 * the instant the agent process exits, while the child it already spawned is
 * still queued and will still mutate.
 *
 * So the check is here, at the only point that sees the lease as it stands when
 * the mutation is about to run. `generation` is the token: a random nonce,
 * preserved across one session's renewals and reminted by every takeover, so
 * comparing (pid, host, generation) distinguishes "my lease, renewed" from
 * "someone else's lease now". A missing file is a takeover too — that is the
 * swept case.
 *
 * NOT `startedAt`, which this first used: ISO text resolves to the millisecond,
 * so a `clear-lease` and a same-session reclaim inside one millisecond produce
 * an identical tuple and the fence would wave through a lease that had actually
 * been revoked and recreated (docomply-review round 8).
 *
 * One window this deliberately does NOT close: the check and the write are not
 * themselves atomic against revocation, because `clearLease` takes only the
 * lease mutex. `clear-lease` closes that by taking the state mutex too — see
 * its own comment — which is the coordination that makes this check hold
 * through the mutation rather than merely at its start.
 *
 * Fails closed, with exit 11 like every other lease refusal: the mutation has
 * not run, so refusing costs a re-run, while proceeding is the same-actor
 * double-write this module exists to prevent.
 */
export function assertLeaseUnchanged(
  stateDir: string,
  pr: string,
  admitted: Lease,
): void {
  const held = readLease(leasePathFor(stateDir, pr, admitted.actor));
  if (
    held !== null &&
    held.pid === admitted.pid &&
    held.host === admitted.host &&
    held.generation === admitted.generation
  ) {
    return;
  }
  fail(
    11,
    `drive-state.ts: PR #${pr}'s drive lease was taken over while this command waited for the state lock.`,
    held === null
      ? "The lease this command was admitted on is gone — swept by `reset`, or dropped by `clear-lease`."
      : `It now belongs to ${leaseHolderLabel(held)} (since ${held.startedAt}).`,
    "",
    "Refusing to mutate: the session that took it over may already be working,",
    "and two writers under one actor overwrite each other’s holds and",
    "double-reply every thread. Nothing was written.",
    "",
    "Re-run the command if you still hold the drive; the takeover is only",
    "authoritative if that other session is genuinely driving this PR.",
  );
}

/**
 * `assertLeaseUnchanged`'s counterpart for the TREE lease: is the
 * tree-wide lease this command was admitted on still the one on disk, now
 * that it finally holds the state mutex?
 *
 * Needed for the identical reason `assertLeaseUnchanged` is: admission and
 * mutation are not the same instant, and everything that can revoke a tree
 * lease's admission — a takeover once its holder goes stale, an operator's
 * `clear-lease` — happens in the gap between admission (`claimTreeLease` for
 * an identified session, `claimSessionlessTreeLease` for tier 3)
 * returning and the command's queued mutation actually running. Either
 * writer's own state-mutex coordination during a takeover (see its own
 * comment) closes that gap only for a takeover that targets the SAME pr an
 * in-flight command is mid-mutation on; a takeover for a DIFFERENT pr in
 * this tree is not ordered against that command at all, and THIS fence is
 * what catches it — run alongside `assertLeaseUnchanged` inside every locked
 * section (`drive-state.ts`'s `LEASED_COMMANDS` wiring), never on its own —
 * the two questions are independent and a command that fails either must not
 * proceed.
 */
export function assertTreeLeaseUnchanged(
  stateDir: string,
  actor: string,
  admitted: TreeLease,
): void {
  const held = readTreeLease(treeLeasePathFor(stateDir, actor));
  if (
    held !== null &&
    held.pid === admitted.pid &&
    held.host === admitted.host &&
    held.generation === admitted.generation
  ) {
    return;
  }
  fail(
    11,
    `drive-state.ts: this working tree's TREE lease (admitted for PR #${admitted.pr}) was taken over while this command waited for the state lock.`,
    // Named ONLY as "gone" — not attributed to `clear-lease` specifically.
    // That was this module's own most-visible way to reach `held === null`,
    // but not the only one: an operator can `rm` the file directly (the
    // documented remedy for unreadable debris), and a same-session
    // rollback can delete it too.
    // Naming a SPECIFIC cause this fence cannot actually verify would mislead
    // more than it helps (docomply-review, a reference-implementation pull request round 6).
    held === null
      ? "The lease this command was admitted on is gone."
      : `It now belongs to ${leaseHolderLabel(held)} (since ${held.startedAt}, PR #${held.pr}).`,
    "",
    "Refusing to mutate: the session that took it over may already be working,",
    "and two writers in one tree can cross-ship uncommitted edits.",
    "Nothing was written.",
    "",
    "Re-run the command if you still hold the drive; the takeover is only",
    "authoritative if that other session is genuinely driving this tree.",
  );
}

/**
 * Everything the external-mutation fence needs to decide, or `null` when no
 * drive lease can exist here AT ALL — in which case there is nothing to fence
 * and the caller proceeds unchanged.
 *
 * `null` means exactly one thing: NOT A GIT REPOSITORY. Drive state lives in
 * the git dir, so outside a worktree there is no state directory a lease could
 * sit in, and `git` exiting non-zero here is a definite answer rather than a
 * failed read.
 *
 * A `git` that TIMES OUT is not that answer, and it is the one input this
 * cannot read: it throws (exit 1) rather than returning `null`, because a
 * fence that silently allows on a blind read has verified nothing while
 * reporting that it has (`.claude/rules/document-scanning-gates.md` rule 1).
 * The mutation this guards is unwithdrawable, so the cost of failing closed is
 * a re-run and the cost of failing open is a duplicate outcome reply on a live
 * thread.
 *
 * NOTE the session ladder's tier 3 is NOT a `null` here — this fence still
 * runs for it. `claimLease` now DOES let tier 3 take a durable exclusion
 *: a `holder: 'worktree'` presence lease, keyed by actor rather
 * than pid, so two sessionless resolvers on the same PR still refuse each
 * other. `isMine` recognizes that record as this tree's own (comparing
 * `actor`, since a tier-3 record carries no usable pid), so this fence still
 * passes a tier-3 caller's OWN lease and refuses only a genuinely FOREIGN
 * one. Skipping the check entirely here would have exempted exactly the
 * harnesses that cannot be told apart from a second session in the same
 * tree.
 *
 * `$DRIVE_PR_STATE_DIR` short-circuits the repository probe entirely, matching
 * `resolveStateDir`: a caller that named the directory has asserted it exists,
 * and unlike `resolveStateDir` this fence VERIFIES that assertion — the fence
 * has no later write to fail loudly against if it was wrong, so an unverified
 * override is a silent fail-open the moment the asserted directory is gone.
 * `resolveActor` still has to answer, and still refuses outside a worktree —
 * a fence that cannot say WHICH tree it is in cannot read the right lease.
 */
export async function resolveFenceContext(label: string): Promise<
  | {
      stateDir: string;
      actor: string;
      session: Session;
      fromOverride: true;
      overrideEntries: string[];
      stateDirIdentity: DirIdentity;
    }
  | {
      stateDir: string;
      actor: string;
      session: Session;
      fromOverride: false;
      /**
       * The raw `--git-common-dir` this branch's `stateDir` was derived
       * from — carried so `assertRemoteMutationAllowed` can re-run
       * `resolveLegacyFallbackDir` live, immediately before it trusts
       * `stateDir`, instead of trusting this snapshot's decision
       * unconditionally (see `resolveLegacyFallbackDir`'s own comment).
       */
      legacyStateDirForFallback: string;
    }
  | null
> {
  const session = resolveSession(label);
  const override = process.env.DRIVE_PR_STATE_DIR ?? "";
  // Matching `resolveStateDir`'s own guard (store.ts): this function reads
  // the raw env var directly rather than going through that function, so a
  // relative override reaching THIS fence would resolve against whichever
  // directory this process happened to launch from — the base checkout and
  // a linked worktree launching from different cwds would silently fence
  // against two different directories (docomply-review + chatgpt-codex-
  // connector, PR #4612 round 4).
  if (override !== "" && !isAbsolute(override)) {
    fail(
      2,
      `${label}: $DRIVE_PR_STATE_DIR must be an absolute path, got: ${override}`,
      "A relative override resolves against the current working directory,",
      "so two participants launched from different directories (the base",
      "checkout and a linked worktree, in particular) would silently fence",
      "against two different state directories.",
    );
  }
  let stateDir = override;
  if (stateDir !== "") {
    // Resolved BEFORE the enumeration below, not after: an `await` here — and
    // everything `worktreeKey()` does under it — sitting BETWEEN a check and a
    // LATER, separate enumeration is exactly the gap a successor driver can
    // move the git common dir inside of. Awaiting first makes everything from
    // here on purely synchronous.
    const actor = await resolveActor();
    // An inherited override asserts this directory ALREADY exists — `drive.ts`
    // exports it only after resolving its own state dir, which by then holds
    // at least this drive's own lease. Its disappearance (a renamed git common
    // dir, a moved worktree) is therefore an anomaly, not the ordinary
    // "no drive has ever run here" case a fresh, never-driven tree gets.
    //
    // ENUMERATED here, not merely `statSync`'d — and the RESULT carried
    // forward for `assertRemoteMutationAllowed` to filter in-memory, rather
    // than re-ENUMERATING the directory later. Two rounds of narrowing a
    // check-then-later-use gap (statSync ordering, then an `ENOENT`-only
    // indeterminate flag on the later read) both left a real window open:
    // renaming this directory away and creating an EMPTY one at the same
    // pathname raises no `ENOENT` anywhere, so an `ENOENT`-keyed check cannot
    // see it — the enumeration would simply, and wrongly, read as confirmed
    // empty (chatgpt-codex-connector, a reference-implementation pull request round 13). Freezing the NAME
    // LIST here closes that half: a rename-and-recreate cannot inject or hide
    // a name this fence reasons about, because the list was already fixed
    // before it could land.
    //
    // It does NOT close the CONTENT half, and an earlier version of this
    // comment overclaimed that it did ("there is no later moment left for it
    // to target"): `assertRemoteMutationAllowed` still has to OPEN each
    // candidate afterwards to learn who holds it, and that per-file read is
    // unavoidably a second, genuine filesystem touch against this same path —
    // the file this enumeration saw may no longer be reachable there if the
    // directory itself was swapped, and `readLeaseForFence` would then report
    // `absent` for a lease that is still live in the directory that moved
    // (docomply-review, a reference-implementation pull request round 14, finding A — a swap landing DURING
    // this fence; finding C's before-the-pass swap is a different window,
    // closed by the inherited driver baseline further below, not by this).
    // `stateDirIdentity` below is what closes THAT:
    // captured in the same breath as this enumeration, and re-confirmed by
    // `assertStateDirIdentityUnchanged` before any later `absent` read is
    // trusted, and once more immediately before the post is authorized. A
    // rename-and-recreate landing between here and either of those checks now
    // fails closed instead of reading as an all-clear — narrowing the
    // residual to the gap between that LAST identity check and the actual
    // GitHub POST, which is the module header's own "check and post are two
    // moments" residual, not a new one.
    // Opening bracket: the identity BEFORE the listing. Capturing only
    // afterwards would describe whatever directory is at this path by then, so
    // a swap landing between the listing and that capture would be measured
    // against the replacement rather than against what was actually
    // enumerated (chatgpt-codex-connector, a reference-implementation pull request round 15). This matters
    // here even when a driver baseline IS inherited, and it is the ONLY
    // protection for this window when one is not.
    const beforeEnumeration = statDirIdentity(stateDir);
    let overrideEntries: string[];
    try {
      overrideEntries = readdirSync(stateDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      fail(
        1,
        `${label}: the inherited drive state directory could not be read (${code ?? String(e)}):`,
        `  ${stateDir}`,
        "",
        "Refusing to post. $DRIVE_PR_STATE_DIR asserts this directory already",
        "holds this drive's own state, so a failure to enumerate it now is not",
        'the ordinary "no drive has run here" case — something moved, removed,',
        "or replaced it, and whether another session still holds this tree's",
        "lease is now unknown.",
      );
    }
    // Captured immediately after the enumeration succeeds, not merely
    // "nearby": an `lstat` that fails here, right after a `readdirSync` on the
    // very same path just succeeded, is itself the anomaly this override
    // branch already refuses on above — the directory was asserted to exist,
    // so failing to confirm its identity now is not the ordinary case either.
    const stateDirIdentity = statDirIdentity(stateDir);
    if (stateDirIdentity === null) {
      fail(
        1,
        `${label}: the inherited drive state directory's identity could not be confirmed right after listing it:`,
        `  ${stateDir}`,
        "",
        "Refusing to post. This directory was just enumerated successfully, so an",
        "identity check failing immediately afterwards means it is being torn down",
        "or replaced right now — exactly the moment a live lease inside it must not",
        "be read as absent (PR #4107).",
      );
    }
    // Closing bracket: the listing above is only trustworthy if it was taken
    // from one stable directory. A mismatch here means it was not, and no
    // later check can repair a name list read from a directory that has since
    // been swapped away.
    if (!sameDirIdentity2(beforeEnumeration, stateDirIdentity)) {
      fail(
        1,
        `${label}: the inherited drive state directory was replaced while it was being listed:`,
        `  ${stateDir}`,
        "",
        "Refusing to post. The name list this fence would judge from was not taken",
        "from a single, stable directory, so a lease it did not see may still be live",
        "in the directory that moved (PR #4107).",
      );
    }
    // The baseline the DRIVER observed, before this pass existed. Everything
    // above proves the directory did not change during this fence; only this
    // can prove it did not change BEFORE it — a rename-and-recreate that
    // completed before the pass started leaves a replacement whose identity
    // is perfectly stable from here on, so a fence that only watches itself
    // reads it as an all-clear (chatgpt-codex-connector, a reference-implementation pull request round 14,
    // finding C).
    //
    // REQUIRED on this path, not optional. This branch is reached only when
    // `$DRIVE_PR_STATE_DIR` is set, and `drive.ts` is the only thing that sets
    // it — and since round 16 it either exports the identity beside it or
    // refuses to start. So a state-dir override arriving WITHOUT an identity
    // can only come from a driver predating that change, and treating it as
    // "no baseline, carry on" is a compatibility path for superseded code
    // that permanently preserves the unfenced pre-baseline behaviour — which
    // the pre-GA stance rules out (`CLAUDE.md` § Backward Compatibility;
    // docomply-review and chatgpt-codex-connector, a reference-implementation pull request round 16).
    //
    // An earlier revision justified the absent case with "an interactive
    // session". That was simply wrong: an interactive session sets no
    // override and never reaches this branch at all — it takes the
    // non-override path below, where "never existed" is the ordinary case and
    // stays allowed. Nothing legitimate is refused here.
    //
    // Present but unparseable → something set it and this process cannot tell
    // what it meant, which is the question going unanswered in front of a
    // mutation with no undo, so it refuses.
    const inherited = parseDirIdentityToken(
      process.env.DRIVE_PR_STATE_DIR_IDENTITY ?? "",
    );
    if (inherited.kind === "absent") {
      fail(
        1,
        `${label}: $DRIVE_PR_STATE_DIR is set but $DRIVE_PR_STATE_DIR_IDENTITY is not:`,
        `  ${stateDir}`,
        "",
        "Refusing to post. A state-directory override asserts a drive resolved this",
        "path, and every current driver exports the directory identity beside it —",
        "so an override arriving without one means this pass cannot tell whether the",
        "directory was already swapped before it started. Re-run through a current",
        "drive.ts, or unset $DRIVE_PR_STATE_DIR to use the ordinary path (PR #4107).",
      );
    }
    if (inherited.kind === "bad") {
      fail(
        1,
        `${label}: $DRIVE_PR_STATE_DIR_IDENTITY is set but not a '<dev>:<ino>' pair:`,
        `  ${process.env.DRIVE_PR_STATE_DIR_IDENTITY}`,
        "",
        "Refusing to post. This variable is the driver-established baseline that",
        "proves the inherited state directory was not swapped before this pass",
        "started; an unreadable one is that proof going missing, not an all-clear",
        "(PR #4107).",
      );
    }
    if (
      inherited.kind === "ok" &&
      !sameDirIdentity(inherited.id, stateDirIdentity)
      // `kind === 'absent'` and `'bad'` are already refused above, so this is
      // the only case left to compare — kept as an explicit narrowing rather
      // than an assertion, so a future third kind fails the type-check here
      // instead of silently falling through to "allowed".
    ) {
      fail(
        1,
        `${label}: the inherited drive state directory is not the one this drive resolved:`,
        `  ${stateDir}`,
        "",
        "Refusing to post. Its on-disk identity differs from the baseline the driver",
        "exported, so the directory at this path was replaced at some point before",
        "this check ran — the leases this pass would read are not the leases the",
        "drive wrote, and a live one may still sit in the directory that moved",
        "(PR #4107).",
      );
    }
    return {
      stateDir,
      actor,
      session,
      fromOverride: true,
      overrideEntries,
      stateDirIdentity,
    };
  }
  if (stateDir === "") {
    const r = await git(["rev-parse", "--git-common-dir"], {
      stderr: "ignore",
      timeoutSec: gitCallTimeoutSeconds(),
    });
    // A SUCCESSFUL git is the only thing that names the state dir. Every
    // failure — a spawn that never ran, a deadline, any fatal, or an exit 0
    // that named nothing — falls through to the one question that can still be
    // answered soundly: is there a repository here at all?
    //
    // Reading a failure as "no drive state" is a fail-open, and a reproduced
    // one: `PATH=/nonexistent` made the spawn fail and this permitted the POST
    // with no lease checked (chatgpt-codex-connector, a reference-implementation pull request round 1).
    // Reading git's exit 128 as "no repository" is the SAME fail-open one step
    // narrower, because 128 is git's generic fatal status — see
    // `repositoryIsInPlay`, which is why that question is now answered from the
    // filesystem rather than from git's exit code.
    stateDir = r.code === 0 ? r.stdout.trim() : "";
    if (stateDir === "") {
      // No repository FOUND, and therefore no lease this process can read:
      // nothing here could have written one, whatever git's reason for not
      // answering. This is the standalone `/resolve-review-comments` case, and
      // the ONLY thing that may still post.
      //
      // "No repository found" is weaker than "provably no repository ever",
      // and the gap is the reachable one: a marker DELETED or RENAMED after a
      // drive wrote its lease produces a genuine `ENOENT`, which no filesystem
      // probe can tell apart from a tree that never held a repository
      // (docomply-review high, PR #4107 round 4). `repositoryIsInPlay` closes
      // the cases where the marker is still THERE but unreadable — a broken
      // symlink, an unsearchable ancestor — and cannot close these.
      //
      // What closes them is not a better probe but durable knowledge, which is
      // why `drive.ts` exports `$DRIVE_PR_STATE_DIR` to every pass it spawns:
      // the override above short-circuits this whole path, so a driven pass
      // reads the real lease no matter what happened to its `.git`. Since a
      // lease exists only because a drive wrote one, and a drive owns its
      // passes, that is the path where an unchecked lease could actually
      // double an outcome reply.
      //
      // RESIDUAL: an interactive session that claimed a lease and then lost
      // its marker has no driver to inherit that from, and nothing here
      // remembers the directory across processes. It is listed with the
      // module's other residuals rather than closed, because closing it needs
      // state kept outside the repository — a strictly larger design than the
      // fence, and one that would itself need a staleness story.
      if (!r.timedOut && !repositoryIsInPlay()) return null;
      fail(
        1,
        `${label}: git could not say where this clone's drive state lives (${r.timedOut ? "timed out" : r.code === 0 ? "exited 0 but named no directory" : `exited ${r.code}`}), and this IS a repository — so whether another session has taken its drive lease is unknown.`,
        "Refusing to post rather than answer that question by assuming: an outcome",
        "reply cannot be withdrawn once it is on the thread.",
        "",
        "Being outside a repository is a different case and still posts — there is",
        "no drive state anywhere for a lease to sit in. It is established from the",
        "filesystem, not from git's exit status, because 128 is git's generic fatal",
        "status and covers dubious ownership and corruption as well.",
      );
    }
    // `stateDir` here is the LEGACY `--git-common-dir` — `resolveStateDir()`'s
    // own default moved off it, so a fence that stopped here would
    // keep reading a location nothing writes to anymore while every other
    // consumer (including this same process's own lease writes) reads and
    // writes `~/.local/state/groundwork/drive-pr/<cloneKey>/`. A standalone command run
    // without `$DRIVE_PR_STATE_DIR` would then authorize a mutation without
    // ever seeing a live lease that exists only in the relocated directory
    // (docomply-review, a reference-implementation pull request round 6).
    //
    // NOT routed through `resolveStateDir()`'s own `ensureMigratedFromLegacy`
    // guard, on purpose: that guard is a HARD refusal for a clone with real
    // unmigrated legacy content, correct for a STATE WRITER (a fresh drive
    // must never silently start over an unmigrated clone's parked decisions)
    // but wrong for this lightweight, read-only fence, whose caller may have
    // nothing to do with drive-pr's own durable state at all. A first cut
    // that called it directly refused every standalone post on any clone
    // that had not yet run the one-time migration — which, before a human
    // runs it, is every clone in the fleet, an earlier change's own PR included
    // (measured against this repository's own real `.git`: a live worktree
    // with genuine pre-migration drive-pr history refused outright).
    //
    // Reasoned instead from what a REAL drive can and cannot do: `drive.ts`
    // calls `resolveStateDir()` at startup, so an unmigrated clone SHOULD
    // have no live drive running current code — starting one is blocked at
    // the same gate. But "no marker" does not perfectly prove that: an empty
    // legacy footprint makes `ensureMigratedFromLegacy` create `newDir` and
    // let the caller through WITHOUT the marker if its own best-effort
    // `writeFileSync(marker, '')` fails — deliberately, per that function's
    // own doc comment, so a transient write failure never blocks an
    // otherwise-clean resolution. A drive admitted that way writes its lease
    // into `newDir` while the marker stays absent, and a marker-only check
    // here would still fall back to `legacyDir` and miss it entirely
    // (docomply-review, a reference-implementation pull request round 7). `newDir` existing at all is the
    // other half of the signal: `ensureMigratedFromLegacy` always `mkdirSync`s
    // it before doing anything else, so its presence means at least one
    // caller reached this point — checking there too, not the marker alone,
    // is what a current-code writer can actually leave behind. Once
    // migrated, the canonical location (and therefore wherever a live lease
    // sits) is the new default; the fence follows it there. Only when
    // `newDir` has never been touched at all does the fallback still check
    // `legacyDir` — an old, older process is the only thing that
    // could be live there, the same residual `legacy-state.ts`'s own header
    // already accepts. Narrower still: a clone with REAL unmigrated content
    // whose only `resolveStateDir()` attempt so far hard-failed also leaves
    // `newDir` existing-but-empty, which this check cannot tell apart from
    // "a current-code drive is genuinely using it" — an old-code lease in
    // `legacyDir` at that exact intersection stays invisible. Accepted for
    // the same reason as the residual above: it needs a REAL old, un-upgraded
    // process racing a REAL unmigrated clone's very first resolution attempt,
    // not closable without checking both locations unconditionally, which
    // is a larger change than this fence's existing single-`stateDir`
    // contract supports today.
    const legacyDir = resolve(stateDir);
    stateDir = resolveLegacyFallbackDir(legacyDir);
    return {
      stateDir,
      actor: await resolveActor(),
      session,
      fromOverride: false,
      legacyStateDirForFallback: legacyDir,
    };
  }
  // Unreachable: the branch above always returns (directly, via `return null`,
  // or via `fail()`'s throw) once `override === ''`, which is the only way
  // execution reaches this point. Kept only because TypeScript's control-flow
  // analysis cannot see through `fail()`'s `never` return type combined with
  // the branches above to prove that on its own.
  throw new Error(
    "unreachable: resolveFenceContext fell through both branches",
  );
}

/**
 * How many times `assertRemoteMutationAllowed`'s lock-acquisition loop may
 * release-and-retry after `resolveLegacyFallbackDir` moves again post-
 * acquire. The decision is monotonic (legacyDir -> newDir, never back), so a
 * real clone needs at most one retry to converge; this only guards against a
 * defect turning that into a spin, not a case expected to fire in practice.
 */
const MAX_DIR_REFRESH_ATTEMPTS = 3;

/**
 * `legacyDir` vs its relocation, for the non-override fence path.
 * Extracted so `assertRemoteMutationAllowed` can re-run this SAME decision
 * live, right before its enumeration trusts it — see the call site's own
 * comment for why a single snapshot decision here is not enough on its own
 * (docomply-review, a reference-implementation pull request round 7, TOCTOU finding).
 *
 * `newDir` existing at all — not just its migration marker — counts as
 * "current-code drive has been admitted here": `ensureMigratedFromLegacy`
 * always `mkdirSync`s it before doing anything else, and its own marker
 * write is best-effort, so a drive can be legitimately using `newDir` with
 * the marker still absent (see the call site in `resolveFenceContext` for
 * the full argument).
 */
function resolveLegacyFallbackDir(legacyDir: string): string {
  // `peekDefaultStateDirFor`, never `defaultStateDirFor`: this fence is
  // documented (see the call site below) as lightweight and read-only, and
  // `defaultStateDirFor` calls `cloneKey`, which MINTS and durably persists
  // a fresh clone identity the first time it runs on a clone that has none
  // yet — a real, on-disk side effect a read-only check must not have
  // (docomply-review, a reference-implementation pull request round 8; the same argument `peekCloneKey`'s
  // own doc already makes for `migrate-legacy-state.ts`'s dry-run path). `null`
  // means no identity has ever been minted for this clone — which means
  // nothing could possibly have been admitted into `newDir` either, since
  // admission is what mints the identity in the first place — so the
  // fallback to `legacyDir` below is exact, not a guess.
  const newDir = peekDefaultStateDirFor(legacyDir);
  if (newDir === null) return legacyDir;
  // The migration marker is the ONLY unconditional proof: it is published
  // once, by a completed migration, never by a failed or in-progress one
  // (`publishMigratedMarker` in `migrate-legacy-state.ts`), so its presence
  // alone is trustworthy regardless of what `legacyDir` currently holds.
  if (existsSync(migratedMarkerPath(newDir))) return resolve(newDir);
  // Past this point the marker is ABSENT, and `newDir` existing on its own
  // is NOT reliable proof anything is genuinely using it: both
  // `ensureMigratedFromLegacy` and `migrate-legacy-state.ts --apply`
  // `mkdirSync(newDir)` BEFORE scanning `legacyDir`'s footprint and
  // possibly refusing — so an empty `newDir` is exactly as consistent with
  // "a current-code drive is admitted here" as with "an admission attempt
  // was refused moments ago and never wrote anything". Trusting the bare
  // `existsSync(newDir)` in that second case would select the empty
  // directory and never look at `legacyDir` at all, missing a genuine
  // old-code (or newly-refused) lease sitting there (docomply-review, PR
  // #4618 round 9 — round 8's "prefer empty newDir" refinement fixed the
  // symmetric case but left this unconditional check itself unfixed).
  //
  // The one signal that tells the two apart without checking both
  // directories on every call: whether `legacyDir` itself still holds real
  // content. Empty means there is nothing there to miss either way, so
  // `newDir` — existing already, or fresh — is safe to prefer. Non-empty
  // means something might depend on it, so `legacyDir` stays authoritative
  // until either the marker publishes or that content clears.
  if (legacyFootprint(legacyDir).length === 0) {
    // `mkdirSync`, not a bare read: a lock acquired inside a directory that
    // does not exist yet has nowhere to write its file and spins for the
    // full acquire timeout instead of failing fast, since the underlying
    // primitive cannot tell "contended" apart from "the parent doesn't
    // exist" cheaply. Creating an EMPTY directory is not the minting side
    // effect this function exists to avoid — no identity is invented, and
    // `ensureMigratedFromLegacy` would create this exact directory moments
    // later for any real admission anyway; recursive because nothing
    // upstream of `.local/state/groundwork/` is guaranteed to exist either. A no-op when
    // `newDir` already existed.
    mkdirSync(newDir, { recursive: true });
    return resolve(newDir);
  }
  return legacyDir;
}

/**
 * The fence over an IRREVERSIBLE external mutation: may this session still
 * post to GitHub for this drive?
 *
 * `assertLeaseUnchanged` cannot serve here. It compares an ADMITTED lease, and
 * the callers — `reply-to-thread.ts` and `answer-summary-finding.ts` — hold
 * none: they are fresh processes that never claimed one, which is exactly why
 * they used to meet the lease only afterwards, at the `drive-state.ts hold`
 * that records what they already posted. So this asks the one question that can
 * be answered without an admission token: is SOMEONE ELSE now driving this
 * working tree?
 *
 * Refuses on a lease that is neither ours nor abandoned, and on a lease file it
 * cannot read at all. The cases that proceed are each deliberate:
 *
 *   - NO LEASE FILE. Not a refusal, by design (an earlier change's own statement of
 *     desired behaviour): `/resolve-review-comments` is usable standalone, and
 *     a pass that has not yet run a mutating `drive-state.ts` command
 *     legitimately holds no lease — the first reply of a round, answering a
 *     `rejected` finding, happens before anything is held.
 *   - THE LEASE IS OURS. Matched by `isMine` on (pid, host) and — when this
 *     caller carries one — `sessionStarted`, not on `generation`: a renewal
 *     preserves the generation and a takeover mints a new one, but this
 *     caller has no earlier generation to compare either against. What it can
 *     prove is that the session named on disk is this one. A tier-3 caller
 *     matches on a different basis entirely — its record names a TREE, so
 *     `isMine` compares actors and never consults the session fields (*     and see that function for why the two cases must not share a test).
 *
 *     CLOSED for the common case (PR #4107 finding B): `$DRIVE_PR_SESSION`
 *     names a pid inherited at spawn time, with nothing on its own to prove
 *     that pid still means what it did then. If this pass's own driver dies
 *     and the OS later recycles its exact pid for an unrelated replacement
 *     driver, a bare (pid, host) match would read the replacement's fresh
 *     lease as "ours" — skipping past it without ever reaching the
 *     `leaseAlive` check that would otherwise have refused a live, genuinely
 *     foreign session (chatgpt-codex-connector, a reference-implementation pull request round 8, originally
 *     reproduced). `isMine` now also requires `sessionStarted` to match
 *     whenever THIS caller carries one, and `drive.ts` always exports
 *     `$DRIVE_PR_SESSION_STARTED` alongside `$DRIVE_PR_SESSION` — so every
 *     pass it spawns carries a token a recycled pid cannot reproduce, and the
 *     replacement's differently-tokened lease is correctly read as foreign.
 *
 *     Narrower now, not gone: a caller that identifies via bare pid with NO
 *     accompanying token — a tier-2 `$CLAUDE_PID` session, or a hand-set
 *     `$DRIVE_PR_SESSION` per SKILL.md § 6 — has nothing to check and falls
 *     back to (pid, host) alone, same as before. Demanding a token there
 *     would answer false for every legitimate renewal under that
 *     configuration — the exact "stand-down" bug `drives.ts`'s
 *     `ownParentDriver` already documents avoiding — so this is not an
 *     oversight left to close later; it is the same trade that function
 *     makes, for the same reason.
 *   - A FOREIGN LEASE THAT IS NOT ALIVE. Its owner is gone or has stopped
 *     driving, so there is no second writer to double-post against. Refusing
 *     here would wedge a tree whose previous drive merely ended — the direction
 *     this module's header refuses to guess in.
 *
 * `pr` widens the search when the caller knows which PR it is posting to
 * (`answer-summary-finding.ts` does; `reply-to-thread.ts` holds a thread node
 * id and would have to spend a network round-trip to learn one) — PR-WIDE,
 * across every worktree that holds a lease for it, not just this tree's own.
 * A driver can legitimately move to a DIFFERENT tree (this one's died, a
 * successor started fresh elsewhere), and a pass left running in the OLD tree
 * must still see that successor's live lease to refuse correctly — the
 * actor-wide search below is blind to every OTHER tree's leases by
 * construction, so a detached pass finds only its own dead driver's lease,
 * refuses nothing, and posts alongside whoever is actually driving the PR now
 * (chatgpt-codex-connector, a reference-implementation pull request round 8). With no PR it checks every
 * lease THIS WORKING TREE holds instead — PR-wide is not answerable without a
 * network round-trip this hot-path fence does not spend — which is sound for
 * the reason `actor.ts` gives: at most one drive runs per tree, so a live
 * foreign lease in this tree is a second session in it whichever PR it names.
 *
 * Narrowing (either way) is a FILTER over the enumeration, never a direct
 * `leasePathFor` read, and the difference is the fail-closed one. `readLease`
 * answers `null` for a path that does not exist AND for a path it cannot
 * reach — a state directory that is unreadable, or not a directory at all,
 * produces exactly the same "no lease" as a tree that has never been driven.
 * Enumerating first makes an unreadable state directory throw
 * (`leaseFilesForActor` and `leaseFilesFor` both re-raise anything that is
 * not `ENOENT`), so neither scoped path can pass a blind read off as an
 * all-clear.
 *
 * The same argument one level down is why the per-file read goes through
 * `readLeaseForFence` rather than `readLease`: an unreadable DIRECTORY was
 * fenced while an unreadable FILE inside it still read as "no lease" and
 * permitted the post (docomply-review, a reference-implementation pull request round 1). Fixing the
 * enumeration and leaving the record was the instance, not the class.
 */
/**
 * Re-enumerate the override directory's lease-file names AFTER
 * `assertRemoteMutationAllowed` has (possibly) waited on `remoteLock`
 *.
 *
 * `ctx.overrideEntries` is captured once by `resolveFenceContext`, called by
 * the CALLER before this function ever runs — sound when `checkAllowed`
 * used it essentially back-to-back, which is what every round-13/14/15 fix
 * above assumed. This PR's own `remoteLock.acquire` breaks that assumption:
 * it can wait up to `LOCK_ACQUIRE_MAX_SEC` for a REPLACEMENT claimant to
 * finish writing its own lease and release the lock, and trusting the
 * pre-wait snapshot after that wait reads the replacement's freshly-written
 * lease as `absent` — the exact handoff race this whole lock exists to
 * close, reopened one level up by the wait itself.
 *
 * The non-override path needs no equivalent fix: its own enumeration
 * (`leaseFilesForActor` / `leaseFilesFor`) runs LIVE, inside `checkAllowed`
 * itself, which is already called after the wait — there is no earlier
 * snapshot for it to go stale relative to.
 *
 * Mirrors `resolveFenceContext`'s own override-branch enumeration: a fresh
 * `readdirSync`, bracketed before/after by `statDirIdentity` so a
 * rename-and-recreate landing DURING this re-enumeration is caught rather
 * than silently read as an empty directory — and the result is ALSO
 * compared against the ORIGINAL `originalIdentity` (not merely against
 * itself), so a swap that happened at any point since the pass started —
 * not just during this one re-read — still fails closed.
 */
function refreshOverrideEntries(
  label: string,
  stateDir: string,
  originalIdentity: DirIdentity,
): { overrideEntries: string[]; stateDirIdentity: DirIdentity } {
  const beforeEnumeration = statDirIdentity(stateDir);
  let overrideEntries: string[];
  try {
    overrideEntries = readdirSync(stateDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    fail(
      1,
      `${label}: the drive state directory could not be re-read after waiting on the PR-wide lock (${code ?? String(e)}):`,
      `  ${stateDir}`,
      "",
      "Refusing to post. Whether another live session still holds this PR is now",
      "unknown, and an outcome reply has no undo.",
    );
  }
  const afterEnumeration = statDirIdentity(stateDir);
  if (
    afterEnumeration === null ||
    !sameDirIdentity2(beforeEnumeration, afterEnumeration)
  ) {
    fail(
      1,
      `${label}: the drive state directory was replaced while its lease set was being re-read after the PR-wide lock wait:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. The listing this check would judge from was not taken",
      "from a single, stable directory, so a lease it did not see may still be",
      "live in the directory that moved.",
    );
  }
  if (!sameDirIdentity(originalIdentity, afterEnumeration)) {
    fail(
      1,
      `${label}: the drive state directory changed identity while this call waited on the PR-wide lock:`,
      `  ${stateDir}`,
      "",
      "Refusing to post. A live lease may still be sitting in the directory that",
      "moved before this wait even began.",
    );
  }
  return { overrideEntries, stateDirIdentity: afterEnumeration };
}

export async function assertRemoteMutationAllowed(
  ctx:
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: true;
        overrideEntries: string[];
        stateDirIdentity: DirIdentity;
      }
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: false;
        legacyStateDirForFallback: string;
      },
  pr: string | null,
  label: string,
): Promise<PathLock | null> {
  // Canonicalize before comparing/searching, not just validate: `isDigits`
  // accepts a leading-zero string like "0999", which GitHub's numeric issue
  // route treats identically to "999", but neither a strict `===` nor
  // `leaseFilesFor`'s own filename PREFIX match would find a lease stored
  // under the canonical form otherwise — silently narrowing an explicit
  // `--pr 0999` to zero candidates and authorizing the POST past a live one
  // (chatgpt-codex-connector, a reference-implementation pull request round 7).
  //
  // `BigInt`, not `Number`: `isDigits` only guarantees an all-digit string,
  // not one that fits a float's 53-bit mantissa — `String(Number(pr))` is
  // LOSSY past `Number.MAX_SAFE_INTEGER` (silently rounds to a neighboring
  // integer) and outright wrong past `Number.MAX_VALUE` (`Infinity`), either
  // of which enumerates the wrong — often empty — lease set and authorizes a
  // POST past a live lease for the real identifier (docomply-review, a reference-implementation pull request
  // round 10). `BigInt` has no such ceiling and canonicalizes leading zeros
  // the same way `.toString()` always has.
  const canonicalPr = pr === null ? null : BigInt(pr).toString();
  // Resolved FRESH, before `remoteLock` below is even constructed — not
  // reused from `resolveFenceContext`'s original snapshot decision. The lock
  // path is keyed by `ctx.stateDir`, so a stale snapshot does not just make
  // `checkAllowed`'s enumeration read the wrong directory (the round-7 fix,
  // below): it makes THIS lock guard the wrong directory too, and a fresh
  // admission via `claimPrLease` — which resolves its OWN lock path live —
  // would then acquire a DIFFERENT lock file than this call holds, so the
  // two never contend at all despite both naming the identical PR
  // (docomply-review, a reference-implementation pull request round 8, summary finding). The loop below
  // additionally re-checks after `acquire()` itself, which can wait up to
  // `LOCK_ACQUIRE_MAX_SEC` — long enough for the choice to move again.
  if (!ctx.fromOverride) {
    const freshStateDir = resolveLegacyFallbackDir(
      ctx.legacyStateDirForFallback,
    );
    if (freshStateDir !== ctx.stateDir) {
      ctx = { ...ctx, stateDir: freshStateDir };
    }
  }
  // Acquired FIRST, before this function's own enumeration even
  // runs, and returned to the caller STILL HELD: the identical "through the
  // mutation, not just the check" shape `assertTreeMutationAllowed` already
  // carries for the TREE axis (round 7-8), applied here to the PR axis this
  // function was deferred on when PR #4131 shipped that fix. Before this,
  // the function below returned `void` having taken no lock at all — a
  // point-in-time read of the per-PR lease set, with nothing held once it
  // returned, left the exact window a replacement worktree's admission needs
  // to land in: `guarded-push.ts` starts a `git push` that can legitimately
  // run for the whole of `$DRIVE_PR_PUSH_TIMEOUT` (an hour, by default), and
  // nothing stopped a DIFFERENT worktree from claiming this PR's per-PR lease
  // and mutating it while that push was still in flight.
  //
  // Keyed by PR ALONE — `prRemoteMutationLockPathFor`, one file for every
  // worktree driving this PR — mirroring how `treeLeasePathFor` is keyed by
  // actor alone; NOT the per-(tree, PR) `leasePathFor` this function already
  // enumerates below, which is what let two DIFFERENT trees each resolve a
  // lease of their own with no shared file to contend on in the first place.
  //
  // Skipped entirely when no PR is named (`canonicalPr === null`,
  // `assert-post-allowed.ts`'s standalone actor-wide path): there is no
  // single PR this call is protecting, so there is nothing for a lock keyed
  // by PR to guard — the same reasoning `assertTreeMutationAllowed`'s own
  // `pr === null` case documents for `treeIsMine`.
  //
  // `claimPrLease` (this module's admission WRITE path) takes the SAME lock
  // — and, since PR #4164 round 1, HOLDS it through its own admission write
  // rather than releasing right after acquiring, for the identical reason
  // this function holds it through the caller's mutation: a release-then-
  // write gap is itself a window a DIFFERENT acquirer can land in — so a
  // takeover attempt waits out an in-flight hold here, bounded the same way
  // every acquisition in this module is (`LOCK_ACQUIRE_MAX_SEC` at most,
  // `$DRIVE_PR_LOCK_TIMEOUT` if smaller), refusing with exit 11 rather than
  // racing past a check that saw nothing because nothing had renewed yet —
  // see its own comment for why that bound, not the true worst case, is
  // what a single `acquire()` may wait. See the lock-ordering note beside
  // `treeLeaseLock`'s own definition for where this sits relative to the
  // other locks in this module.
  // Bounded retry: `ctx.stateDir` was already refreshed once above, but the
  // choice can move AGAIN while `acquire()` itself waits — up to
  // `LOCK_ACQUIRE_MAX_SEC` — for a rival to release it, and that wait is
  // exactly a window a concurrent admission can land in. Re-checking only
  // after acquiring, and releasing-and-retrying against the fresher
  // directory when it moved, closes that second window too rather than
  // just narrowing the first one (docomply-review, a reference-implementation pull request round 8,
  // summary finding). `MAX_DIR_REFRESH_ATTEMPTS` bounds it defensively —
  // the decision is monotonic (legacyDir → newDir, never back), so a real
  // clone converges in one extra iteration at most; this only guards
  // against a defect turning that into a spin.
  let remoteLock: PathLock | null = null;
  for (let attempt = 0; ; attempt++) {
    remoteLock =
      canonicalPr === null
        ? null
        : prRemoteMutationLock(ctx.stateDir, canonicalPr);
    if (remoteLock !== null) {
      try {
        await remoteLock.acquire(LOCK_ACQUIRE_MAX_SEC);
      } catch (e) {
        // Never acquired, so nothing for `release()` to give back — but
        // `createLock` registers this handle's process-exit/signal listeners
        // unconditionally at construction, not on a successful acquire, so
        // `dispose()` still has real cleanup to do here, mirroring
        // `claimPrLease`'s own identical fix (docomply-review, a reference-implementation pull request
        // round 4 — this acquisition sat outside the `try` below entirely,
        // so a caller that catches the rejection and continues — a test, or
        // a future caller that retries — accumulated live listeners on every
        // failed attempt).
        remoteLock.dispose();
        // `LockAcquireTimeoutError`, converted to the SAME exit 11 every
        // other live-foreign-driver refusal in this module uses — not
        // `acquire()`'s own generic exit 1 "or the lock is wedged" (docomply-
        // review, PR #4164 round 5): this is `guarded-push.ts`'s and
        // `answer-summary-finding.ts`'s OWN fence, the one caller class this
        // lock exists for, so misreporting an ordinary in-flight rival
        // mutation as a possibly-wedged lock here would be the exact
        // misdiagnosis `claimPrLease`'s identical conversion already avoids.
        // Any OTHER `ExitError` (the ownership-marker infrastructure failure)
        // keeps its own exit code and message, unchanged.
        if (!(e instanceof LockAcquireTimeoutError)) throw e;
        fail(
          11,
          `${label}: PR #${canonicalPr} has an irreversible remote mutation (a push or a posted reply) in flight from another worktree, and it has not cleared yet.`,
          "",
          "Refusing to post rather than proceed alongside it — the identical",
          "cross-shipping hazard this PR-wide lock exists to close.",
          "This is not necessarily wedged: a push can legitimately run for the",
          "whole of $DRIVE_PR_PUSH_TIMEOUT (an hour, by default, pre-push hooks",
          "included), longer than this wait was bounded to. Retry once it",
          "completes.",
        );
      }
    }
    if (ctx.fromOverride || remoteLock === null) break;
    const freshStateDir = resolveLegacyFallbackDir(
      ctx.legacyStateDirForFallback,
    );
    if (freshStateDir === ctx.stateDir) break;
    if (attempt >= MAX_DIR_REFRESH_ATTEMPTS) {
      remoteLock.release();
      remoteLock.dispose();
      fail(
        1,
        `${label}: the legacy-vs-relocated state directory choice kept changing while acquiring PR #${canonicalPr}'s remote-mutation lock.`,
        "",
        "Refusing to post. This should converge in one retry (the choice only",
        "ever moves legacyDir -> newDir, never back); repeated movement means",
        "something is wrong rather than a genuine one-time migration handoff",
        ".",
      );
    }
    remoteLock.release();
    remoteLock.dispose();
    ctx = { ...ctx, stateDir: freshStateDir };
  }
  // Re-enumerate the override snapshot AFTER the wait above, not before
  // (docomply-review, a reference-implementation pull request round 11): `ctx.overrideEntries` was
  // captured by the CALLER's own `resolveFenceContext`, before this
  // function — and its `remoteLock.acquire()` above — ever ran. Refreshing
  // unconditionally (not only when the acquire visibly blocked) because
  // there is no cheap way to distinguish "acquired instantly" from
  // "acquired after a wait" from here, and the race this closes can land
  // in a gap of ANY size, not only a long one.
  //
  // The non-override path's own equivalent refresh already happened above,
  // inside the lock-acquisition loop — that is where the RETRY has to live,
  // since a directory change there means a DIFFERENT lock path, not just a
  // different enumeration target. Nothing further to do for it here.
  //
  // Inside the SAME try/catch as `checkAllowed()`, not before it
  // (docomply-review, a reference-implementation pull request round 12): `refreshOverrideEntries` can
  // itself `fail()` (a read error, or a directory-identity mismatch), and
  // sitting outside the cleanup below meant that throw escaped without
  // ever releasing or disposing `remoteLock` — a caller that catches the
  // refusal and stays alive would keep holding the lock (and its process
  // listeners) indefinitely, blocking every later push, POST, or admission
  // attempt on this PR until stale-lock recovery.
  try {
    if (ctx.fromOverride && remoteLock !== null) {
      const refreshed = refreshOverrideEntries(
        label,
        ctx.stateDir,
        ctx.stateDirIdentity,
      );
      ctx = { ...ctx, ...refreshed };
    }
    checkAllowed();
  } catch (e) {
    if (remoteLock !== null) {
      remoteLock.release();
      remoteLock.dispose();
    }
    throw e;
  }
  return remoteLock;

  function checkAllowed(): void {
    // A known PR is checked PR-WIDE — every worktree's lease for it, not just
    // this tree's own actor. A driver can legitimately move to a DIFFERENT
    // worktree (this tree's died; a successor started fresh elsewhere), and an
    // orphaned pass left running in the OLD tree must still see that
    // successor's live lease: `leaseFilesForActor` is blind to every OTHER
    // tree's leases by construction, so a detached pass there finds only its
    // own (dead) driver's lease — not-alive, not-mine, refuses nothing — and
    // posts alongside the session actually driving the PR right now
    // (chatgpt-codex-connector, a reference-implementation pull request round 8). `leaseFilesFor` is the
    // PR-wide mirror of `leaseFilesForActor` an earlier change already built for
    // `assertNoForeignDrive`'s claim-time version of this same question — reused
    // here, not reimplemented, but still read through `readLeaseForFence`
    // rather than `liveLeasesFor`'s `readLease`: that reader collapses absent
    // and unreadable to the same "no lease", which is the exact fail-open this
    // whole function exists to close, so the claim-time helper is right for
    // claiming and wrong for posting for the same reason it always has been.
    //
    // With no PR named, PR-wide is not answerable without a network round-trip
    // this hot-path fence does not spend, so the actor-wide check remains —
    // sound for the reason `actor.ts` gives: at most one drive runs per TREE,
    // so a live foreign lease found there is a second session in it whichever
    // PR it names.
    // The override case never re-ENUMERATES the directory here —
    // `ctx.overrideEntries` is the one and only directory LISTING
    // `resolveFenceContext` already performed, and this filters that in-memory
    // snapshot instead of asking the filesystem for the name list again. That
    // closes the NAME-LIST half of the class of races three rounds of narrower
    // fixes kept leaving a corner open (statSync-then-later-read ordering, then
    // an `ENOENT`-only indeterminate flag on the later read, both defeated by
    // renaming the directory away and creating an EMPTY one at the same
    // pathname — chatgpt-codex-connector, a reference-implementation pull request round 13): a rename-and-
    // recreate cannot inject or hide a NAME this fence reasons about, because
    // the list was already fixed before it could land.
    //
    // It does not close the CONTENT half — each candidate's lease still has to
    // be OPENED fresh, below, and that per-file read is a genuine later moment
    // a rename-and-recreate can still land in front of (docomply-review,
    // a reference-implementation pull request round 14, finding A): the file
    // this enumeration saw may no longer be reachable at this path if the
    // directory itself was swapped, and `readLeaseForFence` would then report
    // `absent` for a lease that is still live in the directory that moved.
    // `enumerationIdentity` below is what closes that: for the override path it
    // is `ctx.stateDirIdentity`, captured by `resolveFenceContext` in the same
    // breath as `ctx.overrideEntries`; for the non-override path — which has no
    // earlier snapshot to reuse, and reads live because for it "never existed"
    // is the ordinary case, not an anomaly to fence against — it is captured
    // fresh immediately below, right after that path's own live enumeration.
    // Every `absent` read, and the moment just before this function authorizes
    // the post, re-confirms that identity before trusting it — failing closed
    // on a mismatch instead of reading a swapped directory as an all-clear.
    // The opening bracket of the pair described below `candidates`. Taken
    // BEFORE the live enumeration so the two readings straddle it; unused on
    // the override path, which does no enumeration here at all.
    const beforeEnumeration: DirIdentity | null = ctx.fromOverride
      ? null
      : statDirIdentity(ctx.stateDir);
    const candidates: { file: string; pr: string }[] = ctx.fromOverride
      ? canonicalPr === null
        ? filterLeaseFilesForActor(ctx.overrideEntries, ctx.stateDir, ctx.actor)
        : filterLeaseFilesFor(
            ctx.overrideEntries,
            ctx.stateDir,
            canonicalPr,
          ).map((file) => ({ file, pr: canonicalPr }))
      : canonicalPr === null
        ? leaseFilesForActor(ctx.stateDir, ctx.actor)
        : leaseFilesFor(ctx.stateDir, canonicalPr).map((file) => ({
            file,
            pr: canonicalPr,
          }));
    // BRACKETED, not captured afterwards. Taking the identity only AFTER the
    // live enumeration describes whatever directory is at this path by then —
    // so a swap landing BETWEEN the enumeration and that capture yields an
    // identity of the REPLACEMENT, and both `assertStateDirIdentityUnchanged`
    // calls below then compare the replacement with itself, agree, and
    // authorize the POST while the live lease sits in the directory that moved
    // (chatgpt-codex-connector, a reference-implementation pull request round 15). The `before` reading is
    // taken ahead of the enumeration and the `after` reading immediately
    // following it; they must agree, or the listing this function is about to
    // trust was not taken from a stable directory and nothing downstream can
    // repair that.
    //
    // The override path inherits `ctx.stateDirIdentity`, which
    // `resolveFenceContext` already bracketed the same way around its own
    // single `readdirSync` — including the case where NO driver baseline was
    // inherited, which is the same ordering hazard one frame up.
    let enumerationIdentity: DirIdentity | null;
    if (ctx.fromOverride) {
      enumerationIdentity = ctx.stateDirIdentity;
    } else {
      enumerationIdentity = statDirIdentity(ctx.stateDir);
      if (!sameDirIdentity2(beforeEnumeration, enumerationIdentity)) {
        fail(
          1,
          `${label}: the drive state directory was replaced while its lease set was being listed:`,
          `  ${ctx.stateDir}`,
          "",
          "Refusing to post. The listing this check would judge from was not taken",
          "from a single, stable directory, so a lease it did not see may still be",
          "live in the directory that moved (PR #4107).",
        );
      }
    }
    for (const c of candidates) {
      const read = readLeaseForFence(c.file);
      if (read.kind === "unreadable") {
        fail(
          1,
          `${label}: PR #${c.pr} has a drive lease that could not be read (${read.why}).`,
          `  ${c.file}`,
          "",
          "Refusing to post. That file is exactly the evidence of whether another live",
          "session is driving this PR, so an unreadable one is not an all-clear — it",
          "is the question going unanswered, in front of a mutation with no undo",
          ".",
          "",
          "Fix the file or remove it deliberately, then retry:",
          `  drive-state.ts lease ${c.pr}          # read what is there`,
          `  drive-state.ts clear-lease ${c.pr}    # drop it, if that session is gone`,
        );
      }
      if (read.kind === "absent") {
        // See `enumerationIdentity` above: a rename-and-recreate between the
        // enumeration and THIS read makes an `absent` result a lie about a
        // directory that no longer exists at this path. Re-confirming here is
        // what turns that into a refusal instead of a silent "nobody here".
        assertStateDirIdentityUnchanged(
          label,
          ctx.stateDir,
          enumerationIdentity,
          `while treating PR #${c.pr}'s lease as absent`,
        );
        continue;
      }
      const held = read.lease;
      // DELIBERATELY NOT `isRecycledPid`-aware, unlike `claimLease` and
      // `assertNoForeignDrive`. Those guard an ADMISSION decision —
      // a false refusal there costs a retry, or a wait bounded by the
      // staleness window, both recoverable. This fence guards a POST with no
      // undo, and "EVERY OTHER OUTCOME REFUSES" (this function's own header)
      // is the standing rule for exactly that asymmetry: it may allow only on
      // a positively established absence of ANY live rival, `isMine` or not —
      // never on a proof that the rival is merely a DIFFERENT one, however
      // sound that proof is. Locked in by the "session-started token (PR #4107
      // finding B — pid recycling)" suite below, which asserts exit 11 for
      // this identical fixture shape; an `isRecycledPid` carve-out here was
      // tried and reverted for exactly that conflict.
      if (isMine(held, ctx.session, ctx.actor) || !leaseAlive(held)) continue;
      const sameTree = held.actor === ctx.actor;
      const where = sameTree
        ? "this working tree"
        : `a DIFFERENT working tree (${held.worktree === "" ? held.actor : held.worktree})`;
      fail(
        11,
        `${label}: PR #${c.pr} is being driven from ${where} by another live holder (${leaseHolderLabel(held)}).`,
        `It took the lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        sameTree
          ? "Refusing to post. Two sessions in ONE tree share one actor id, so both post"
          : "Refusing to post. A live session elsewhere is actively driving this PR, so",
        sameTree
          ? "their own outcome reply and every thread ends up with two — which is not"
          : "posting here doubles every outcome reply it makes from this point on — not",
        sameTree
          ? "repairable once the comments are up, and corrupts the reviewer-scoring"
          : "repairable once the comments are up, and it corrupts the reviewer-scoring",
        sameTree
          ? "sample they feed. Unlike drive state, a comment has no undo, so"
          : "sample it feeds. Unlike drive state, a comment has no",
        sameTree
          ? "this refusal comes BEFORE the mutation rather than after it."
          : "undo, so this refusal comes BEFORE the mutation rather than after it.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${c.pr}`,
        `Otherwise the lease clears itself once that holder has left drive state`,
        `untouched for ${leaseStaleMin()}m.`,
      );
    }
    // One more check, right before this function tells its caller the post is
    // authorized. Every `absent` read above already re-confirmed identity on
    // its way through, but a candidate list that matched NOTHING at all — no
    // lease file for this PR/actor — never enters that branch, so this is what
    // catches a directory swap when the loop body never ran even once.
    assertStateDirIdentityUnchanged(
      label,
      ctx.stateDir,
      enumerationIdentity,
      "right before authorizing the post",
    );
  }
}

/**
 * `assertRemoteMutationAllowed`'s TREE-WIDE counterpart: may THIS
 * session still perform an irreversible external mutation on this tree's
 * behalf?
 *
 * `assertRemoteMutationAllowed` guards only the PER-PR lease, and every
 * caller of it predates an earlier change. `guarded-push.ts` — the one script that
 * performs the single most irreversible external mutation in this whole
 * skill, `git push` — called into NEITHER fence at all until now: an
 * orphaned pass (its own session dead, the tree already taken over by a
 * replacement session working a different PR) could push straight through,
 * cross-shipping uncommitted work between two PRs in the same checkout —
 * exactly the hazard an earlier change exists to close, reached through the one
 * script that had never been wired to any lease fence (docomply-review, PR
 * #4131 round 6).
 *
 * Takes the SAME resolved `ctx` `assertRemoteMutationAllowed` does — callers
 * should invoke both from one `resolveFenceContext` call, not resolve twice
 * — but reads only the SINGLE, well-known tree-lease path, not an
 * enumeration, so it does not need that function's directory-identity-swap
 * protection: there is no directory listing here for a rename-and-recreate
 * to defeat, only one `readFileSync` at a path this actor's identity already
 * pins.
 *
 * Passes when: no tree lease exists (nothing has ever claimed one — the
 * standalone case, or a genuinely idle tree); it belongs to THIS caller
 * (`treeIsMine`: pid/host/token for a `holder: 'session'` record,
 * matching `pr` for a `holder: 'worktree'` one, since that file is no
 * longer written by identified sessions alone); or its owner is gone or has
 * stopped driving (`leaseAlive` false — an ended drive is not a rival).
 * Refuses, fail-closed, on a file that exists but cannot be parsed
 * (mirroring `treeLeaseUnreadableAndFresh`'s ruling everywhere else in this
 * module) and on a live, different holder — session or sessionless.
 *
 * `pr` is `null` for the one caller with no PR in play at all
 * (`assert-post-allowed.ts`'s standalone path) — `treeIsMine` then never
 * treats a `holder: 'worktree'` record as this caller's own, which is the
 * safe direction: a caller that cannot NAME the pr it is posting for cannot
 * claim ownership of a specific-pr sessionless resolver's record either.
 */
// ACQUIRES `treeLeaseLock` and returns it STILL HELD (docomply-review /
// chatgpt-codex-connector, a reference-implementation pull request round 7-8): the identical "through the
// mutation, not just the check" fix `acquireIdentifiedTreeGuardNow` and
// `acquireSessionlessTreeGuardNow` already give every STATE-mutating path.
// An earlier revision of this function checked and returned `void`,
// releasing nothing because it had acquired nothing — a point-in-time read
// with the lock released (never taken) before `git push` even started, so a
// replacement session's takeover could land in the exact window this
// function exists to close, and `guarded-push.ts` would push straight
// through it. The caller now holds the returned lock across the push itself
// and releases it only once the push has completed — see `guarded-push.ts`.
//
// Lock order is unchanged from the other two tree guards: this is the ONLY
// lock this function takes, so it cannot invert against state-mutex(pr) →
// `treeLeaseLock`.
export async function assertTreeMutationAllowed(
  ctx:
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: true;
      }
    | {
        stateDir: string;
        actor: string;
        session: Session;
        fromOverride: false;
        legacyStateDirForFallback: string;
      },
  pr: string | null,
  label: string,
): Promise<PathLock> {
  // Same re-resolution `assertRemoteMutationAllowed` runs, and the same
  // reason: `ctx.stateDir` is a single snapshot decision `resolveFenceContext`
  // made, possibly a while before this call. Refreshed HERE, before `path` is
  // even computed, so the lock this function takes is on the directory the
  // caller would ACTUALLY be checked against, not a stale pre-admission one
  // (docomply-review, a reference-implementation pull request round 7, TOCTOU finding — same root cause,
  // different consumer of the same fence context). The loop below closes the
  // SAME gap `assertRemoteMutationAllowed`'s own loop does — the choice can
  // still move again while `lock.acquire()` itself waits, which is exactly
  // the residual an earlier revision of this comment accepted rather than
  // closed (docomply-review, a reference-implementation pull request round 9: "the adjacent comment
  // explicitly acknowledges this reachable residual"). Mirrored here now
  // rather than left asymmetric with the sibling fence.
  let stateDir = ctx.fromOverride
    ? ctx.stateDir
    : resolveLegacyFallbackDir(ctx.legacyStateDirForFallback);
  let path = treeLeasePathFor(stateDir, ctx.actor);
  let lock = treeLeaseLock(path);
  for (let attempt = 0; ; attempt++) {
    // EXPLICIT bound — see `acquireSessionlessTreeGuardNow`'s identical
    // comment; the same reasoning applies unchanged here.
    await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
    if (ctx.fromOverride) break;
    const freshStateDir = resolveLegacyFallbackDir(
      ctx.legacyStateDirForFallback,
    );
    if (freshStateDir === stateDir) break;
    if (attempt >= MAX_DIR_REFRESH_ATTEMPTS) {
      lock.release();
      lock.dispose();
      fail(
        1,
        `${label}: the legacy-vs-relocated state directory choice kept changing while acquiring this working tree's lease lock.`,
        "",
        "Refusing to post. This should converge in one retry (the choice only",
        "ever moves legacyDir -> newDir, never back); repeated movement means",
        "something is wrong rather than a genuine one-time migration handoff",
        ".",
      );
    }
    lock.release();
    lock.dispose();
    stateDir = freshStateDir;
    path = treeLeasePathFor(stateDir, ctx.actor);
    lock = treeLeaseLock(path);
  }
  try {
    checkAllowed();
  } catch (e) {
    lock.release();
    lock.dispose();
    throw e;
  }
  return lock;

  function checkAllowed(): void {
    if (treeLeaseUnreadableAndFresh(path)) {
      fail(
        1,
        `${label}: this working tree's TREE lease exists but could not be read as one:`,
        `  ${path}`,
        "",
        "Refusing to post. That file is exactly the evidence of whether another",
        "live session already holds this tree, so proceeding would be a claim this",
        "process could not actually verify.",
        "",
        `If it is debris, remove it deliberately:  rm '${path}'`,
        `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
        "without modification.",
      );
    }
    const held = readTreeLease(path);
    if (held === null) return;
    if (treeIsMine(held, ctx.session, ctx.actor, pr)) return;
    if (!leaseAlive(held)) return;
    if (held.holder === "worktree") {
      fail(
        11,
        `${label}: this working tree already has a sessionless resolver active on PR #${held.pr}.`,
        `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "Refusing to post. A live sessionless resolver elsewhere in this tree is",
        "actively working, so proceeding here doubles every irreversible action",
        "from this point on — not repairable once it lands (",
        "an earlier change).",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease <pr>`,
        "Otherwise the tree's presence record clears itself once that resolver",
        `has left drive state untouched for ${leaseStaleMin()}m.`,
      );
    }
    fail(
      11,
      `${label}: this working tree is being driven from a live session other than this one (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
      `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Refusing to post. A live session elsewhere in this tree is actively",
      "working, so proceeding here doubles every irreversible action from this",
      "point on — not repairable once it lands.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease <pr>`,
      "Otherwise the tree lease clears itself once that session has left drive",
      `state untouched for ${leaseStaleMin()}m.`,
    );
  }
}

/**
 * Drop the lease for (this working tree, this PR) — and, unconditionally,
 * this tree's TREE-WIDE lease, so the remedy every tree-lease
 * refusal names (`drive-state.ts clear-lease <pr>`) actually works: a refusal
 * whose suggested fix leaves the tree still locked is not a remedy, and a
 * human running this from inside the tree is already overriding a claim —
 * the identical override plain `clear-lease` has always applied to a LIVE
 * per-PR lease (see this function's own history: it has never asked whether
 * the lease it drops is stale before dropping it).
 *
 * The one case this trades away: a SINGLE session juggling two PRs from one
 * tree that `clear-lease`s one deliberately while the other is genuinely
 * still in flight also releases the tree lease — its own very next mutating
 * command simply reclaims it, since `isMine` still matches, so nothing here
 * refuses that session; a DIFFERENT session racing into the gap is the same
 * class of window every takeover in this module already accepts, bounded the
 * same way.
 *
 * Returns what was there for BOTH leases — the per-PR one and the tree one
 * — so a caller can report the tree lease it silently dropped too. Returning
 * only the per-PR record (round 1's shape) let an operator follow a
 * cross-PR refusal's own `clear-lease <requested-pr>` suggestion — where
 * there is normally no PER-PR lease for that pr at all — and see "nothing to
 * clear" while the live TREE lease they were actually overriding vanished
 * unreported (chatgpt-codex-connector, a reference-implementation pull request round 2).
 */
export async function clearLease(
  stateDir: string,
  pr: string,
): Promise<{ lease: Lease | null; treeLease: TreeLease | null }> {
  const actor = await resolveActor();
  const path = leasePathFor(stateDir, pr, actor);
  const lock = leaseLock(path, pr);
  let held: Lease | null;
  await lock.acquire();
  try {
    held = readLease(path);
    rmSync(path, { force: true });
  } finally {
    lock.release();
    lock.dispose();
  }
  const treePath = treeLeasePathFor(stateDir, actor);
  const treeLock = treeLeaseLock(treePath);
  let treeHeld: TreeLease | null;
  await treeLock.acquire();
  try {
    treeHeld = readTreeLease(treePath);
    rmSync(treePath, { force: true });
  } finally {
    treeLock.release();
    treeLock.dispose();
  }
  return { lease: held, treeLease: treeHeld };
}

/**
 * Release the TIER-3 PRESENCE RECORDS this working tree holds for `pr`, because
 * the sessionless resolver that took them has finished.
 *
 * ── The asymmetry it closes ─────────────────────────────────────────────────
 *
 * A `holder: 'session'` lease is released for free: `leaseAlive` tests its pid,
 * so the record stops excluding anybody the instant that process dies, whether
 * the session ended cleanly or crashed. A `holder: 'worktree'` record has no pid
 * to test (the ladder's tier-3 entry in this module's header says why one must
 * not be invented), so `lastSeen` freshness is its ONLY liveness signal — and
 * nothing marked a CLEAN COMPLETION. A sessionless resolver that finished its
 * work perfectly left a record that went on refusing every other working tree
 * with exit 13 for up to `DRIVE_PR_LEASE_STALE_MIN` (default 360m).
 *
 * That cost was accepted knowingly when an earlier change shipped — two
 * sessionless resolvers both driving and both posting duplicate outcome replies
 * is strictly worse and unrepairable once posted — but it is a cost of having no
 * pid to test, not a cost of having no *completion signal*. `converge.ts` (in
 * `/resolve-review-comments`) is exactly that signal: it is the loop that spawns
 * every sessionless pass and the one process that knows, definitively, when it
 * will spawn no further one. It reaches this through the standalone
 * `release-sessionless-lease.ts` CLI — a SPAWN of a sibling skill's executable,
 * never an import of this module, for the reasons `../references/post-fence.md`
 * records for `assert-post-allowed.ts`.
 *
 * ── Why not `clearLease` ────────────────────────────────────────────────────
 *
 * `clearLease` above is a HUMAN OVERRIDE and is unconditional by design: it
 * drops the per-PR lease and the tree lease whatever their holder, and whatever
 * pr the tree lease names. Both properties are wrong for an automated,
 * speculative release:
 *
 *   - IT WOULD DROP A `holder: 'session'` LEASE. A session lease already
 *     self-releases when its pid dies, so this mechanism buys nothing there and
 *     would spend the whole of `isMine`'s pid-recycling / `sessionStarted`
 *     reasoning (this module's header, residual 3) on a case it does not serve.
 *     So the discriminant is the RECORD's own `holder` field — never the
 *     releasing process's identity, which may legitimately differ from the one
 *     that took the record (a `converge.ts` running under Claude Code spawns
 *     passes that inherit `$CLAUDE_PID` and therefore claim tier-2 SESSION
 *     leases; this then correctly releases nothing).
 *   - IT WOULD DROP A TREE LEASE THAT HAS MOVED ON. `treeLeasePathFor` is ONE
 *     file per working tree, and its `pr` field names whichever PR that tree is
 *     currently driving. A tree that finished PR A and has since started PR B
 *     under a second sessionless resolver holds a tree record naming B; dropping
 *     it at A's completion would strip B's live protection — a NEW hazard, not a
 *     leftover one. So the tree half additionally requires the record's `pr` to
 *     canonically equal the PR being released (`canonicalLeasePr`, the same
 *     spelling the writer used, so reader and writer agree by construction).
 *
 * ── Fail direction ─────────────────────────────────────────────────────────
 *
 * Deliberately the OPPOSITE of every fence in this module, and that inversion is
 * the whole reason a "best effort" posture is legitimate here rather than a
 * violation of `.claude/rules/document-scanning-gates.md` rule 1. A fence that
 * cannot read its input must refuse, because failing the other way PERMITS an
 * irreversible act. This one authorises nothing: not releasing simply leaves the
 * record to expire by staleness, which is precisely the behaviour that existed
 * before an earlier change. So an unreadable record is LEFT ALONE (`readLease` /
 * `readTreeLease` answer `null` for absent and for unparseable alike, and only a
 * positively-read `holder: 'worktree'` is removed), and a caller may invoke this
 * speculatively, repeatedly, and against a PR it never drove.
 *
 * ── Locking ────────────────────────────────────────────────────────────────
 *
 * Read-under-lock and remove-under-lock, on the same two mutexes and in the same
 * (non-nested) order as `clearLease`, so a concurrent `claimLease` renewal
 * cannot interleave between the holder test and the removal and leave a record
 * this function already decided not to keep. Callers take the PR's STATE MUTEX
 * around it exactly as `drive-state.ts`'s `clear-lease` does — see that command's
 * own comment: the admission fence (`assertLeaseUnchanged`) runs inside a locked
 * section and is followed by that section's write, and a removal landing between
 * those two would make an already-admitted command refuse a mutation that was
 * never in conflict. Holding the state mutex means a release can only land
 * BETWEEN locked sections.
 *
 * ── The residual, stated ───────────────────────────────────────────────────
 *
 * TWO SESSIONLESS RESOLVERS IN ONE TREE, ON THE SAME PR, are indistinguishable
 * to every identity this runtime exposes — the identity floor tier 3 has carried
 * since an earlier change — so one finishing releases a record the other is also relying
 * on. It is bounded on both sides and does not reopen the hole: that
 * record never excluded a caller in its OWN tree in the first place (every
 * invocation there resolves the same actor), and the sibling's very next
 * mutating `drive-state.ts` command re-claims it via `claimSessionlessTreeLease`
 * / `claimLease`. The exposure is therefore another TREE being admitted during
 * the gap between this release and that next mutation — narrower than the
 * pre-existing case of two sessionless resolvers in one tree racing each other's
 * replies, which nothing here makes better or worse.
 *
 * Returns what it removed — both halves, independently, for the same reason
 * `clearLease` does: a caller that reported only the per-PR half would make the
 * tree record's removal invisible on the call where there is often no per-PR
 * record at all.
 */
export async function releaseSessionlessLease(
  stateDir: string,
  pr: string,
): Promise<{ lease: Lease | null; treeLease: TreeLease | null }> {
  const actor = await resolveActor();
  const canonicalPr = canonicalLeasePr(pr);

  const path = leasePathFor(stateDir, pr, actor);
  const lock = leaseLock(path, pr);
  let released: Lease | null = null;
  await lock.acquire();
  try {
    const held = readLease(path);
    // ONLY a positively-read tree-held record. `null` covers absent AND
    // unreadable, and both mean "nothing this function may act on".
    if (held !== null && held.holder === "worktree") {
      rmSync(path, { force: true });
      released = held;
    }
  } finally {
    lock.release();
    lock.dispose();
  }

  const treePath = treeLeasePathFor(stateDir, actor);
  const treeLock = treeLeaseLock(treePath);
  let treeReleased: TreeLease | null = null;
  await treeLock.acquire();
  try {
    const treeHeld = readTreeLease(treePath);
    // The `pr` test is what keeps this from stripping a DIFFERENT, still-live
    // drive's protection — see this function's doc comment. Compared through
    // `canonicalLeasePr` on both sides, matching every other reader/writer pair
    // in this module (PR #4107 round 16's leading-zero mismatch).
    if (
      treeHeld !== null &&
      treeHeld.holder === "worktree" &&
      canonicalLeasePr(treeHeld.pr) === canonicalPr
    ) {
      rmSync(treePath, { force: true });
      treeReleased = treeHeld;
    }
  } finally {
    treeLock.release();
    treeLock.dispose();
  }

  return { lease: released, treeLease: treeReleased };
}

/**
 * Pure filter: which of these already-listed names are lease files for `pr`?
 * Extracted so a caller that has ALREADY read a directory once — the
 * external-mutation fence's override path, which cannot afford a SECOND read
 * of the same directory without reopening the exact race it exists to close
 * (chatgpt-codex-connector, a reference-implementation pull request round 13: renaming the directory away and
 * recreating an empty one at the same path defeats an `ENOENT`-keyed check,
 * since neither operation raises `ENOENT`) — can filter its own snapshot
 * in-memory instead of asking the filesystem again. `leaseFilesFor` below is
 * this plus the directory read, for every OTHER caller, which has no such
 * snapshot to reuse.
 */
function filterLeaseFilesFor(
  names: string[],
  stateDir: string,
  pr: string,
): string[] {
  // Through the same canonicalizer the WRITER uses, so the two agree by
  // construction rather than by each caller remembering to normalize first
  // (PR #4107 round 16). Already-canonical input is unchanged, so this is a
  // no-op for every caller that did normalize.
  const prefix = `${LEASE_PREFIX}${canonicalLeasePr(pr)}-`;
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => join(stateDir, n));
}

/**
 * Every lease file for this PR, whichever tree holds it.
 *
 * `[]` means CONFIRMED empty — the directory exists and holds no lease, or does
 * not exist at all, which is the same answer. An enumeration that FAILED for
 * any other reason (`EACCES`, `EMFILE`, …) throws rather than answering `[]`:
 * the caller is `reset`, and an empty list is indistinguishable from "swept
 * everything", so swallowing the error would report a successful sweep while
 * every lease file stayed exactly where it was — refusing later mutations for
 * up to a whole staleness window, with nothing said about why.
 */
export function leaseFilesFor(stateDir: string, pr: string): string[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  return filterLeaseFilesFor(names, stateDir, pr);
}

/**
 * Pure filter counterpart to `filterLeaseFilesFor` — see its own doc for why
 * this split exists. `leaseFilesForActor` below is this plus the directory
 * read.
 */
function filterLeaseFilesForActor(
  names: string[],
  stateDir: string,
  actor: string,
): { file: string; pr: string }[] {
  const suffix = `-${actor}.json`;
  const out: { file: string; pr: string }[] = [];
  for (const n of names) {
    if (!n.startsWith(LEASE_PREFIX) || !n.endsWith(suffix)) continue;
    const pr = n.slice(LEASE_PREFIX.length, n.length - suffix.length);
    if (!isDigits(pr)) continue;
    out.push({ file: join(stateDir, n), pr });
  }
  return out;
}

/**
 * Every lease file THIS WORKING TREE holds, whichever PR each is for, with the
 * PR recovered from the name so a refusal can say which drive it belongs to.
 *
 * The mirror image of `leaseFilesFor`, which fixes the PR and takes every tree.
 * This one fixes the tree and takes every PR, because the external-mutation
 * fence can be reached from a caller that does not know its PR and must not
 * spend a network round-trip to learn one.
 *
 * Matched by prefix and by the `-<actor>.json` suffix rather than by a regular
 * expression built from `actor`: the actor is interpolated data (`wt-` plus 16
 * hex, per `isActorId`), and composing a pattern out of data is the habit that
 * eventually meets a value that is not what the composer assumed. The PR
 * segment is then whatever sits between them, and is kept only if it is
 * digits — so a foreign file that merely happens to share both ends cannot
 * enter the population as a lease for PR `''`.
 *
 * Throws on an enumeration that FAILED for any reason other than the directory
 * not existing, for the same reason `leaseFilesFor` does: `[]` here means
 * "confirmed no leases", and a caller that fences on it must not read an
 * `EACCES` as an all-clear.
 */
export function leaseFilesForActor(
  stateDir: string,
  actor: string,
): { file: string; pr: string }[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  return filterLeaseFilesForActor(names, stateDir, actor);
}

/**
 * Sweep this PR's leases from EVERY tree — `reset`'s share of "forget
 * everything for this PR", which the per-tree `clearLease` cannot do because
 * the tree running the reset may not be the one that got wedged.
 *
 * Every lease goes EXCEPT another tree's that is still live, which is preserved
 * and returned so the caller can say so. The distinction is the whole point: a
 * live lease is not a wedged one. Wedged means the session behind it is gone or
 * has stopped driving, and `leaseAlive` is exactly that test — so `reset` still
 * sweeps every lease a human could be reaching for it to clear, and preserves
 * only the ones whose driver is demonstrably still working.
 *
 * Deleting a live foreign lease is not merely rude, it re-opens the exact hole
 * this module exists to close, and does so in a tree the operator is not
 * standing in and cannot see. A command in that tree can already be ADMITTED —
 * past `claimLease`, waiting on the state mutex `reset` itself holds — and it
 * will not retake a lease when it wakes, because it took one on the way in. So
 * "the driver's next mutating command simply takes a fresh one" does not cover
 * the command already in flight: between `reset` deleting the file and that
 * driver's NEXT command, a second session in that tree claims the absent lease
 * and runs alongside the admitted one, under one actor. Preserving
 * the live lease closes that without any fencing protocol, because the file
 * that would have to be missing never goes missing.
 *
 * Each file is read and removed under its OWN lease lock — the same one
 * `claimLease` writes under — so a renewal cannot land between the liveness
 * read and the `rm` and be deleted as though it were stale. `claimLease`
 * releases that lock before its caller ever reaches for the state mutex, so a
 * `reset` holding the state mutex and reaching for a lease lock cannot deadlock
 * against it.
 *
 * The CALLER'S OWN live lease is preserved too, and for the identical reason
 * — the caller's tree is a tree like any other, and `reset` is not the only
 * thing running in it. A command from the SAME session can be admitted and
 * waiting on the state mutex `reset` holds; dropping that session's lease lets
 * a second session in that tree claim the absent one and mutate beside the
 * admitted command, under one actor. Only the REPORT distinguishes the two:
 * the caller's own preserved lease is not news to the caller, another tree's
 * is the only way they learn there was anything to decide.
 *
 * "Own" is matched by `ownLease` — the lease `claimLease` actually returned —
 * and by nothing else. This used to take the caller's ACTOR as well, which was
 * dead weight in the signature and misleading beside a comment naming it:
 * actor equality is a claim about the TREE, and round 15 on PR #4069 measured
 * exactly why that is not ownership (see the `isOwn` comment below).
 *
 * `removed` names what phase 2 actually deleted — empty whenever nothing was
 * (a live foreign lease short-circuits before phase 2 ever runs; an
 * uncontended sweep with no stale leases at all runs phase 2 but deletes
 * nothing). `reset`'s OWN later refusals (a live claim, checked after this
 * call returns) are not reflected here — this function has no way to know
 * about them — so a caller that refuses on its own account after a
 * successful, non-empty `removed` must not repeat this function's "nothing
 * deleted" framing verbatim: leases were deleted, even though the state file,
 * claim files, and handoff were not (docomply-review rounds 17-18,
 * chatgpt-codex-connector, a reference-implementation pull request).
 *
 * `preserveLive: false` turns every one of those preservations off, and is the
 * ONE deliberate override: `clear-lease --all`, the way a human takes a PR back
 * from a working tree they cannot stand in. Every caveat above still
 * describes exactly what they are choosing to do — which is why it is an
 * explicit flag on a command a human types, never a fallback anything reaches
 * for on its own. It is the cross-tree twin of plain `clear-lease`, which has
 * always been able to drop a LIVE lease in the caller's own tree for the same
 * reason: a refusal whose only remedy is another refusal is not a remedy.
 */
export async function clearAllLeases(
  stateDir: string,
  pr: string,
  ownLease: Lease | null,
  preserveLive = true,
): Promise<{ preservedForeign: Lease[]; removed: string[] }> {
  // TWO PHASES, and the split is the whole point: acquire every lease lock
  // first, delete only once they are all held.
  //
  // Deleting inside the acquire loop meant a lock that could not be taken threw
  // with EARLIER lease files already gone — a prefix swept, and `reset`'s own
  // diagnostic promising the caller that a non-zero exit means "no change"
  // (docomply-review round 11, a reference-implementation pull request). Ordering the sweep before the state
  // deletions fixed the state half of that claim and left the lease half false.
  //
  // Staged this way the claim is true of both: the only fallible step is
  // acquisition, and nothing has been removed while it is still running. A
  // failure releases whatever was taken and rethrows, having deleted nothing.
  // `performance.now()`, not `Date.now()`: this measures an ELAPSED budget, and
  // wall-clock is not monotonic. An NTP step or an administrator adjustment
  // moving the clock BACKWARD inflates the remaining allowance handed to each
  // later `acquire()`, so a contended sweep can hold the shared state mutex far
  // past the single 300s budget this is supposed to cap (docomply-review round
  // 16, PR #4069). `lock.ts`'s own `acquireDeadline` switched to the monotonic
  // clock for exactly this reason (round 6 on #4050); the aggregate deadline
  // layered on top of it has to use the same one or it silently undoes that.
  const sweepDeadline = performance.now() + LOCK_ACQUIRE_MAX_SEC * 1000;
  const taken: PathLock[] = [];
  const preservedForeign: Lease[] = [];
  // Declared outside the `try` so the final return (after `finally` releases
  // every lock) can still report it — phase 2 below populates it in place.
  const removed: string[] = [];
  try {
    // Phase 1 — acquire. ONE deadline shared across the whole sweep, because
    // `reset` holds the PR's state mutex throughout: each `acquire()` may wait
    // up to `LOCK_ACQUIRE_MAX_SEC`, so N contended locks would otherwise block
    // every other state mutation for N × 300s, growing with the number of trees
    // that have ever driven the PR (docomply-review round 9). The budget only
    // ever LOWERS a per-lock bound; it never asks for longer than the clamp.
    const doomed: string[] = [];
    // Only resolved when a live lease could actually be PRESERVED by it:
    // `clear-lease --all` runs with `preserveLive` off and must not pay for
    // — or risk failing on — a session resolution its own decision never
    // consults.
    const session = preserveLive ? resolveSession() : null;
    const actor = preserveLive ? await resolveActor() : "";
    for (const f of leaseFilesFor(stateDir, pr)) {
      const lock = leaseLock(f, pr);
      // Registered for cleanup BEFORE the await, not after it. `createLock`
      // installs its exit/SIGINT/SIGTERM handlers at construction, so a lock
      // whose `acquire` rejects had already added three listeners while never
      // reaching `taken` — and the `finally` below then skipped its `dispose`.
      // Repeated failed resets leaked exactly the listeners that disposal was
      // added to stop (docomply-review round 12, a reference-implementation pull request). Releasing a lock
      // that was never acquired is a no-op, so the early push is safe.
      taken.push(lock);
      await lock.acquire(
        Math.max(0, (sweepDeadline - performance.now()) / 1000),
      );
      const held = readLease(f);
      // `isRecycledPid` alongside `leaseAlive`, not folded into it — same
      // reason as `claimLease` and `assertNoForeignDrive`: once `held.pid` is
      // THIS session's own pid, `leaseAlive`'s pid half proves only that the
      // caller is running, never that `held`'s actual writer is.
      // `isOwn` below is unaffected — it also compares `generation`, which
      // recycling cannot forge. Unlike `assertRemoteMutationAllowed` (whose
      // own comment explains why it deliberately stays unaware of this), this
      // function guards a REVOCATION decision an operator explicitly asked
      // for (`reset`), where treating a recycled-pid lease as the wedge it
      // actually is — not a live rival to preserve — is the whole point.
      if (
        preserveLive &&
        held !== null &&
        leaseAlive(held) &&
        !(session !== null && isRecycledPid(held, session, actor))
      ) {
        // A live lease is silent ONLY if it is the caller's own — matched by
        // the lease `claimLease` actually returned, not by the actor.
        //
        // Actor equality is a claim about the TREE, and equating it with
        // ownership breaks in exactly the case the lease exists for: run
        // `reset` from this checkout with no session identity at all (tier 3 —
        // `$DRIVE_PR_SESSION` and `$CLAUDE_PID` both unset) and `claimLease`
        // admits nothing, yet a real driver's live lease in this same tree
        // still carries this very tree's actor. Treating that as "mine, not news"
        // reported success and deleted the shared state and claim files out
        // from under a live driver, whose generation is unchanged so its fence
        // still passes — and whose in-flight finding dispatch can then be
        // duplicated (chatgpt-codex-connector round 15, a reference-implementation pull request).
        //
        // With `ownLease` null, every live lease blocks, which is the right
        // answer for a caller that holds none.
        const isOwn =
          ownLease !== null &&
          held.actor === ownLease.actor &&
          held.pid === ownLease.pid &&
          held.host === ownLease.host &&
          held.generation === ownLease.generation;
        if (!isOwn) preservedForeign.push(held);
        continue;
      }
      doomed.push(f);
    }
    // A live FOREIGN lease stops the sweep here, having deleted NOTHING.
    //
    // `reset` refuses on this result and tells the operator nothing was
    // deleted (round 12). That was false while phase 2 ran first: a MIXED set
    // — some stale leases plus one live foreign one — swept the stale ones and
    // then returned the refusal anyway (docomply-review round 13, a reference-implementation pull request).
    // Returning before phase 2 makes the caller's diagnostic true, and makes
    // this function's own contract simply "sweeps everything, or nothing".
    if (preservedForeign.length > 0) return { preservedForeign, removed: [] };
    // Phase 2 — delete. `force: true` only makes a MISSING target harmless; it
    // does not make deletion infallible (EACCES, EPERM, EROFS, an I/O error).
    // An earlier version of this comment claimed it did, and `reset`'s contract
    // was written on that claim (docomply-review round 12, a reference-implementation pull request).
    //
    // So the two failure classes are separated rather than conflated. A phase-1
    // failure really is "nothing changed" — that is what the staging buys. A
    // phase-2 failure is a genuinely partial sweep, and it is reported AS one:
    // every file is attempted, and the error then NAMES what was removed and
    // what remains, so the operator is not left to guess which half happened.
    // Recoverable rather than transactional on purpose: a rename-based journal
    // would add a crash-recovery surface of its own to guard against a
    // filesystem that is already refusing writes.
    const failed: { file: string; err: unknown }[] = [];
    for (const f of doomed) {
      try {
        rmSync(f, { force: true });
        removed.push(f);
      } catch (err) {
        failed.push({ file: f, err });
      }
    }
    if (failed.length > 0) {
      const detail = failed
        .map((x) => `  ${x.file}: ${(x.err as Error)?.message ?? x.err}`)
        .join("\n");
      throw new Error(
        `clearAllLeases: PARTIAL sweep of PR #${pr} — ${removed.length} lease(s) removed, ${failed.length} could not be.\n` +
          `Removed:\n${removed.map((f) => `  ${f}`).join("\n") || "  (none)"}\n` +
          `Left in place:\n${detail}\n` +
          "The lease set has CHANGED. Re-run once the cause is fixed; the sweep is idempotent.",
      );
    }
  } finally {
    for (const lock of taken) {
      lock.release();
      // One lock per lease FILE, so this is the one place locks are created in
      // bulk. Each registers exit/SIGINT/SIGTERM handlers that nothing else
      // removes, and past ten trees Node warns about the leak on stderr — the
      // same stream `reset`'s preserved-lease report uses, so the warning lands
      // in the middle of the diagnostic an operator has to read. (Bun, the
      // default runtime, stays silent; the scripts also advertise Node ≥22.18,
      // where it fires.) Disposal is after `release`, never before: the
      // handlers exist to release an abnormally terminated hold.
      lock.dispose();
    }
  }
  return { preservedForeign, removed };
}
