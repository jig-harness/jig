import { GcError } from "../../shared/gc-error.ts";
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exclusiveGcLock } from "../../shared/gc-lock.ts";
import { processTable, type ProcessRow } from "../../shared/process-table.ts";
import {
  readScratchOwner,
  SCRATCH_OWNER_FILE,
} from "../../shared/scratch-owner.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";

/** Walk without following links; a scope is live when ANY nested owner lives. */
export function scratchProof(
  root: string,
  rows: ProcessRow[] | null,
  idleDays: number,
  now = Date.now(),
): Proof {
  if (rows === null)
    return { state: "unverified", reason: "process table unavailable" };
  if (lstatSync(root).isSymbolicLink())
    return { state: "finding", reason: "scratch root is a symbolic link" };
  let owners = 0;
  let newest = 0;
  let live = false;
  let unknown = false;
  const inspectOwner = (path: string): void => {
    const owner = readScratchOwner(path);
    owners++;
    const current = rows.find((row) => row.pid === owner.pid);
    if (current && !current.start) unknown = true;
    else if (current?.start === owner.start && !current.stat.startsWith("Z"))
      live = true;
  };
  const walk = (path: string): void => {
    newest = Math.max(newest, lstatSync(path).mtimeMs);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      newest = Math.max(newest, lstatSync(child).mtimeMs);
      if (entry.name === SCRATCH_OWNER_FILE) {
        if (!entry.isFile())
          throw new GcError(`Unreadable owner record: ${child}`);
        inspectOwner(path);
      } else if (entry.isDirectory()) walk(child);
    }
  };
  walk(root);
  // A nested scope cannot supply the missing registration of its parent.
  if (!readdirSync(root).includes(SCRATCH_OWNER_FILE))
    return { state: "finding", reason: "scratch scope has no owner record" };
  if (live)
    return { state: "live", reason: "a scope owner in the subtree is alive" };
  if (unknown)
    return {
      state: "unverified",
      reason: "a scope owner's process identity is unreadable",
    };
  if (now - newest < idleDays * 86_400_000)
    return { state: "live", reason: "scratch idle guard has not elapsed" };
  return {
    state: "dead",
    reason: `${owners} recorded scope owner(s) exited; idle guard elapsed`,
    reportOnly:
      "scratch is report-only until fixture registration proves every holder gone",
  };
}
export function scratchKind(
  repository: string,
  prefixes: string[],
  declaration: string,
  idleDays: number,
): CollectionKind {
  return {
    name: "scratch",
    repository,
    declaration,
    inventory: async () => {
      const resources = new Map<string, Resource>();
      for (const prefix of prefixes) {
        const absolute = resolve(repository, prefix);
        let entries: Dirent[];
        try {
          entries = readdirSync(dirname(absolute), { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const entry of entries)
          if (
            entry.name.startsWith(basename(absolute)) &&
            (entry.isDirectory() || entry.isSymbolicLink())
          ) {
            const id = join(dirname(absolute), entry.name);
            resources.set(id, { id });
          }
      }
      return [...resources.values()];
    },
    prove: async (resource) =>
      scratchProof(resource.id, await processTable(), idleDays),
    collect: async () => ({
      outcome: "refused",
      reason: "scratch is report-only until fixture registration",
    }),
    describe: (resource) => resource.id,
    exclusive: (body) => exclusiveGcLock("scratch", body),
  };
}
