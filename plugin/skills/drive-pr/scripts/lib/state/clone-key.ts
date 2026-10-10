/**
 * A stable, filename-safe identity for the CLONE `resolveStateDir` is
 * running against — the counterpart to `actor.ts`'s `worktreeKey`,
 * which identifies the TREE.
 *
 * Built from a PERSISTED identifier, not from `commonDir`'s own path: a hash
 * of `realpath(commonDir)` alone makes the identity depend on this clone's
 * current absolute pathname, so moving or renaming the checkout — the
 * directory itself untouched — silently changes the key. The moved clone's
 * `.git` still holds every prior lock/lease/state file, all now addressed
 * under the OLD key, while `ensureMigratedFromLegacy` sees a fresh,
 * unmigrated NEW key with nothing under it, writes the migrated marker, and
 * starts round 0 — abandoning every parked decision and round budget the
 * whole an earlier change guard exists to protect, with no error anywhere
 * (docomply-review, a reference-implementation pull request). A symlink hop resolves to the same physical
 * path and was never the gap; a genuine relocation changes the path itself,
 * which no amount of `realpathSync` can see past.
 *
 * `persistedCloneId` closes it by minting an identifier ONCE and writing it
 * inside `commonDir` — which moves WITH a rename or relocation, since it is
 * the CONTENTS of `.git`, never the path leading to it. A local file also
 * keeps the property `realpath(commonDir)` was chosen for in the first
 * place: two separate clones of the same repo never collide (each has its
 * own `.git`, hence its own id file), the way a remote-URL-derived identity
 * would.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../cli.ts";
import {
  createExclusiveDurable,
  ExclusiveDurabilityUnconfirmed,
  ExclusiveWriteOwnFailure,
} from "./fsutil.ts";

/**
 * Lives inside `commonDir` itself — see the module doc comment. Exported so
 * `artifacts.ts` can recognise this exact name as clone-identity metadata
 * that must stay bound to `commonDir` (chatgpt-codex-connector, a reference-implementation pull request
 * round 22) rather than duplicating the literal — a second copy of this
 * string is exactly the drift this module's own singular-source-of-truth
 * posture exists to avoid.
 */
export const CLONE_ID_FILE = "drive-pr-clone-id";

/**
 * The only shape `persistedCloneId` ever mints (`randomUUID()`, confirmed by
 * repository grep — no other production path writes this file). Read back
 * against this pattern rather than accepted as any nonempty string: a
 * truncated or otherwise corrupted file is still nonempty, and silently
 * hashing whatever bytes survived would resolve a DIFFERENT, valid-looking
 * state directory, abandoning this clone's parked decisions and round budget
 * under the original key with no error anywhere (docomply-review, a reference-implementation pull request
 * round 6).
 *
 * Pinned to the version-4 and RFC-4122-variant nibbles specifically
 * (`4` and `[89ab]`), not just the generic 8-4-4-4-12 hex shape: the
 * broader pattern also accepts a syntactically valid but impossible-to-mint
 * UUID (e.g. every nibble `1`) as though it were real, hashing it into a
 * state directory `randomUUID()` could never have produced (docomply-
 * review, PR #4618 round 12).
 *
 * Case-sensitive on purpose — no `/i` flag: `randomUUID()` (the sole
 * production writer, confirmed by repository grep) always persists
 * lowercase text, and `hashCloneId` below hashes case-sensitively. Accepting
 * uppercase would let an otherwise-valid but re-cased id hash to a
 * DIFFERENT state-directory key than the one this clone's real identity
 * already resolved to, silently stranding its round state (docomply-review,
 * a reference-implementation pull request round 13).
 */
const CLONE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readCloneId(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch (e) {
    // Only "the file was never minted" (ENOENT) means unminted. Any other
    // read failure — permission denied, an I/O error, `path` reappearing as
    // a directory — is not evidence of that, and treating it as though it
    // were would let `peekCloneKey()` report `null` for a clone that
    // actually already has an identity: its caller (the standalone fence's
    // legacy fallback) then inspects the obsolete legacy directory instead
    // of the real one, missing an active lease there (chatgpt-codex-
    // connector, PR #4618 round 7).
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    fail(
      2,
      `drive-state.ts: could not read the clone identity at ${path}.`,
      `${e instanceof Error ? e.message : String(e)}`,
      "Treating this as a fresh, unminted identity would silently resolve a",
      "DIFFERENT state directory and risk missing this clone's actual",
      "in-progress state. Fix the underlying read failure, or set",
      "$DRIVE_PR_STATE_DIR to bypass this resolution entirely.",
    );
  }
  if (text === "") {
    fail(
      2,
      `drive-state.ts: the clone identity at ${path} is empty.`,
      "Expected a UUID minted by randomUUID(); found a zero-byte file — a",
      "truncated write, never a value this module itself ever persists.",
      "Treating this as a fresh, unminted identity would silently resolve a",
      "DIFFERENT state directory and abandon this clone's parked decisions",
      "and round budget under the original key. If this file was",
      "truncated by something outside drive-pr, restore it from a backup, or",
      "remove it to mint a fresh identity — accepting that this clone's",
      "prior state directory becomes unreachable through cloneKey() — or set",
      "$DRIVE_PR_STATE_DIR to bypass this resolution entirely.",
    );
  }
  if (!CLONE_ID_RE.test(text)) {
    fail(
      2,
      `drive-state.ts: the clone identity at ${path} is corrupted.`,
      `Expected a UUID minted by randomUUID(); found: ${JSON.stringify(text.slice(0, 80))}`,
      "Treating this as a fresh, unminted identity would silently resolve a",
      "DIFFERENT state directory and abandon this clone's parked decisions",
      "and round budget under the original key. If this file was",
      "truncated or corrupted by something outside drive-pr, restore it from",
      "a backup, or remove it to mint a fresh identity — accepting that this",
      "clone's prior state directory becomes unreachable through cloneKey() —",
      "or set $DRIVE_PR_STATE_DIR to bypass this resolution entirely.",
    );
  }
  return text;
}

