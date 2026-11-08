/**
 * What keeps a working tree driven, as the drive's database records it: a
 * live driver holding the tree's single-instance lock, and the live session
 * or tree leases its actor holds. It is the `drivers` reader
 * `shared/idle-holder.ts` takes, for a caller deciding whether another
 * checkout may take the tree's branch from it.
 *
 * It reads without creating, migrating or importing anything, and fails
 * closed: a clone that never minted a drive identity, and so has no drive
 * state, has no driver; a database or state directory it cannot read, or
 * a clone the database has not read in yet, is `null`, "cannot tell".
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { HeldTree } from "../../../../../shared/idle-holder.ts";
import { liveHolderIn } from "../driver/locks.ts";
import { actorOfTreeKey, worktreePathKey } from "./actor.ts";
import { peekCloneKey } from "./clone-key.ts";
import { dbPathFor, peekImport } from "./db.ts";
import { leaseHolderLabel, liveLeasesOfTree } from "./lease-records.ts";
import { lockNameOfTreeKey, stateDirOfClone } from "./store.ts";

/** One reason per live driver or lease on `tree`; `[]` for none, `null` when that cannot be read. */
export function treeDrivers(tree: HeldTree): string[] | null {
  let db: Database | null = null;
  try {
    const key = peekCloneKey(tree.commonDir);
    if (key === null) return [];
    const stateDir = stateDirOfClone(key);
    if (!existsSync(dbPathFor(stateDir)))
      return existsSync(stateDir) ? null : [];
    if (peekImport(stateDir) === null) return null;
    db = new Database(dbPathFor(stateDir), { readonly: true });
    const clone = basename(stateDir);
    const treeKey = worktreePathKey(tree.path);
    const reasons: string[] = [];
    const driver = liveHolderIn(db, clone, lockNameOfTreeKey(treeKey));
    if (driver !== null)
      reasons.push(
        `a live driver${driver.diag ? ` of PR #${driver.diag.pr}` : ""} holds it (pid ${driver.pid} on ${driver.host || "this host"})`,
      );
    for (const lease of liveLeasesOfTree(db, clone, actorOfTreeKey(treeKey)))
      reasons.push(`a live lease of ${leaseHolderLabel(lease)} holds it`);
    return reasons;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
