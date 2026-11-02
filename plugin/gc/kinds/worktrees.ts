/** Inventory is safe without the session opener's lifecycle and lock protocol. */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
import {
  orcaEnvelope,
  orcaFailure,
  orcaResult,
  runOrca,
} from "../../shared/orca.ts";
import { run } from "../../shared/proc.ts";
import { HOOKS_DIR, hookPath } from "../../shared/worktree-hooks.ts";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { gcGit as git } from "../git.ts";
import { localSteps, removeThroughOrca } from "../worktree-removal.ts";
import {
  canonicalWorktree,
  orcaLiveness,
  runtimeWorktreeProof,
  worktreePolicy,
  worktreeProof,
  type WorktreePolicy,
} from "./worktree-proof.ts";
import type { CollectionKind, Resource } from "../types.ts";

/** Seconds `orca worktree rm` may take: it deletes the checkout's files. */
const ORCA_REMOVE_TIMEOUT_SEC = 300;
/** The time a removal through Orca may take: the remove hook, the park and the removal. */
const ORCA_REMOVAL_LIMIT_MS = 30 * 60_000;

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
/**
 * The worktrees Orca manages in `repository`, by path as git spells it, with
 * Orca's id of each; empty when Orca has no such repository. A list Orca
 * cannot give in full fails the inventory: a checkout it manages must not
 * pass for a plain one.
 */
async function orcaWorktrees(
  command: string,
  repository: string,
): Promise<Map<string, string>> {
  const done = await runOrca(command, [
    "worktree",
    "list",
    "--repo",
    `path:${repository}`,
    "--json",
  ]);
  const envelope = orcaEnvelope(done.stdout);
  if (envelope?.ok === false && envelope.code === "repo_not_found")
    return new Map();
  const result = orcaResult(done);
  if (result === null)
    throw new GcError(
      `Orca's worktree list could not be read ${orcaFailure(done)}`,
    );
  if (result.truncated !== false || !Array.isArray(result.worktrees))
    throw new GcError("Orca's worktree list was incomplete or malformed");
  const managed = new Map<string, string>();
  for (const row of result.worktrees) {
    if (
      !isMapping(row) ||
      typeof row.id !== "string" ||
      typeof row.path !== "string"
    )
      throw new GcError("Malformed Orca worktree record");
    managed.set(canonicalWorktree(row.path), row.id);
  }
  return managed;
}
function orcaId(resource: Resource): string | null {
  return isMapping(resource.details) &&
    resource.details.runtime === "orca" &&
    typeof resource.details.orca === "string"
    ? resource.details.orca
    : null;
}
/**
 * Refuse a remove hook, or a file beside it, that is not the one the declared
 * base-branch commit holds: a branch that changed either has not had that code
 * reviewed into the base, and collection would run it with the user's
 * credentials. A helper the hook starts from outside the hooks directory is
 * not covered; hooks keep their helpers beside them.
 */