/**
 * The persisted, path-independent identifier — minted once per clone, read
 * back on every later call.
 *
 * Minting safely under a race depends on `createExclusiveDurable` (see its
 * own doc in `fsutil.ts`) guaranteeing this file is observable in exactly
 * two states, never a third: absent, or complete-and-durable. Two processes
 * hitting a brand-new clone at once must not each keep their OWN
 * freshly-generated id — the loser has to adopt whichever one actually made
 * it to disk, or the two would address two different state directories for
 * the rest of this clone's life, exactly the split this function exists to
 * prevent, just triggered by a race instead of a move — and that only holds
 * if "made it to disk" can never mean "made it to disk, but not yet
 * finished, and I read it anyway".
 *
 * `createExclusiveDurable` publishes via an exclusive `link(2)` from an
 * already-fully-written, fsynced temp file, never via a direct open of THIS
 * path — see its doc for why an earlier version of this file did that and
 * it was two separate bugs (docomply-review, a reference-implementation pull request round 3;
 * chatgpt-codex-connector, a reference-implementation pull request round 3). One consequence worth stating
 * explicitly: for this call's own temp-write/fsync/close/link failure
 * (`ExclusiveWriteOwnFailure`), and for a genuine `EEXIST` race lost to
 * another process's already-complete publish, this call NEVER created this
 * path itself (a successful `link` is the only thing that can create it,
 * and both of those shapes fail at or before the `link`). So there is
 * nothing of this call's own to clean up on failure, and re-reading is
 * safe: `path` is either still whatever it was before this call started,
 * or another process's complete, valid publish.
 *
 * A THIRD shape breaks that pattern on purpose: `ExclusiveDurabilityUnconfirmed`
 * means the `link` itself already succeeded and only the FOLLOWING directory
 * fsync failed — so this call DID create `path`, and re-reading it afterward
 * would silently treat this call's own unconfirmed publish as though it were
 * a racing winner's committed value (docomply-review, a reference-implementation pull request round 4). The
 * caller below must check for it explicitly, before the generic re-read.
 */
function persistedCloneId(commonDir: string): string {
  const path = join(commonDir, CLONE_ID_FILE);
  const existing = readCloneId(path);
  if (existing !== null) return existing;

  const minted = randomUUID();
  try {
    createExclusiveDurable(path, `${minted}\n`);
    return minted;
  } catch (e) {
    if (e instanceof ExclusiveDurabilityUnconfirmed) {
      // `link` already published `path` with THIS call's own content — a
      // racing winner never entered the picture — so re-reading and
      // adopting it here would dress up this call's own unconfirmed publish
      // as though another process had vouched for it. Refuse instead: see
      // the class's own doc and this function's, above.
      fail(
        2,
        `drive-state.ts: cannot confirm the clone identity just published at ${path}.`,
        "The link succeeded, but fsync-ing its containing directory failed",
        "afterward, so a crash right now could still lose it —",
        "trusting the value anyway risks silently abandoning state under",
        "this key later. Fix the permissions or free space on the git common",
        "directory, or set $DRIVE_PR_STATE_DIR to bypass this resolution",
        "entirely.",
        `Underlying failure: ${e.message}`,
      );
    }
    const raced = readCloneId(path);
    if (raced !== null) return raced;
    fail(
      2,
      `drive-state.ts: cannot persist a clone identity at ${path}.`,
      "This file is what keeps the state directory stable across a rename or",
      "relocation of this checkout — without it, resolveStateDir",
      "has no reliable key to form. Fix the permissions on the git common",
      "directory, or set $DRIVE_PR_STATE_DIR to bypass this resolution",
      "entirely.",
      ...(e instanceof ExclusiveWriteOwnFailure
        ? [`Underlying failure: ${e.message}`]
        : []),
    );
  }
}

/** `sha256(id)`, truncated to 16 hex chars — shared by `cloneKey` and `peekCloneKey`. */
function hashCloneId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/**
 * `sha256(persistedCloneId(commonDir))`, truncated to 16 hex chars — the same
 * truncation `actor.ts`'s `worktreeKey` uses, for the same reason: short
 * enough to read in a path, long enough that two clones colliding is not a
 * practical concern.
 */
export function cloneKey(commonDir: string): string {
  return hashCloneId(persistedCloneId(commonDir));
}

/**
 * Read-only counterpart to `cloneKey`: the hashed key if a clone identity is
 * ALREADY persisted at `commonDir`, or `null` if none exists yet — never
 * mints or persists one.
 *
 * For a caller that must preview what `cloneKey`/`defaultStateDirFor` would
 * resolve to WITHOUT the side effect of creating that identity — a bare,
 * no-`--apply` dry run of `migrate-legacy-state.ts` promises to write nothing,
 * but calling `cloneKey` directly on a clone with no persisted id yet mints
 * and durably persists one via `createExclusiveDurable`, contradicting that
 * promise (docomply-review, a reference-implementation pull request round 4). There is no way to preview
 * the value `cloneKey` WOULD mint — it is a fresh `randomUUID()`, not a
 * function of `commonDir` — so a caller in this position has only two honest
 * options: mint now (breaking the dry-run promise), or report that the
 * eventual key is not yet determined. This function is for the latter.
 */
export function peekCloneKey(commonDir: string): string | null {
  const existing = readCloneId(join(commonDir, CLONE_ID_FILE));
  return existing === null ? null : hashCloneId(existing);
}
