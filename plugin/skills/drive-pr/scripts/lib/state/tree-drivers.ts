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
 * a clone the database has not read in yet, is "cannot tell", with why, so
 * the reason a holder is kept says what could not be read. A failure the
 * drive's state layer reports as an exit has printed its reason to
 * standard error already, and the answer names the exit.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { ExitError } from "../../../../../shared/cli.ts";
import { swallow } from "../../../../../shared/errors.ts";
import type { HeldTree } from "../../../../../shared/idle-holder.ts";
import { liveHolderIn } from "../driver/locks.ts";
import { actorOfTreeKey, worktreePathKey } from "./actor.ts";
import { peekCloneKey } from "./clone-key.ts";
import { dbPathFor, peekImport } from "./db.ts";
import { leaseHolderLabel, liveLeasesOfTree } from "./lease-records.ts";
import { lockNameOfTreeKey, stateDirOfClone } from "./store.ts";

/** Why the drive's state could not be read, from what was thrown. */
function unreadableWhy(error: unknown): string {
  if (error instanceof ExitError)
    return `the drive's state layer stopped with exit ${error.code} (its reason is on standard error)`;
  return error instanceof Error ? error.message : String(error);
}

/** One reason per live driver or lease on `tree`; `[]` for none, or why that cannot be read. */
export function treeDrivers(tree: HeldTree): string[] | { unreadable: string } {
  let db: Database | null = null;
  try {
    const key = peekCloneKey(tree.commonDir);
    if (key === null) return [];
    const stateDir = stateDirOfClone(key);
    const path = dbPathFor(stateDir);
    if (!existsSync(path))
      return existsSync(stateDir)
        ? {
            unreadable: `the clone's drive state directory ${stateDir} has no database ${path} beside it`,
          }
        : [];
    if (peekImport(stateDir) === null)
      return {
        unreadable: `the drive's database ${path} has not read this clone's state in yet`,
      };
    db = new Database(path, { readonly: true });
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
  } catch (error) {
    swallow(
      error,
      "the drive's records of a tree could not be read; the tree counts as driven",
    );
    return { unreadable: unreadableWhy(error) };
  } finally {
    db?.close();
  }
}
