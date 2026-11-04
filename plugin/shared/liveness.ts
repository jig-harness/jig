/**
 * One process identity and one lease for every component of the plugin.
 *
 * A component that records "this process holds it" writes a
 * `ProcessIdentity`, and one that later asks "is that holder still running?"
 * judges it here. The dispatcher's launch records, the drive's lock claims,
 * gc's admission tokens, the resource lock and the Orca card lock therefore
 * answer that question by the same rules.
 *
 * An identity names the machine twice: by its host id, which survives a
 * rename and a restart, and by its host name, which a person reads and which
 * decides only when either side has no host id (a record written before host
 * ids). Beside them it holds the kernel's boot id, the pid, and the process's
 * start time as the process table reports it, compared as text and nothing
 * else, so the holder and the judge read it with the same probe. On Linux and
 * macOS `ps` prints it in local time, so a holder and a judge given different
 * time zones (`TZ`) read one start differently: two start times that differ
 * by whole quarter hours within a day are taken for that, and judged unknown
 * rather than a reused pid.
 *
 * A recorded identity, judged from this machine:
 *
 * | Recorded | Verdict |
 * | --- | --- |
 * | on another host | unknown (`foreign`): its process table is not this one |
 * | on this host, before its last restart | dead |
 * | on this host and boot, the process table unreadable | unknown (`unreadable`) |
 * | no process has its pid, or that pid's process started at another time, or has exited | dead |
 * | its pid's process started at the recorded time | alive |
 *
 * One process table per host id and boot is assumed: two environments that
 * share both but not a process table (containers given one machine id and
 * one state directory) are not told apart.
 *
 * Windows keeps the behaviour its platform helpers have
 * ([ADR-0008](../../docs/adr/ADR-0008-windows-cancellation-uses-captured-process-identities.md)):
 * it has no boot id, and a lock's quick check (`isAliveSync`) does not read a
 * process's creation time there, since that costs a PowerShell start; a pid
 * that answers keeps its lock, as it always has.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { errnoCode, swallow } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { failed, ok, type Outcome } from "./outcome.ts";
import {
  parsePosixProcessTable,
  parseWindowsProcessTable,
  type ProcessRow,
  processTable,
} from "./process-table.ts";

/**
 * The mutex expiry, in minutes: how long a lock that guards one
 * read-modify-write of a shared record may stand before a contender breaks
 * it. Short: the work it guards takes seconds, so a holder this late has died
 * or hung. The drive's store mutex breaks a lock after this long by default
 * (`DRIVE_PR_LOCK_STALE_MIN`, read in its `lib/state/lock.ts`).
 */
export const MUTEX_EXPIRY_MIN = 10;

/**
 * The session lease, in minutes: how long a session may go without renewing
 * what it holds before its holding counts as abandoned. Long, because a
 * session renews on its own work, and an agent may think, run gates or wait
 * on a test machine for a long time between two renewals; giving up too
 * early costs two drivers at once, too late a refusal a person clears in one
 * command. The drive's driver locks expire a live pid's claim after this long
 * by default (`DRIVE_PR_LOCK_HEARTBEAT_MIN`, in its `lib/claim.ts`), and its
 * leases are stale after this long by default (`DRIVE_PR_LEASE_STALE_MIN`,
 * read in its `lib/state/lease-model.ts`).
 */
export const SESSION_LEASE_MIN = 360;

/**
 * The ledger window, in minutes: how long a drive ledger's heartbeat may go
 * unrenewed before a driver in another clone may take the drive over, how
 * long an abandoned takeover claim holds its generation, and how long a live
 * driver may record no progress before it reads as wedged. It is twice the
 * longest honest round (a pass's deadline and the gate poll before it), so a
 * slow round is never mistaken for a stall. `stallThresholdMs` in the drive's
 * `lib/doctor.ts` is the window itself, with its override
 * (`DRIVE_PR_STALL_MIN`) and the derivation in full.
 */
export const LEDGER_WINDOW_MIN = 240;

/** A process, recorded so another process can later judge whether it still runs. */
export interface ProcessIdentity {
  /** The machine's stable id (`thisHost`); empty in a record written before host ids. */
  hostId: string;
  /** The host name when it was recorded: for a person, and the comparison when either side has no host id. */
  host: string;
  /** The kernel's boot id; empty where the platform has none. */
  bootId: string;
  pid: number;
  /** The start time the process table reports; empty when it could not be read. */
  start: string;
}

/** Where a process runs: the host part of an identity. */
export interface HostIdentity {
  hostId: string;
  host: string;
  bootId: string;
}

