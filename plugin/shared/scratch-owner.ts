import { GcError } from "./gc-error.ts";
/** Owner records accompany every scope, including scopes nested in a parent. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "./config-layers.ts";
import { swallow } from "./errors.ts";
import {
  parsePosixProcessTable,
  parseWindowsProcessTable,
} from "./process-table.ts";

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
function processStart(): string | null {
  const windows = process.platform === "win32";
  const args = windows
    ? [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}' | Select-Object ProcessId, ParentProcessId, @{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}, CommandLine | ConvertTo-Json -Compress`,
      ]
    : [
        "ps",
        "-p",
        String(process.pid),
        "-o",
        "pid=,ppid=,pgid=,lstart=,stat=,args=",
      ];
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(args, {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5000,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    swallow(error, "scratch owner: no process table to read");
    return null;
  }
  const rows =
    result.exitCode === 0 && result.stdout
      ? (windows ? parseWindowsProcessTable : parsePosixProcessTable)(
          result.stdout.toString(),
        )
      : null;
  return rows?.find((item) => item.pid === process.pid)?.start || null;
}
/** Captured once per process, an unavailable identity included. */
function scratchOwner(): ScratchOwner {
  captured ??= {
    version: 1,
    pid: process.pid,
    start: processStart(),
    createdAt: new Date().toISOString(),
  };
  return captured;
}
export function writeScratchOwner(root: string): void {
  writeFileSync(
    join(root, SCRATCH_OWNER_FILE),
    JSON.stringify({ ...scratchOwner(), createdAt: new Date().toISOString() }),
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
    !Number.isFinite(Date.parse(owner.createdAt))
  )
    throw new GcError(`Invalid scratch owner: ${root}`);
  return {
    version: 1,
    pid: owner.pid,
    start: owner.start as string | null,
    createdAt: owner.createdAt,
  };
}
