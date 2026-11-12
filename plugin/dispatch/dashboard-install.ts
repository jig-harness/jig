/** Availability through an independent retry timer, using the installed-copy launcher. */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { exclusiveInstallLock } from "../shared/gc-lock.ts";
import { run } from "../shared/proc.ts";
import { installedEntry, listPlugins } from "../runtime/launcher.ts";
import { scheduledStatus, formatStatus } from "../runtime/job-status.ts";
import type { JobSpec } from "../runtime/job-spec.ts";
import {
  checkLauncherResolves,
  detectScheduler,
  installedScript,
  jobPreview,
  pluginPrograms,
  updateJob,
  snapshotScheduler,
  restoreScheduler,
} from "../runtime/scheduler.ts";
import {
  machineConfigPath,
  parseMachineConfigText,
  readMachineConfig,
} from "./lib/machine-config.ts";
import {
  keepDashboard,
  readerRoot,
  readGeneration,
  reportGeneration,
  causeDetail,
  readAccess,
  readerSettings,
} from "./dashboard-reader.ts";
import { attempt, failed, ok, type Outcome } from "../shared/outcome.ts";
import { DEFAULT_PORT } from "./dashboard.ts";
import type { Listen } from "./lib/listen.ts";

/** Refuse a foreground reader or another service before installing a retry loop. */
function listenAvailable(listen: Listen): Promise<boolean> {
  return new Promise((settle) => {
    const server = createServer();
    server.once("error", () => settle(false));
    server.listen(listen.port ?? DEFAULT_PORT, listen.host, () =>
      server.close(() => settle(true)),
    );
  });
}

export function dashboardJobSpec(): JobSpec {
  return {
    name: "jig-dispatch-dashboard",
    label: "dev.jig.dispatch-dashboard",
    description: "Jig read-only dashboard reader",
    timerDescription: "Retry the dashboard reader every minute",
    stateRoot: readerRoot(),
    args: ["dispatch", "dashboard", "--scheduled"],
    schedule: { everyMinutes: 1, afterExit: true },
    deadlineSec: 86400,
  };
}

/** A GUI LaunchAgent stops at logout; a systemd user manager needs lingering. */
async function availability(): Promise<string | null> {
  const scheduler = detectScheduler();
  if (!scheduler.ok) return scheduler.failure.reason;
  if (scheduler.value === "launchd")
    return "Dashboard availability after logout requires Linux systemd with lingering or cron. macOS GUI LaunchAgents stop at logout; use the foreground dashboard there.";
  if (scheduler.value === "systemd") {
    const result = await run(
      [
        "loginctl",
        "show-user",
        String(process.getuid?.()),
        "--property=Linger",
        "--value",
      ],
      { timeoutSec: 10 },
    );
    if (result.code !== 0 || result.stdout.trim() !== "yes")
      return "Cannot confirm systemd user lingering. A host administrator must enable it with loginctl enable-linger <user>, then retry; Jig does not change this host setting.";
  }
  return null;
}

async function dashboardPreflight(): Promise<boolean> {
  const machine = readMachineConfig();
  if (!machine.ok || machine.value?.dashboardListen == null) {
    console.error(
      machine.ok
        ? `Set dashboard.listen in ${machineConfigPath()} first`
        : machine.failure.reason,
    );
    return false;
  }
  if (machine.value.dashboardListen.port === 0) {
    console.error("An installed dashboard needs a fixed port, not port 0");
    return false;
  }
  const refused = await availability();
  if (refused !== null) {
    console.error(refused);
    return false;
  }
  const access = readAccess();
  const listen = machine.value.dashboardListen;
  const host = listen.host.includes(":") ? `[${listen.host}]` : listen.host;
  const intended = new URL(`http://${host}:${listen.port ?? DEFAULT_PORT}/`)
    .origin;
  const ownsAddress =
    access.ok && new URL(access.value.url).origin === intended;
  if (!ownsAddress && !(await listenAvailable(listen))) {
    console.error(
      "The configured dashboard address is unavailable. Stop any foreground dashboard using it, or correct dashboard.listen, then retry.",
    );
    return false;
  }

  return true;
}