/** The host part a comparison needs; a missing or empty host id means the record predates host ids. */
export interface HostSide {
  host: string;
  hostId?: string | undefined;
}

/** A judgement that could be made: the process runs, or it has ended. */
export interface Verdict {
  state: "alive" | "dead";
  reason: string;
}

/**
 * Why no judgement could be made: the process is on another host
 * (`foreign`), the process table cannot be read (`unreadable`), or the record
 * lacks the start time that would tell a reused pid apart (`unverifiable`).
 */
export type UnknownCode = "foreign" | "unreadable" | "unverifiable";

export type Liveness = Outcome<Verdict, UnknownCode>;

let cachedHost: { hostId: string; bootId: string } | undefined;

/** This machine's identity: its stable host id and boot id, read once per process, and its current name. */
export function thisHost(): HostIdentity {
  cachedHost ??= { hostId: readHostId(), bootId: readBootId() };
  return { ...cachedHost, host: hostname() };
}

/** This boot's id: Linux's `boot_id`; elsewhere empty, and the start time alone tells a reused pid apart. */
export function bootId(): string {
  return thisHost().bootId;
}

function readBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    swallow(error, "no boot id on this platform");
    return "";
  }
}

/**
 * The host id: the system's machine id where it has one (Linux's
 * `/etc/machine-id`, macOS's hardware UUID), else a random id created once in
 * the user's state directory. The raw machine id is hashed, as its
 * documentation asks of an application that records it; empty when none can
 * be read or created, and the host name then decides.
 */
function readHostId(): string {
  const raw =
    (process.platform === "linux" ? machineId() : "") ||
    (process.platform === "darwin" ? platformUuid() : "") ||
    userHostId();
  return raw === ""
    ? ""
    : createHash("sha256")
        .update(`jig host id\0${raw}`)
        .digest("hex")
        .slice(0, 32);
}

function machineId(): string {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(text)) return text;
    } catch (error) {
      swallow(error, `no machine id in ${file}`);
    }
  }
  return "";
}

