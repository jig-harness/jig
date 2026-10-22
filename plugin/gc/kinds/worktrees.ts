/** Inventory is safe without the session opener's lifecycle and lock protocol. */
import { realpathSync } from "node:fs";
import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
import { isAbsolute, relative, sep } from "node:path";
import { gcGit as git } from "../git.ts";
import {
  worktreePolicy,
  worktreeProof,
  type WorktreePolicy,
} from "./worktree-proof.ts";
import type { CollectionKind } from "../types.ts";

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
export function worktreesKind(
  repository: string,
  roots: string[],
  declaration: string,
  idleDays = 7,
  policy?: WorktreePolicy,
): CollectionKind {
  return {
    name: "worktrees",
    repository,
    declaration,
    inventory: async () => {
      const output = await git(repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      const entries = output
        .split("\0\0")
        .filter(Boolean)
        .map((block) => {
          const fields = block.split("\0");
          const path = fields.find((field) => field.startsWith("worktree "));
          if (!path) throw new GcError("Malformed Git worktree record");
          return {
            id: path.slice(9),
            details: {
              locked: fields.some(
                (field) => field === "locked" || field.startsWith("locked "),
              ),
            },
          };
        });
      if (entries.length === 0)
        throw new GcError("Git worktree inventory was empty or malformed");
      const canonical = roots.map((root) => {
        try {
          return realpathSync(root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
          throw error;
        }
      });
      return entries
        .slice(1)
        .filter((entry) => canonical.some((root) => within(entry.id, root)));
    },
    prove: async (resource) => {
      if (isMapping(resource.details) && resource.details.locked === true)
        return { state: "live", reason: "worktree is locked" };
      return worktreeProof(
        resource.id,
        policy ?? (await worktreePolicy(repository)),
        idleDays,
      );
    },
    collect: async () => ({
      outcome: "refused",
      reason: "uncoordinated worktrees are report-only",
    }),
    describe: (resource) => resource.id,
    exclusive: (body) => body(),
  };
}