export async function dashboardInstall(
  confirm: boolean,
  remove: boolean,
  script: string,
): Promise<number> {
  if (!remove && !(await dashboardPreflight())) return 1;
  console.log(jobPreview(dashboardJobSpec(), remove));
  if (!confirm) {
    console.log("Preview only; add --yes to apply.");
    return 0;
  }
  if (!installedScript(script)) {
    console.error("Install from the installed plugin copy, outside a checkout");
    return 1;
  }
  if (!remove) {
    const resolves = await checkLauncherResolves();
    if (!resolves.ok) {
      console.error(resolves.failure.reason);
      return 1;
    }
  }
  return exclusiveInstallLock(() => writeDashboardJob(remove));
}

async function removeReader(): Promise<boolean> {
  rmSync(join(readerRoot(), "enabled"), { force: true });
  const deadline = Date.now() + 10_000;
  while (readAccess().ok && Date.now() < deadline) await Bun.sleep(100);
  if (!readAccess().ok) return true;
  console.error("Timer removed but reader has not stopped; inspect --status");
  return false;
}

async function snapshotDashboardJob() {
  const scheduler = detectScheduler();
  return scheduler.ok
    ? snapshotScheduler(scheduler.value, dashboardJobSpec())
    : scheduler;
}

/** Only an install needs the previous generation: removal never reads the marker. */
function generationBefore(root: string, remove: boolean) {
  return remove ? ok(null) : reportGeneration(root);
}

async function writeDashboardJob(remove: boolean): Promise<number> {
  const snapshot = await snapshotDashboardJob();
  if (!snapshot.ok) {
    console.error(snapshot.failure.reason);
    return 1;
  }
  const root = readerRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The same generation survives repeated installs; no extra reader is started.
  const marker = generationBefore(root, remove);
  if (!marker.ok) return 1;
  const previous = marker.value;
  if (!remove && previous === null)
    writeFileSync(join(root, "enabled"), randomUUID(), {
      flag: "wx",
      mode: 0o600,
    });
  const updated = await updateJob(dashboardJobSpec(), remove);
  if (!updated.ok) {
    if (!remove && previous === null)
      rmSync(join(root, "enabled"), { force: true });
    const restored = await restoreScheduler(snapshot.value);
    console.error(
      `${updated.failure.reason}; ${restored.ok ? "previous dashboard job restored" : `rollback failed: ${restored.failure.reason}`}`,
    );
    return 1;
  }
  if (remove && !(await removeReader())) return 1;
  console.log(`${remove ? "Removed" : "Installed"}: ${updated.value}`);
  console.log("The dispatch and probe timers are unchanged.");
  return 0;
}

function schedulerLogs(scheduler: string | null): string {
  if (scheduler === "systemd")
    return "journalctl --user -u jig-dispatch-dashboard.service";
  if (scheduler === "launchd")
    return `${readerRoot()}/scheduler.log and scheduler-error.log`;
  return "the cron service output (or cron mail)";
}

/** Null when the reader runs the installed copy; otherwise the line saying why not. */
async function installedCopyState(
  readerEntry: string | null,
): Promise<string | null> {
  const waiting = "waiting for renewal";
  try {
    const installed = realpathSync(await installedEntry(pluginPrograms()));
    // A reader whose copy was replaced and removed is not the installed one.
    return readerEntry !== null &&
      existsSync(readerEntry) &&
      installed === realpathSync(readerEntry)
      ? null
      : `installed copy: reader is not running the currently installed plugin copy; ${waiting}`;
  } catch (cause) {
    // Never print a registry command's raw output: it can contain credentials.
    return `installed copy: lookup unavailable${causeDetail(cause) || " (lookup failed)"}; ${waiting}`;
  }
}

/**
 * Resolves null when the reader is uninstalled meanwhile, so removal never
 * waits out a slow lookup; the lookup's registry commands are cancelled then.
 * An unreadable marker is not a removal: the reader loop reports it.
 */
async function lookupInstalledEntry(
  programs: ReturnType<typeof pluginPrograms>,
): Promise<Outcome<string> | null> {
  let removalTimer: ReturnType<typeof setInterval> | undefined;
  const cancel = new AbortController();
  try {
    const lookup = installedEntry(programs, (program) =>
      listPlugins(program, undefined, undefined, undefined, cancel.signal),
    ).then(
      (value) => ok(value),
      (cause) =>
        failed(
          "registry-unavailable",
          "Dashboard installed-copy lookup unavailable",
          cause,
        ),
    );
    const removed = new Promise<null>((resolve) => {
      removalTimer = setInterval(() => {
        const marker = readGeneration(readerRoot());
        if (marker.ok && marker.value === null) resolve(null);
      }, 100);
    });
    const winner = await Promise.race([lookup, removed]);
    if (winner === null) {
      cancel.abort();
      await lookup;
    }
    return winner;
  } finally {
    clearInterval(removalTimer);
  }
}

