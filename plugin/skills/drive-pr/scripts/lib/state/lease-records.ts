import { randomBytes } from "node:crypto";
/** Parse lease snapshots, determine liveness and compare session ownership without reopening a decision snapshot. */
import {
  type Lease,
  type TreeLease,
  leaseStaleMs,
  treeLeasePathFor,
  leaseStaleMin,
  type Session,
} from "./lease-model.ts";

import { existsSync, readFileSync, lstatSync, statSync } from "node:fs";

import { isDigits } from "../cli.ts";

import { pidAlive, pidCheckCommand } from "../proc.ts";

import { leaseFilesFor } from "./lease-files.ts";

import { hostname } from "node:os";

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
 * changed, only the file inside it did. One snapshot in, one decision out.
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
  if (!validLeaseHolder(v)) return null;
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
  // the two contradicting each other. The argument
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
  // shapes parser, i.e. precisely the deprecated-field tolerance the
  // pre-release stance against backward-compatibility shims rules out. It also
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
    // before `revision` existed has no per-write identity a rollback CAS can
    // trust, so it is debris here precisely as an unparseable file already
    // is.
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
 * live foreign driver holds that very lease.
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

export function readLeaseForFence(path: string): FenceLeaseRead {
  // `lstat` first, not `readFileSync`'s own errno: a DANGLING SYMLINK at this
  // exact path — the directory entry `leaseFilesForActor` just enumerated
  // still exists — makes `readFileSync` report ENOENT for the missing
  // TARGET, indistinguishable from the errno for an entry that is not there
  // at all. `lstat` does not follow the link, so it is the one call that
  // tells "gone" apart from "here, but broken" (the same reasoning
  // `repositoryIsInPlay` applies to `.git`).
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
export function leaseAlive(l: Lease): boolean {
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
 * skipping it widens admission on exactly the input the gate understands
 * least. The general form: a scanning gate that cannot read its input has
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
 *. This is the veto that lets a
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
 * way the per-PR predicate already does with `unreadableLeaseFilesFor`.
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
export function treeLeaseUnreadableAndFresh(path: string): boolean {
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
export function leaseFreshMarginMs(): number {
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

export function ageLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

/**
 * Is `l` the lease `s` itself holds? (pid, host) alone answers this only when
 * neither side can prove more — a pid is RECYCLABLE, so once `s` carries its
 * own acquisition token the on-disk lease must carry the SAME one, mirroring
 * `drives.ts`'s `ownParentDriver` exactly (see `Lease.sessionStarted` for the
 * hazard this closes):
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
 * bullets above. For the SECOND
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
export function isMine(l: Lease, s: Session, actor: string): boolean {
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
 * THE CRITERION (the one root cause behind every narrower attempt): this
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
 * a later challenge to this exact mechanism answerable by citation rather
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
 * RESIDUALS, stated explicitly rather than left implicit:
 *
 *   - R1 (KNOWN): two WELL-FORMED tokens whose relative order a
 *     backward system-clock step (e.g. an NTP correction) reverses are
 *     indistinguishable from a genuine reversal. There is no portable,
 *     `node:`-only, cross-process MONOTONIC session order to compare instead
 *     (the same missing primitive `isMine`'s own KNOWN RESIDUAL cites), and
 *     `leaseAlive`'s staleness window already trusts the identical wall clock
 *     for `lastSeen`/`startedAt`, so replacing only this comparison would
 *     harden one decision while leaving a clock-rollback-sized hole open in
 *     every sibling one. Revisit both together if a portable monotonic
 *     primitive becomes available.
 *   - R2 (KNOWN, the CENTRAL one given R4 below):
 *     a harness that exports a `(pid, sessionStarted)` pair it did not mint
 *     TOGETHER — claiming a pid it does not actually own, paired with a
 *     newer-than-reality token — is OUTSIDE this predicate's threat model,
 *     the same class as a caller exporting an arbitrary live foreign pid,
 *     which `resolveSession`'s tier-1 contract explicitly delegates to the
 *     caller's own honesty. This predicate does not defend against a caller
 *     lying about its own identity; it defends against confusing an
 *     inherited claim for a fresh one, which is different.
 *   - R3 (KNOWN): both sides tokenless — `isMine` itself
 *     returns `true` for this case, so `isRecycledPid` is never reached; see
 *     `isMine`'s own KNOWN RESIDUAL for why recycling is indistinguishable
 *     from a renewal there and why that is accepted.
 *   - R4: EITHER side tokenless gets NO fast path at all and relies entirely
 *     on the `leaseAlive` staleness window. A shorter default staleness
 *     window is not the right partial mitigation for that tier-2 residual:
 *     `LEASE_STALE_MIN_DEFAULT`'s own reasoning is that renewal is
 *     work-driven with no natural floor to tighten against, and the cost
 *     asymmetry above (one named recovery command vs. an unrepairable
 *     duplicate reply) favors leaving the window as-is rather than trading
 *     recovery speed for a shorter fuse on the one case a wrong guess is
 *     irreversible.
 */
export function isRecycledPid(l: Lease, s: Session, actor: string): boolean {
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

function validLeaseHolder(v: Record<string, unknown>): boolean {
  if (v.holder !== "session" && v.holder !== "worktree") return false;
  if (v.holder === "session") {
    if (typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0)
      return false;
  } else if (v.pid !== 0) {
    return false;
  }
  return true;
}

/** Preserve the acquisition generation on renewal; mint one for a new holder. */
export function leaseForClaim(
  holder: Lease["holder"],
  session: Session,
  actor: string,
  worktree: string,
  command: string,
  held: Lease | null,
  preserveGeneration: boolean,
): Lease {
  const now = new Date().toISOString();
  return {
    holder,
    pid: session.pid,
    host: session.host,
    platform: process.platform,
    actor,
    worktree,
    startedAt: preserveGeneration && held !== null ? held.startedAt : now,
    lastSeen: now,
    command,
    generation:
      preserveGeneration && held !== null
        ? held.generation
        : randomBytes(16).toString("hex"),
    sessionStarted: session.sessionStarted,
  };
}
