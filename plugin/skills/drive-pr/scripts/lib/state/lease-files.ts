/** Enumerate lease files, track directory identity and build the mutexes protecting lease mutations. */
import { createHash } from "node:crypto";
import { statSync, readdirSync, realpathSync } from "node:fs";

import {
  readVolumeIdentity,
  VOLUME_UUID_RE,
  type VolumeIdentityReader,
} from "./volume-identity.ts";
import { fail, isDigits } from "../cli.ts";

import { createLock } from "./lock.ts";

import {
  prRemoteMutationLockPathFor,
  LEASE_PREFIX,
  canonicalLeasePr,
} from "./lease-model.ts";

import { join } from "node:path";

/**
 * The directory actually read through a path: inode, device, creation time and
 * canonical target path. Rename-and-recreate preserves the pathname but changes
 * the inode; redirecting a symlink changes its target. Capture before reading
 * leases and compare again before trusting an absent read or remote mutation.
 *
 * Device numbers can change after a volume remount. A device change is benign
 * only with an unchanged inode, nonzero birth time, canonical target path and
 * independently confirmed volume UUID. Copied directory metadata on another
 * volume must not pass.
 * Old tokens without those extra fields keep strict device/inode comparison.
 * This guards directory replacement, not an attacker who can forge all of the
 * directory's metadata and lease contents.
 */
/**
 * `bigint`, not `number`. Node's numeric `stat` fields round 64-bit device and
 * inode identifiers past `Number.MAX_SAFE_INTEGER`, and filesystems do expose
 * values above it — on such a filesystem a decimal round-trip either compares
 * two ROUNDED identities as equal (a swap the fence should have caught) or
 * fails the safe-integer check and refuses every child fence even though the
 * directory never changed.
 * `statSync(..., { bigint: true })` is exact, and BigInt survives the decimal
 * transport through the environment without loss.
 */
export interface DirIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs?: bigint;
  readonly pathHash?: string;
  readonly volumeUUID?: string;
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
 * would authorize the POST with the live lease still in the moved target.
 *
 * A dangling link yields `null` here rather than a link-inode identity,
 * which every caller already treats as "identity could not be established"
 * and fails closed on — the same answer `readdirSync` gives that path anyway.
 */
export function statDirIdentity(dir: string): DirIdentity | null {
  try {
    const st = statSync(dir, { bigint: true });
    if (!st.isDirectory()) return null;
    return {
      dev: st.dev,
      ino: st.ino,
      birthtimeNs: st.birthtimeNs,
      pathHash: createHash("sha256")
        .update(realpathSync.native(dir))
        .digest("hex"),
    };
  } catch {
    return null;
  }
}

