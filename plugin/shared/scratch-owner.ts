import { GcError } from "./gc-error.ts";
/** Owner records accompany every scope, including scopes nested in a parent. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "./config-layers.ts";
import { ownIdentity } from "./liveness.ts";
import { currentIso, parseMs } from "./time.ts";

export const SCRATCH_OWNER_FILE = ".jig-scratch-owner.json";
/**
 * `start` is null where the process creation identity could not be captured
 * (no `ps`, an incompatible one, restricted process inspection). The scope
 * stays usable, and a collector treats its owner as unverifiable and keeps it.
 */
export interface ScratchOwner {
  version: 1;
  pid: number;
  start: string | null;
  createdAt: string;
}
let captured: ScratchOwner | undefined;
/** Captured once per process, from the shared process identity, an unavailable start time included. */
function scratchOwner(): ScratchOwner {
  captured ??= {
    version: 1,
    pid: process.pid,
    start: ownIdentity().start || null,
    createdAt: currentIso(),
  };
  return captured;
}
export function writeScratchOwner(root: string): void {
  writeFileSync(
    join(root, SCRATCH_OWNER_FILE),
    JSON.stringify({ ...scratchOwner(), createdAt: currentIso() }),
    { flag: "wx", mode: 0o600 },
  );
}
export function readScratchOwner(root: string): ScratchOwner {
  const owner: unknown = JSON.parse(
    readFileSync(join(root, SCRATCH_OWNER_FILE), "utf8"),
  );
  if (
    !isMapping(owner) ||
    owner.version !== 1 ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !(
      owner.start === null ||
      (typeof owner.start === "string" && owner.start)
    ) ||
    typeof owner.createdAt !== "string" ||
    !Number.isFinite(parseMs(owner.createdAt))
  )
    throw new GcError(`Invalid scratch owner: ${root}`);
  return {
    version: 1,
    pid: owner.pid,
    start: owner.start as string | null,
    createdAt: owner.createdAt,
  };
}
