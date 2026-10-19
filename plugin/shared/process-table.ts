/** One bounded, platform-native snapshot for identity and descendant checks. */
import { spawn } from "node:child_process";
import { swallow } from "./errors.ts";

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Process groups are POSIX-only; Windows rows carry zero. */
  pgid: number;
  /** Opaque creation identity; empty means inaccessible and cannot authorize killing. */
  start: string;
  /** Windows has no POSIX zombies and uses R for an extant process. */
  stat: string;
  args: string;
}

export function parsePosixProcessTable(output: string): ProcessRow[] | null {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const m =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)(?:\s+(.*))?$/.exec(
        line,
      );
    if (m === null) return null;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      start: (m[4] as string).replace(/\s+/g, " "),
      stat: m[5] as string,
      args: m[6] ?? "",
    });
  }
  return rows.length ? rows : null;
}

/** Decode one CIM row; inaccessible properties retain an explicit unknown identity. */
function windowsProcessRow(item: unknown): ProcessRow | null {
  if (item === null || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  if (
    !Number.isSafeInteger(r.ProcessId) ||
    Number(r.ProcessId) < 0 ||
    !Number.isSafeInteger(r.ParentProcessId) ||
    Number(r.ParentProcessId) < 0 ||
    !(typeof r.CreationDate === "string" || r.CreationDate === null) ||
    !(typeof r.CommandLine === "string" || r.CommandLine === null)
  )
    return null;
  return {
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    pgid: 0,
    start: r.CreationDate ?? "",
    stat: "R",
    args: r.CommandLine ?? "",
  };
}

/** Drop historical parent links whose pid now belongs to a younger process. */
function normalizeWindowsParents(rows: ProcessRow[]): void {
  // Native dates are UTC with fixed seven-digit precision, so string order
  // also preserves sub-millisecond creation ordering. Unknown dates stay
  // linked: callers must withhold a witness for reachable unknown identities.
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const row of rows) {
    const parent = byPid.get(row.ppid);
    if (row.start && parent?.start && row.start < parent.start) row.ppid = 0;
  }
}

export function parseWindowsProcessTable(output: string): ProcessRow[] | null {
  try {
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
    const source = Array.isArray(parsed) ? parsed : [parsed];
    if (source.length === 0) return null;
    const rows: ProcessRow[] = [];
    for (const item of source) {
      const row = windowsProcessRow(item);
      if (row === null) return null;
      rows.push(row);
    }
    normalizeWindowsParents(rows);
    return rows;
  } catch (err) {
    swallow(err, "invalid native process snapshot; identity remains unknown");
    return null;
  }
}

// Format CreationDate explicitly: ConvertTo-Json otherwise rewrites DateTime as
// a locale/runtime-dependent wrapper and loses the creation identity's precision.
const WINDOWS_SNAPSHOT =
  "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, @{Name='CreationDate';Expression={if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null}}}, CommandLine) | ConvertTo-Json -Compress";

/** Unavailable or malformed enumeration is unknown, never an empty tree. */
export async function processTable(
  timeoutSec = 5,
): Promise<ProcessRow[] | null> {
  const windows = process.platform === "win32";
  const argv = windows
    ? [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_SNAPSHOT,
      ]
    : ["ps", "-A", "-o", "pid=,ppid=,pgid=,lstart=,stat=,args="];
  // This primitive must not use shared/proc.run: its timeout cancellation reads
  // this very process table to end a Windows child tree. Its direct, bounded
  // native probe has no descendants and cannot recursively enumerate itself.
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
      windowsHide: true,
    });
    let output = "";
    let stderrTail = "";
    let done = false;
    const finish = (rows: ProcessRow[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (rows === null && stderrTail)
        swallow(
          new Error("native process probe failed", { cause: stderrTail }),
          "native process enumeration unavailable",
        );
      resolve(rows);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
      finish(null);
    }, timeoutSec * 1000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 16 * 1024 * 1024) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Already gone. */
        }
        finish(null);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (err) => {
      swallow(err, "native process probe could not start");
      finish(null);
    });
    child.on("close", (code) =>
      finish(
        code === 0
          ? windows
            ? parseWindowsProcessTable(output)
            : parsePosixProcessTable(output)
          : null,
      ),
    );
  });
}