async function assertBaseHook(
  repository: string,
  declaration: string,
  hook: string,
): Promise<void> {
  const tip = / @ ([0-9a-f]{40,64})$/.exec(declaration)?.[1];
  if (tip === undefined)
    throw new GcError("the base-branch commit of the declaration is unknown");
  const held = await baseHookFiles(repository, tip);
  if (!held.includes(`${HOOKS_DIR}/remove`))
    throw new GcError(
      `kept: ${HOOKS_DIR}/remove is not in the base branch, so its code was never reviewed there`,
    );
  const worktree = dirname(dirname(dirname(hook)));
  const local = localHookFiles(worktree);
  const differs = (name: string): never => {
    throw new GcError(
      `kept: ${name} differs from the base branch's; remove the worktree by hand`,
    );
  };
  for (const name of local) if (!held.includes(name)) differs(name);
  for (const name of held) {
    if (!local.includes(name)) differs(name);
    const base = await git(repository, ["show", `${tip}:${name}`]);
    if (base !== readFileSync(join(worktree, name), "utf8").trimEnd())
      differs(name);
  }
}
/** The files of the hooks directory in the base-branch commit, as repository paths. */
async function baseHookFiles(
  repository: string,
  tip: string,
): Promise<string[]> {
  const listing = await git(repository, [
    "ls-tree",
    "-r",
    "--name-only",
    tip,
    "--",
    HOOKS_DIR,
  ]).catch(() => "");
  return listing.split("\n").filter((name) => name !== "");
}
/** The files of the worktree's hooks directory, as repository paths. */
function localHookFiles(worktree: string): string[] {
  return readdirSync(join(worktree, HOOKS_DIR), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      relative(worktree, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    );
}
/**
 * Collect a worktree Orca manages through Orca: the repository's remove hook
 * inside it, its reflection findings parked, then `orca worktree rm`, so its
 * card, terminals and agent records go with it. Never `git worktree remove`.
 */
async function collectThroughOrca(
  command: string,
  resource: Resource,
  id: string,
  repository: string,
  declaration: string,
): Promise<Awaited<ReturnType<CollectionKind["collect"]>>> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  try {
    // The retiring branch supplies the hook, and this runs unattended, so the
    // hook runs only if the declared base-branch commit holds the same one.
    const hook = hookPath(resource.id, "remove");
    if (hook !== null) await assertBaseHook(repository, declaration, hook);
    const removed = await removeThroughOrca({
      worktree: resource.id,
      id,
      force: false,
      orca: (args) =>
        run([command, ...args, "--json"], {
          timeoutSec: ORCA_REMOVE_TIMEOUT_SEC,
        }),
      log,
      steps: {
        ...localSteps(Date.now() + ORCA_REMOVAL_LIMIT_MS, log),
        // The hook may run for minutes, and Orca can start an agent meanwhile.
        admit: async (worktree) => {
          const live = await orcaLiveness(command, worktree);
          if (live !== null)
            throw new GcError(`kept after the hook: ${live.reason}`);
        },
      },
    });
    return {
      outcome: "collected",
      reason: `removed through Orca: ${removed.hook === null ? `no ${HOOKS_DIR}/remove` : `ran ${HOOKS_DIR}/remove`}, parked reflection findings, orca worktree rm`,
      details: {
        ...(isMapping(resource.details) ? resource.details : {}),
        hook: removed.hook,
        parked: true,
      },
    };
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export function worktreesKind(
  repository: string,
  roots: string[],
  declaration: string,
  idleDays = 7,
  policy?: WorktreePolicy,
  orca?: string,
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
            // Native separators: Git for Windows prints forward slashes.
            id: normalize(path.slice(9)),
            details: {
              locked: fields.some(
                (field) => field === "locked" || field.startsWith("locked "),
              ),
            } as Record<string, unknown>,
          };
        });
      if (entries.length === 0)
        throw new GcError("Git worktree inventory was empty or malformed");
      const canonical = roots.map((root) => {
        try {
          // As git spells a worktree: links resolved and, on Windows, 8.3
          // short names expanded.
          return realpathSync.native(root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
          throw error;
        }
      });
      const selected = entries
        .slice(1)
        .filter((entry) => canonical.some((root) => within(entry.id, root)));
      if (orca === undefined || selected.length === 0) return selected;
      const managed = await orcaWorktrees(orca, repository);
      for (const entry of selected) {
        const id = managed.get(canonicalWorktree(entry.id));
        entry.details.runtime = id === undefined ? "none" : "orca";
        if (id !== undefined) entry.details.orca = id;
      }
      return selected;
    },
    prove: async (resource) => {
      if (isMapping(resource.details) && resource.details.locked === true)
        return { state: "live", reason: "worktree is locked" };
      const resolved = policy ?? (await worktreePolicy(repository));
      return orca !== undefined && orcaId(resource) !== null
        ? runtimeWorktreeProof(resource.id, resolved, idleDays, { orca })
        : worktreeProof(resource.id, resolved, idleDays);
    },
    collect: async (resource) => {
      const id = orcaId(resource);
      if (orca !== undefined && id !== null)
        return collectThroughOrca(orca, resource, id, repository, declaration);
      return {
        outcome: "refused",
        reason: "uncoordinated worktrees are report-only",
      };
    },
    describe: (resource) => resource.id,
    exclusive: (body) => body(),
  };
}