export function sameDirIdentity(
  a: DirIdentity,
  b: DirIdentity | null,
): boolean {
  // A filesystem with no inode identity must not turn two zero placeholders
  // into proof that an enumeration still names the same directory. Keep the
  // zero identity distinct from null: null can mean a legitimately absent
  // directory in sameDirIdentity2.
  if (b === null || a.ino === 0n || a.ino !== b.ino) return false;
  // Preserve the original sufficient proof, including on filesystems without
  // a reliable birth time. Extra metadata is needed only to relax a device
  // mismatch, never to replace an already-matching device/inode pair.
  if (a.dev === b.dev) return true;
  return (
    a.birthtimeNs !== undefined &&
    a.birthtimeNs > 0n &&
    a.birthtimeNs === b.birthtimeNs &&
    a.pathHash !== undefined &&
    a.pathHash === b.pathHash &&
    a.volumeUUID !== undefined &&
    VOLUME_UUID_RE.test(a.volumeUUID) &&
    a.volumeUUID === b.volumeUUID
  );
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
export function sameDirIdentity2(
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
 * New tokens append birth time in nanoseconds and a SHA-256 hash of the
 * canonical target path. The arm-time token also carries a stable volume UUID
 * when available. Tokens without volume proof retain strict device comparison.
 * The driver and fence share this rendering so transport cannot discard the extra proof.
 */
export function stateDirIdentityToken(dir: string): string {
  const id = statDirIdentity(dir);
  return identityToken(id);
}

function identityToken(id: DirIdentity | null): string {
  if (id === null || id.ino === 0n) return "";
  return `${id.dev}:${id.ino}:${id.birthtimeNs}:${id.pathHash}${id.volumeUUID === undefined ? "" : `:${id.volumeUUID}`}`;
}

/** Arm-time baseline with stable volume proof when the platform can supply it. */
export async function captureStateDirIdentityToken(
  dir: string,
  readVolume: VolumeIdentityReader = readVolumeIdentity,
): Promise<string> {
  const before = statDirIdentity(dir);
  if (before === null) return "";
  const volume = await readVolume(dir);
  if (!sameDirIdentity(before, statDirIdentity(dir))) return "";
  return identityToken(
    volume !== null && VOLUME_UUID_RE.test(volume)
      ? { ...before, volumeUUID: volume }
      : before,
  );
}

/**
 * The inverse, and deliberately strict about SHAPE while lenient about
 * ABSENCE: `''`/unset means "no baseline was inherited". The override fence
 * refuses that absence; non-override interactive paths establish their own
 * baseline. A value that is PRESENT but unparseable is a different
 * thing entirely — something set this variable and this process cannot tell
 * what it meant — so it returns `null` and the caller fails closed.
 */
export function parseDirIdentityToken(
  token: string,
): { kind: "absent" } | { kind: "ok"; id: DirIdentity } | { kind: "bad" } {
  if (token === "") return { kind: "absent" };
  const m =
    /^(\d+):(\d+)(?::(\d+):([0-9a-f]{64})(?::([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?)?$/.exec(
      token,
    );
  if (m === null || (m[5] !== undefined && !VOLUME_UUID_RE.test(m[5])))
    return { kind: "bad" };
  if (BigInt(m[2] as string) === 0n) return { kind: "bad" };
  // `BigInt`, with no safe-integer ceiling: a 64-bit device or inode above
  // `Number.MAX_SAFE_INTEGER` is a legitimate value on some filesystems, and
  // rejecting it here would refuse every child fence on such a machine even
  // though the directory never changed. The regex has already established
  // both groups are digits, so this cannot throw.
  return {
    kind: "ok",
    id: {
      dev: BigInt(m[1] as string),
      ino: BigInt(m[2] as string),
      ...(m[3] === undefined
        ? {}
        : { birthtimeNs: BigInt(m[3]), pathHash: m[4] as string }),
      ...(m[5] === undefined ? {} : { volumeUUID: m[5] }),
    },
  };
}

/**
 * Re-confirm the state directory is still the one an earlier enumeration
 * read, or fail closed — the primitive that closes the class of races earlier
 * fixes only narrowed (statSync-then-later-read ordering, then an
 * `ENOENT`-only indeterminate flag on the later read, both defeated by a
 * rename-and-recreate that raises no `ENOENT` anywhere) instead of patching
 * the next specific window a reviewer finds.
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
 * refuse rather than assume.
 */
export function assertStateDirIdentityUnchanged(
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
    "directory that moved — the file never raises ENOENT, only this path does.",
    "An outcome reply has no undo, so this refuses rather than trust",
    'a read that cannot tell "nobody is driving" from "the directory moved".',
  );
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
export function leaseLock(path: string, pr: string) {
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
export function treeLeaseLock(path: string) {
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
 * claimant waiting out an in-flight push held the state mutex for the whole
 * wait, blocking every other mutation on the PR). Acquiring it first,
 * outside the state mutex, is what keeps that wait from blocking anything
 * else.
 *
 * Nothing anywhere takes `prRemoteMutationLock` after `treeLeaseLock`:
 * `claimPrLease`'s own touch of it happens AFTER `claimTreeLease` has
 * already released `treeLeaseLock` for that call — the two are never held
 * simultaneously by one caller in that direction either. A single,
 * consistent order across every caller that holds more than one of this
 * module's locks at once is what rules out a cycle; see `lock.ts`'s own
 * header for why a mkdir-based mutex has no cheaper way to detect one.
 */
export function prRemoteMutationLock(stateDir: string, pr: string) {
  return createLock(
    prRemoteMutationLockPathFor(stateDir, pr),
    "drive-state.ts (pr remote mutation)",
    pr,
  );
}

/**
 * Pure filter: which of these already-listed names are lease files for `pr`?
 * Extracted so a caller that has ALREADY read a directory once — the
 * external-mutation fence's override path, which cannot afford a SECOND read
 * of the same directory without reopening the exact race it exists to close
 * (renaming the directory away and recreating an empty one at the same path
 * defeats an `ENOENT`-keyed check, since neither operation raises `ENOENT`)
 * — can filter its own snapshot in-memory instead of asking the filesystem
 * again. `leaseFilesFor` below is this plus the directory read, for every
 * OTHER caller, which has no such snapshot to reuse.
 */
export function filterLeaseFilesFor(
  names: string[],
  stateDir: string,
  pr: string,
): string[] {
  // Through the same canonicalizer the WRITER uses, so the two agree by
  // construction rather than by each caller remembering to normalize first
  //. Already-canonical input is unchanged, so this is a
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
export function filterLeaseFilesForActor(
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