function platformUuid(): string {
  try {
    const result = Bun.spawnSync(
      ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    const found = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(
      result.stdout.toString(),
    );
    return result.exitCode === 0 ? (found?.[1] ?? "") : "";
  } catch (error) {
    swallow(error, "no hardware UUID; the user's host id file decides");
    return "";
  }
}

const HOST_ID_TEXT = /^[0-9a-f-]{32,36}$/;

/** The id in `~/.local/state/jig/host-id`, created once, published whole so concurrent first readers agree. */
function userHostId(): string {
  const file = join(homedir(), ".local", "state", "jig", "host-id");
  const read = (): string => {
    try {
      const text = readFileSync(file, "utf8").trim();
      return HOST_ID_TEXT.test(text) ? text : "";
    } catch (error) {
      swallow(error, "no host id file yet");
      return "";
    }
  };
  const existing = read();
  if (existing !== "") return existing;
  const staged = `${file}.${process.pid}.${randomUUID()}`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(staged, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    linkSync(staged, file);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST")
      swallow(error, "no host id file could be created; host names decide");
  } finally {
    try {
      rmSync(staged, { force: true });
    } catch (error) {
      swallow(error, "the staged host id is left behind; host names decide");
    }
  }
  return read();
}

/**
 * The identity of process `pid` (this process by default), read from the
 * process table; a failure when the table cannot be read or has no such
 * process.
 */
export async function captureIdentity(
  pid = process.pid,
): Promise<Outcome<ProcessIdentity, "unreadable" | "absent">> {
  const rows = await processTable();
  if (rows === null)
    return failed("unreadable", "the process table cannot be read");
  const row = rows.find((r) => r.pid === pid);
  if (row === undefined)
    return failed("absent", `no process has pid ${pid} now`);
  if (row.start === "")
    return failed("unreadable", `the start time of pid ${pid} cannot be read`);
  return ok(identityOf(row, thisHost()));
}

let own: ProcessIdentity | undefined;

/**
 * This process's identity for a lock or a token: read once per process, with
 * an empty start time when the process table cannot be read, which leaves
 * the record usable and its reused pid untold.
 */
export function ownIdentity(): ProcessIdentity {
  if (own === undefined) {
    const row = processRow(process.pid);
    own = {
      ...thisHost(),
      pid: process.pid,
      start: row === null || row === "absent" ? "" : row.start,
    };
  }
  return { ...own, host: hostname() };
}

/** The identity a record in the earlier pid-only form stands for: this host, no start time. */
export function legacyIdentity(pid: number): ProcessIdentity {
  return { hostId: "", host: "", bootId: "", pid, start: "" };
}

function identityOf(row: ProcessRow, here: HostIdentity): ProcessIdentity {
  return {
    hostId: here.hostId,
    host: here.host,
    bootId: here.bootId,
    pid: row.pid,
    start: row.start,
  };
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * One process's row, read alone: `"absent"` when the table answered and has
 * no such process, `null` when it cannot be read.
 */
function processRow(
  pid: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): ProcessRow | "absent" | null {
  const windows = process.platform === "win32";
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(rowProbe(pid, windows), {
      env: { ...process.env, LC_ALL: "C" },
      timeout: timeoutMs,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    swallow(error, "no process table to read");
    return null;
  }
  const text = result.stdout?.toString() ?? "";
  if (
    noSuchProcess(
      result.exitCode,
      text,
      result.stderr?.toString() ?? "",
      windows,
    )
  )
    return "absent";
  if (result.exitCode !== 0) return null;
  const rows = (windows ? parseWindowsProcessTable : parsePosixProcessTable)(
    text,
  );
  return rows === null ? null : (rows.find((r) => r.pid === pid) ?? "absent");
}

/** The command that reads one process's row: the same columns `processTable` reads. */
function rowProbe(pid: number, windows: boolean): string[] {
  return windows
    ? [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId, ParentProcessId, @{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}, CommandLine | ConvertTo-Json -Compress`,
      ]
    : ["ps", "-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=,stat=,args="];
}

/**
 * Whether a probe answered that no process has the pid: `ps -p` exits 1 and
 * prints nothing, not even an error (a `ps` that fails says why on its error
 * output); the Windows query succeeds and prints nothing.
 */
function noSuchProcess(
  code: number | null,
  out: string,
  err: string,
  windows: boolean,
): boolean {
  if (out.trim() !== "") return false;
  return windows ? code === 0 : code === 1 && err.trim() === "";
}

/** Whether two records name one machine: by host id when both have one, else by name, an empty name being this host. */
export function sameHost(a: HostSide, b: HostSide): boolean {
  if (a.hostId && b.hostId) return a.hostId === b.hostId;
  return a.host === "" || b.host === "" || a.host === b.host;
}

/**
 * How `recorded` stands to `current`, the identity of whatever process now
 * has the same pid on the judge's host: the same process, a process that has
 * ended (an earlier boot, or a reused pid), a process on another host, or
 * another process altogether; `"unknown"` when the two start times may be one
 * start read in two time zones.
 */
export function relate(
  recorded: ProcessIdentity,
  current: ProcessIdentity,
): "same" | "dead" | "foreign" | "other" | "unknown" {
  if (!sameHost(recorded, current)) return "foreign";
  if (recorded.bootId && current.bootId && recorded.bootId !== current.bootId)
    return "dead";
  if (recorded.pid !== current.pid) return "other";
  if (recorded.start && current.start) {
    const starts = compareStarts(recorded.start, current.start);
    if (starts === "differ") return "dead";
    if (starts === "shifted") return "unknown";
  }
  return "same";
}

/** A recorded identity as a person reads it. */
export function describeIdentity(identity: ProcessIdentity): string {
  const where = identity.host === "" ? "this host" : identity.host;
  const since = identity.start === "" ? "" : `, started ${identity.start}`;
  return `pid ${identity.pid} on ${where}${since}`;
}

/** The judgement that needs no process table: another host, or an earlier boot of this one. */
function placed(
  identity: ProcessIdentity,
  here: HostIdentity,
): Liveness | null {
  const at = relate(identity, { ...here, pid: identity.pid, start: "" });
  if (at === "foreign")
    return failed(
      "foreign",
      `${describeIdentity(identity)} is on another host, whose processes this one cannot see`,
    );
  if (at === "dead")
    return ok({
      state: "dead",
      reason: `${describeIdentity(identity)} ran before this host last restarted`,
    });
  return null;
}

/** Judge a recorded identity against one read of the process table (`null` when it could not be read). */
export function judge(
  identity: ProcessIdentity,
  rows: ProcessRow[] | null,
  here: HostIdentity = thisHost(),
): Liveness {
  const elsewhere = placed(identity, here);
  if (elsewhere !== null) return elsewhere;
  if (rows === null)
    return failed("unreadable", "the process table cannot be read");
  return judgeRow(identity, rows.find((r) => r.pid === identity.pid) ?? null);
}

function judgeRow(identity: ProcessIdentity, row: ProcessRow | null): Liveness {
  const pid = identity.pid;
  if (row === null)
    return ok({ state: "dead", reason: `no process has pid ${pid} now` });
  if (identity.start === "")
    return failed(
      "unverifiable",
      `pid ${pid} answers, but its start time was not recorded, so a reused pid cannot be told apart`,
    );
  const moved = otherStart(identity, row);
  if (moved !== null) return moved;
  if (row.stat.startsWith("Z"))
    return ok({ state: "dead", reason: `pid ${pid} has exited` });
  if (row.start === "")
    return failed("unreadable", `the start time of pid ${pid} cannot be read`);
  return ok({ state: "alive", reason: `pid ${pid} still runs` });
}

/**
 * The verdict when the pid's process reports another start time than the one
 * recorded: a reused pid, unless the two differ by whole quarter hours within
 * the widest gap between two time zones, which is one start read in two
 * zones; `null` when the start times agree or the current one is unread.
 */
function otherStart(
  identity: ProcessIdentity,
  row: ProcessRow,
): Liveness | null {
  if (row.start === "" || row.start === identity.start) return null;
  if (compareStarts(row.start, identity.start) === "shifted")
    return failed(
      "unverifiable",
      `pid ${identity.pid} started ${row.start}, which is ${identity.start} read in another time zone, so a reused pid cannot be told apart`,
    );
  return ok({
    state: "dead",
    reason: `pid ${identity.pid} now belongs to a process started ${row.start}, not the one started ${identity.start}`,
  });
}

const QUARTER_HOUR_MS = 900_000;
const WIDEST_ZONE_GAP_MS = 26 * 3_600_000;

const LSTART_TEXT =
  /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/**
 * A start time as milliseconds on a civil clock with no time zone, so the
 * judge's own zone and its daylight-saving gaps cannot move it: the process
 * table's `Www Mon DD HH:MM:SS YYYY` read as UTC, an ISO time as it is;
 * `NaN` for any other text.
 */
function civilMs(text: string): number {
  const m = LSTART_TEXT.exec(text.trim());
  if (m === null) return Date.parse(text);
  const month = MONTHS.indexOf(m[1] ?? "") / 3;
  if (!Number.isInteger(month) || month < 0) return Number.NaN;
  const [day, hour, minute, second, year] = [m[2], m[3], m[4], m[5], m[6]].map(
    Number,
  ) as [number, number, number, number, number];
  return Date.UTC(year, month, day, hour, minute, second);
}

/**
 * How two start times of one pid compare: `"same"`, `"differ"` (two
 * processes), or `"shifted"` when they differ by whole quarter hours within
 * the widest gap between two time zones, which is one start read in two
 * zones and cannot be told from a reused pid.
 */
function compareStarts(
  a: string,
  b: string,
): "same" | "differ" | "shifted" {
  if (a === b) return "same";
  const gap = Math.abs(civilMs(a) - civilMs(b));
  return gap > 0 && gap <= WIDEST_ZONE_GAP_MS && gap % QUARTER_HOUR_MS === 0
    ? "shifted"
    : "differ";
}

/** Judge a recorded identity, reading the process table when its host and boot are this one's. */
export async function isAlive(
  identity: ProcessIdentity,
  here: HostIdentity = thisHost(),
): Promise<Liveness> {
  const elsewhere = placed(identity, here);
  if (elsewhere !== null) return elsewhere;
  return judge(identity, await processTable(), here);
}

/**
 * Judge a lock's holder without the whole process table: a signal check for
 * the pid, then that one process's start time, except on Windows, where a pid
 * that answers keeps its lock. A caller waiting under a deadline
 * (`performance.now()` milliseconds) passes it, and the start time is read
 * only within the time left: with none, the verdict is unreadable.
 */
export function isAliveSync(
  identity: ProcessIdentity,
  here: HostIdentity = thisHost(),
  deadline?: number,
): Liveness {
  return (
    placed(identity, here) ??
    signalCheck(identity) ??
    startCheck(identity, deadline)
  );
}

/** What the signal check alone settles; `null` when the start time must be read. */
function signalCheck(identity: ProcessIdentity): Liveness | null {
  const pid = identity.pid;
  if (!Number.isSafeInteger(pid) || pid < 1)
    return failed("unverifiable", `pid ${pid} cannot belong to a process`);
  if (!pidAnswers(pid))
    return ok({ state: "dead", reason: `no process has pid ${pid} now` });
  if (identity.start === "")
    return failed(
      "unverifiable",
      `pid ${pid} answers, and without a recorded start time a reused pid cannot be told apart`,
    );
  if (process.platform === "win32")
    return failed(
      "unverifiable",
      `pid ${pid} answers; this check does not read a creation time on Windows, so a reused pid cannot be told apart`,
    );
  const seen = confirmed.get(encodeIdentity(identity));
  return seen !== undefined && Date.now() - seen < RECONFIRM_MS
    ? ok({ state: "alive", reason: `pid ${pid} still runs` })
    : null;
}

/** Read the pid's start time and judge it, remembering a holder confirmed alive. */
function startCheck(identity: ProcessIdentity, deadline?: number): Liveness {
  const left =
    deadline === undefined ? PROBE_TIMEOUT_MS : deadline - performance.now();
  if (left < 1)
    return failed("unreadable", "no time is left to read the process table");
  const row = processRow(
    identity.pid,
    Math.min(PROBE_TIMEOUT_MS, Math.ceil(left)),
  );
  // A pid that still answers the signal check yet is missing from the table
  // is a table this check cannot trust, not a process that ended.
  if (row === null || (row === "absent" && pidAnswers(identity.pid)))
    return failed("unreadable", "the process table cannot be read");
  const verdict = judgeRow(identity, row === "absent" ? null : row);
  const key = encodeIdentity(identity);
  if (verdict.ok && verdict.value.state === "alive")
    confirmed.set(key, Date.now());
  else confirmed.delete(key);
  return verdict;
}

/**
 * Holders whose start time `isAliveSync` read as theirs, and when. A
 * contender polling a held lock re-reads the start time at most this often;
 * between reads the signal check alone says the pid still answers, and a pid
 * is not handed to another process while its own still runs.
 */
const confirmed = new Map<string, number>();
const RECONFIRM_MS = 10_000;

/** Whether a signal check finds `pid`: one owned by another user still answers. */
function pidAnswers(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

/** An identity as one line of JSON, the form tokens and lock files carry. */
export function encodeIdentity(identity: ProcessIdentity): string {
  return JSON.stringify({
    hostId: identity.hostId,
    host: identity.host,
    bootId: identity.bootId,
    pid: identity.pid,
    start: identity.start,
  });
}

/** An identity read back from `encodeIdentity`'s form, or a record that lacks the later fields; `null` when it is not one. */
export function decodeIdentity(value: unknown): ProcessIdentity | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      swallow(error, "not a recorded identity");
      return null;
    }
  }
  if (!isRecord(parsed)) return null;
  const { hostId = "", host, bootId = "", pid, start } = parsed;
  if (
    typeof hostId !== "string" ||
    typeof host !== "string" ||
    typeof bootId !== "string" ||
    typeof start !== "string" ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  )
    return null;
  return { hostId, host, bootId, pid, start };
}

/**
 * What a holder holds: who, under which generation (raised by every takeover,
 * so a holder that was replaced can tell), since when, when it last renewed
 * and when it expires unless renewed again. Times are ISO strings.
 */
export interface Lease {
  holder: ProcessIdentity;
  generation: number;
  startedAt: string;
  renewedAt: string;
  expiresAt: string;
}

/** A new lease for `holder` under `generation`, expiring `ttlMin` minutes from `now`. */
export function takeLease(
  holder: ProcessIdentity,
  generation: number,
  now: Date = new Date(),
  ttlMin = SESSION_LEASE_MIN,
): Lease {
  const at = now.toISOString();
  return {
    holder,
    generation,
    startedAt: at,
    renewedAt: at,
    expiresAt: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
  };
}

/** The same lease, renewed at `now` for another `ttlMin` minutes. */
export function renewLease(
  lease: Lease,
  now: Date = new Date(),
  ttlMin = SESSION_LEASE_MIN,
): Lease {
  return {
    ...lease,
    renewedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
  };
}

/**
 * Whether a lease no longer holds: its expiry has passed, or its holder was
 * judged dead. An expiry that does not read keeps the lease, since an
 * unreadable record is no evidence of abandonment.
 */
export function isStale(
  lease: Lease,
  now: Date = new Date(),
  holder?: Liveness,
): boolean {
  if (holder?.ok && holder.value.state === "dead") return true;
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && now.getTime() >= expires;
}

/**
 * The fence before an act that cannot be undone: a holder that took
 * generation `expected` may act only while the lease still reads `actual`
 * equal to it. A later generation means another holder took over; an earlier
 * one means an older copy of the lease was put back.
 */
export function fence(
  expected: number,
  actual: number,
): Outcome<number, "superseded" | "regressed"> {
  if (actual === expected) return ok(actual);
  return actual > expected
    ? failed(
        "superseded",
        `the lease is at generation ${actual}: another holder took it over from generation ${expected}`,
      )
    : failed(
        "regressed",
        `the lease reads generation ${actual}, older than the ${expected} this holder took: an older copy was put back`,
      );
}