function settingsMatch(
  access: ReturnType<typeof readAccess>,
  machine: ReturnType<typeof readMachineConfig>,
): boolean {
  return (
    access.ok &&
    machine.ok &&
    machine.value?.dashboardListen != null &&
    access.value.configuration ===
      readerSettings(
        machine.value.dashboardListen,
        machine.value.dashboardRequireToken,
        machine.value.dashboardAllowedHosts,
      )
  );
}

async function answers(url: string): Promise<boolean> {
  // Never print a fetch error: it may carry the private URL.
  const pending = attempt("not-answering", "reader not answering", () =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) }),
  );
  if (!pending.ok) return false;
  const response = await pending.value.then(
    (value) => ok(value),
    (cause) => failed("not-answering", "reader not answering", cause),
  );
  if (!response.ok) return false;
  // A body that errors after the headers arrive makes cancel() reject.
  const cancelled = await Promise.resolve(response.value.body?.cancel()).then(
    () => true,
    () => false,
  );
  return cancelled && response.value.ok;
}

export async function dashboardStatus(): Promise<number> {
  const status = await scheduledStatus("dashboard", dashboardJobSpec(), null);
  console.log(formatStatus(status));
  const scheduler = detectScheduler();
  const snapshot = scheduler.ok
    ? await snapshotScheduler(scheduler.value, dashboardJobSpec())
    : scheduler;
  const viable =
    status.installed &&
    !status.error &&
    snapshot.ok &&
    snapshot.value.enabled &&
    snapshot.value.active;
  const access = readAccess();
  // The reader's own recorded entry, never the copy that runs this status.
  const copy = await installedCopyState(
    access.ok ? (access.value.entry ?? null) : null,
  );
  const matches = settingsMatch(access, readMachineConfig());
  const healthy = access.ok && (await answers(access.value.url));
  console.log(
    access.ok
      ? `reader: ${healthy ? "healthy" : "not answering"} (pid ${access.value.identity.pid}); private URL: jig dispatch dashboard --access`
      : `reader: ${access.failure.reason}`,
  );
  const refused = await availability();
  if (refused !== null) console.log(`availability: ${refused}`);
  console.log(`logs: ${schedulerLogs(scheduler.ok ? scheduler.value : null)}`);
  if (!matches)
    console.log(
      "configuration: reader does not match the current readable dashboard settings; waiting for renewal",
    );
  if (copy !== null) console.log(copy);
  return healthy && viable && matches && copy === null && refused === null
    ? 0
    : 1;
}

/** Poll cheap config/generation every second; resolve the installed entry at most once a minute. */
export async function scheduledDashboard(script: string): Promise<number> {
  const path = machineConfigPath();
  // One read feeds both the parse and the watched text, so they cannot differ.
  const snapshot = attempt(
    "configuration-unreadable",
    "Dashboard configuration cannot be read",
    () => readFileSync(path, "utf8"),
  );
  if (!snapshot.ok) {
    console.error(snapshot.failure.reason);
    return 1;
  }
  const config = snapshot.value;
  const machine = parseMachineConfigText(config, path);
  if (!machine.ok || machine.value.dashboardListen == null) {
    console.error(
      machine.ok ? "dashboard.listen is missing" : machine.failure.reason,
    );
    return 1;
  }
  const programs = pluginPrograms();
  const ownEntry = realpathSync(script);
  let nextCheck = 0;
  return keepDashboard({
    listen: machine.value.dashboardListen,
    requireToken: machine.value.dashboardRequireToken,
    allowedHosts: machine.value.dashboardAllowedHosts,
    entry: ownEntry,
    current: async () => {
      const currentConfig = attempt(
        "configuration-unreadable",
        "dashboard configuration cannot be read",
        () => readFileSync(path, "utf8"),
      );
      if (!currentConfig.ok) {
        console.error(
          "Dashboard configuration is unavailable; stopping this reader",
        );
        return false;
      }
      if (currentConfig.value !== config) return false;
      if (Date.now() < nextCheck) return true;
      nextCheck = Date.now() + 60_000;
      const entry = await lookupInstalledEntry(programs);
      if (entry === null) return false;
      if (!entry.ok) {
        console.error(
          `Dashboard installed-copy check unavailable${causeDetail(entry.failure.cause)}; retrying within a minute`,
        );
        return true;
      }
      return entry.value === ownEntry;
    },
  });
}
