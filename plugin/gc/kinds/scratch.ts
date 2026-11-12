import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exclusiveGcLock } from "../../shared/gc-lock.ts";
import { processTable, type ProcessRow } from "../../shared/process-table.ts";
import {
  readScratchOwner,
  SCRATCH_OWNER_FILE,
} from "../../shared/scratch-owner.ts";
import {
  type Failure,
  failed,
  ok,
  type Outcome,
} from "../../shared/outcome.ts";
import type { CollectionKind, Proof, Resource } from "../types.ts";
import { currentMs } from "../../shared/time.ts";

/** Why a scratch scan stopped short. */
type ScanFailure = {
  ok: false;
  failure: Failure<"timed-out" | "unreadable-owner">;
};
/**
 * Walk without following links; a scope is live when ANY nested owner lives.
 * A walk past its deadline fails `timed-out`, and an owner record that is no
 * file fails `unreadable-owner`: the kind records either as unverified.
 */
export function scratchProof(
  root: string,
  rows: ProcessRow[] | null,
  idleDays: number,
  now = currentMs(),
  deadline = currentMs() + 30_000,
): Outcome<Proof, "timed-out" | "unreadable-owner"> {
  if (rows === null)
    return ok({ state: "unverified", reason: "process table unavailable" });
  if (lstatSync(root).isSymbolicLink())
    return ok({ state: "finding", reason: "scratch root is a symbolic link" });
  let owners = 0;
  let newest = 0;
  let live = false;
  let unknown = false;
  const inspectOwner = (path: string): void => {
    const owner = readScratchOwner(path);
    owners++;
    const current = rows.find((row) => row.pid === owner.pid);
    if (owner.start === null || (current && !current.start)) unknown = true;
    else if (current?.start === owner.start && !current.stat.startsWith("Z"))
      live = true;
  };
  // The scan holds the kind's lock; an unbounded tree, or one flat directory
  // of many files, must not stall it.
  const late = () =>
    currentMs() > deadline
      ? failed("timed-out", "Scratch scan exceeded its deadline")
      : null;
  const walk = (path: string): ScanFailure | null => {
    const entering = late();
    if (entering) return entering;
    newest = Math.max(newest, lstatSync(path).mtimeMs);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const passed = late();
      if (passed) return passed;
      const child = join(path, entry.name);
      newest = Math.max(newest, lstatSync(child).mtimeMs);
      if (entry.name === SCRATCH_OWNER_FILE) {
        if (!entry.isFile())
          return failed(
            "unreadable-owner",
            `Unreadable owner record: ${child}`,
          );
        inspectOwner(path);
      } else if (entry.isDirectory()) {
        const nested = walk(child);
        if (nested) return nested;
      }
    }
    return null;
  };
  const walked = walk(root);
  if (walked) return walked;
  // A nested scope cannot supply the missing registration of its parent.
  if (!readdirSync(root).includes(SCRATCH_OWNER_FILE))
    return ok({
      state: "finding",
      reason: "scratch scope has no owner record",
    });
  if (live)
    return ok({
      state: "live",
      reason: "a scope owner in the subtree is alive",
    });
  if (unknown)
    return ok({
      state: "unverified",
      reason: "a scope owner's process identity is unreadable",
    });
  if (now - newest < idleDays * 86_400_000)
    return ok({ state: "live", reason: "scratch idle guard has not elapsed" });
  return ok({
    state: "dead",
    reason: `${owners} recorded scope owner(s) exited; idle guard elapsed`,
    reportOnly:
      "scratch is report-only until fixture registration proves every holder gone",
  });
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
      return ok([...resources.values()]);
    },
    prove: async (resource) => {
      const proof = scratchProof(resource.id, await processTable(), idleDays);
      return proof.ok
        ? proof.value
        : { state: "unverified", reason: proof.failure.reason };
    },
    collect: async () => ({
      outcome: "refused",
      reason: "scratch is report-only until fixture registration",
    }),
    describe: (resource) => resource.id,
    exclusive: (body) => exclusiveGcLock("scratch", body),
  };
}
