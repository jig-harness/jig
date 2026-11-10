/** The installed dashboard's one reader, private access record and renewal boundary. */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "../shared/file-lock.ts";
import { registerSignalHandler } from "../shared/cleanup.ts";
import {
  ownIdentity,
  isAliveSync,
  decodeIdentity,
  type ProcessIdentity,
} from "../shared/liveness.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { serveDashboard } from "./dashboard.ts";
import { parseListen, type Listen } from "./lib/listen.ts";
import { existingStateDb } from "./lib/state.ts";
import { stateRoot } from "./receipts.ts";

export function readerRoot(): string {
  return join(stateRoot(), "dashboard");
}
function causeCode(cause: unknown): string | undefined {
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
}

/** A safe classification of a failure: its error name, never its text, which can carry a private address. */
export function causeDetail(cause: unknown): string {
  return cause instanceof Error && cause.name ? ` (${cause.name})` : "";
}

/** Absence of the marker is `null`; any other read failure is a failure, never an absence. */
export function readGeneration(
  root = readerRoot(),
): Outcome<string | null, "generation-unreadable"> {
  try {
    return ok(readFileSync(join(root, "enabled"), "utf8"));
  } catch (cause) {
    const code = causeCode(cause);
    if (code === "ENOENT") return ok(null);
    return failed(
      "generation-unreadable",
      `dashboard installation marker cannot be read${code ? ` (${code})` : ""}`,
      cause,
    );
  }
}
/** Reads the marker, printing why when it cannot be read. */
export function reportGeneration(root: string) {
  const read = readGeneration(root);
  if (!read.ok) console.error(read.failure.reason);
  return read;
}

interface Access {
  url: string;
  identity: ProcessIdentity;
  configuration: string;
  /** The `jig.ts` the reader started from; absent in a record an earlier release wrote. */
  entry?: string;
}

export function readerSettings(
  listen: Listen,
  requireToken: boolean,
  allowedHosts: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ listen, requireToken, allowedHosts }))
    .digest("hex");
}

/** Never puts the credential in a diagnostic, even when its file is malformed. */
export function readAccess(
  root = readerRoot(),
): Outcome<Access, "unavailable"> {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(root, "access.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      return failed(
        "unavailable",
        "dashboard access record must be an owner-only regular file",
      );
    const value = JSON.parse(readFileSync(fd, "utf8"));
    const identity = decodeIdentity(value.identity);
    if (
      identity === null ||
      typeof value.url !== "string" ||
      typeof value.configuration !== "string"
    )
      return failed("unavailable", "dashboard access record cannot be read");
    const url = new URL(value.url);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      !parseListen(url.host).ok
    )
      return failed(
        "unavailable",
        "dashboard access record names no private reader",
      );
    const alive = isAliveSync(identity);
    if (!alive.ok || alive.value.state !== "alive")
      return failed(
        "unavailable",
        "dashboard reader is not confirmed running; inspect --status and scheduler logs",
      );
    return ok({
      url: value.url,
      identity,
      configuration: value.configuration,
      ...(typeof value.entry === "string" ? { entry: value.entry } : {}),
    });
  } catch (cause) {
    const code = causeCode(cause);
    return failed(
      "unavailable",
      code === "ENOENT"
        ? "no readable live dashboard access record; inspect --status"
        : `dashboard access record is unreadable${code ? ` (${code})` : ""}; inspect --status`,
      cause,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Holds one machine-local lease through the whole server lifetime; cron overlaps skip. */
export async function keepDashboard(options: {
  listen: Listen;
  requireToken: boolean;
  allowedHosts: readonly string[];
  /** The `jig.ts` this reader runs, recorded so a status can compare it with the installed copy. */
  entry?: string;
  root?: string;
  dataRoot?: string;
  /** False when configuration or the installed copy changed: the timer starts its replacement. */
  current: () => Promise<boolean>;
  pollMs?: number;
}): Promise<number> {
  const root = options.root ?? readerRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = reportGeneration(root);
  if (!marker.ok) return 1;
  const generation = marker.value;
  if (generation === null) return 0;
  const result = await withFileLock(
    root,
    async () => {
      // An uninstall may have won while this tick waited for the lease.
      const current = reportGeneration(root);
      if (!current.ok) return 1;
      if (current.value !== generation) return 0;
      existingStateDb(options.dataRoot);
      const started = (() => {
        try {
          return ok(
            serveDashboard({
              listen: options.listen,
              ...(options.dataRoot === undefined
                ? {}
                : { root: options.dataRoot }),
              ...(options.requireToken
                ? {}
                : { token: null, allowedHosts: options.allowedHosts }),
            }),
          );
        } catch (cause) {
          return failed(
            "not-listening",
            "Dashboard reader could not listen; stop a foreground reader on this address or inspect dashboard.listen",
            cause,
          );
        }
      })();
      if (!started.ok) {
        console.error(
          `${started.failure.reason}${causeDetail(started.failure.cause)}`,
        );
        return 1;
      }
      const dashboard = started.value;
      const access = join(root, "access.json");
      let stop = false;
      let finished!: () => void;
      const stopped = new Promise<void>((resolve) => {
        finished = resolve;
      });
      using cancellation = registerSignalHandler(async () => {
        stop = true;
        await stopped;
      });
      void cancellation;
      try {
        const temporary = `${access}.${process.pid}.tmp`;
        try {
          writeFileSync(
            temporary,
            JSON.stringify({
              url: dashboard.url,
              identity: ownIdentity(),
              ...(options.entry === undefined ? {} : { entry: options.entry }),
              configuration: readerSettings(
                options.listen,
                options.requireToken,
                options.allowedHosts,
              ),
            }),
            { mode: 0o600, flag: "wx" },
          );
          renameSync(temporary, access);
        } finally {
          rmSync(temporary, { force: true });
        }
        console.log(
          "jig dashboard reader: listening; use jig dispatch dashboard --access for its private URL",
        );
        // An unreadable marker is a failure to report, never an uninstall.
        let code = 0;
        while (!stop) {
          const marker = reportGeneration(root);
          if (!marker.ok) {
            code = 1;
            break;
          }
          if (marker.value !== generation || !(await options.current())) break;
          await Bun.sleep(options.pollMs ?? 1000);
        }
        return code;
      } finally {
        try {
          dashboard.stop();
          rmSync(access, { force: true });
        } finally {
          // Signal handlers await this promise; cleanup failures must never
          // strand their acknowledgement.
          finished();
        }
      }
    },
    { root, name: "reader", waitMs: 100 },
  );
  return result?.value ?? 0;
}
