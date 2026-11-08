/**
 * The tree a stall or a pass deadline left work in, which its re-drive must run in: a fresh
 * tree would not carry uncommitted edits or unpushed commits. The drive
 * ledger names the tree by its key (`wt-<key>`, drive-pr's `resolveActor`)
 * and the host it is on (the label after the `@` of its clone), so this host
 * finds the open workspace whose path has that key.
 */
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { hostLabel } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { swallow } from "../../shared/errors.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { StaleCause } from "./types.ts";

/** The tree a ledger's driver ran in, and whether it is on this host. */
export function ledgerTree(ledger: Ledger): NonNullable<StaleCause["tree"]> {
  return {
    actor: ledger.driver.actor,
    here: ledger.driver.clone.endsWith(`@${hostLabel()}`),
  };
}

/** The open workspace whose tree is `actor`; `undefined` when none is. */
export function workspaceOfTree<W extends { path: string }>(
  workspaces: readonly W[],
  actor: string,
): W | undefined {
  return workspaces.find((w) => {
    try {
      return `wt-${worktreePathKey(w.path)}` === actor;
    } catch (error) {
      // A workspace whose path no longer resolves holds no tree.
      swallow(error, "a workspace path that does not resolve");
      return false;
    }
  });
}
