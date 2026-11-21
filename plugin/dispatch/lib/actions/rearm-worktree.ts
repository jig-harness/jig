import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { worktreePathKey } from "../../../skills/drive-pr/scripts/lib/state/actor.ts";
import { cloneId } from "../../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { peekCloneKey } from "../../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { git, gitIdentityEnv } from "../../../shared/proc.ts";
import { failureText } from "../text.ts";

/** A proven mismatch requires readable identities. */
export async function originalTree(
  path: string,
  actor: string,
  clone: string,
): Promise<{ why: string; proven: boolean } | null> {
  try {
    if (`wt-${worktreePathKey(realpathSync(path))}` !== actor)
      return {
        why: `${path}: its actor differs from the stopped driver's ${actor}`,
        proven: true,
      };
    const common = await git(["rev-parse", "--git-common-dir"], {
      cwd: path,
      env: gitIdentityEnv(),
      stderr: "pipe",
      timeoutSec: 10,
    });
    if (common.code !== 0)
      return {
        why: `${path}: its clone identity cannot be read (git exit ${common.code}: ${common.stderr.trim()})`,
        proven: false,
      };
    const local = peekCloneKey(resolve(path, common.stdout.trim()));
    if (local !== null && cloneId(local) === clone) return null;
    return {
      why: `${path}: its clone identity ${local === null ? "missing" : cloneId(local)} differs from the stopped driver's ${clone}`,
      proven: local !== null,
    };
  } catch (error) {
    return {
      why: `${path}: its original-tree identity cannot be read: ${failureText(error)}`,
      proven:
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT",
    };
  }
}
