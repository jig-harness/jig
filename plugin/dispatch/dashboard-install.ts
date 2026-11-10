/** Availability through an independent retry timer, using the installed-copy launcher. */
import { randomUUID } from "node:crypto";
import {
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
import { installedEntry } from "../runtime/launcher.ts";
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
import { machineConfigPath, readMachineConfig } from "./lib/machine-config.ts";
import {
  keepDashboard,
  readerRoot,
  readerGeneration,
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

async function writeDashboardJob(remove: boolean): Promise<number> {
  const scheduler = detectScheduler();
  if (!scheduler.ok) {
    console.error(scheduler.failure.reason);
    return 1;
  }
  const snapshot = await snapshotScheduler(scheduler.value, dashboardJobSpec());
  if (!snapshot.ok) {
    console.error(snapshot.failure.reason);
    return 1;
  }
  const root = readerRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The same generation survives repeated installs; no extra reader is started.
  const previous = readerGeneration(root);
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
  const machine = readMachineConfig();
  const matches =
    access.ok &&
    machine.ok &&
    machine.value?.dashboardListen != null &&
    access.value.configuration ===
      readerSettings(
        machine.value.dashboardListen,
        machine.value.dashboardRequireToken,
        machine.value.dashboardAllowedHosts,
      );
  let healthy = false;
  if (access.ok) {
    try {
      const response = await fetch(access.value.url, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      healthy = response.ok;
      await response.body?.cancel();
    } catch {
      /* Never print a fetch error: it may carry the private URL. */
    }
  }
  console.log(
    access.ok
      ? `reader: ${healthy ? "healthy" : "not answering"} (pid ${access.value.identity.pid}); private URL: jig dispatch dashboard --access`
      : `reader: ${access.failure.reason}`,
  );
  const refused = await availability();
  if (refused !== null) console.log(`availability: ${refused}`);
  console.log(
    `logs: ${readerRoot()}/scheduler.log and scheduler-error.log (systemd: journalctl --user -u jig-dispatch-dashboard.service)`,
  );
  if (!matches)
    console.log(
      "configuration: reader does not match the current readable dashboard settings; waiting for renewal",
    );
  return healthy && viable && matches && refused === null ? 0 : 1;
}

export function dashboardAccess(): number {
  const access = readAccess();
  if (!access.ok) {
    console.error(access.failure.reason);
    return 1;
  }
  console.log(access.value.url);
  return 0;
}

/** Poll cheap config/generation every second; resolve the installed entry at most once a minute. */
export async function scheduledDashboard(script: string): Promise<number> {
  const path = machineConfigPath();
  const machine = readMachineConfig(path);
  if (!machine.ok || machine.value?.dashboardListen == null) {
    console.error(
      machine.ok ? "dashboard.listen is missing" : machine.failure.reason,
    );
    return 1;
  }
  let config: string;
  try {
    config = readFileSync(path, "utf8");
  } catch {
    console.error("Dashboard configuration cannot be read");
    return 1;
  }
  const programs = pluginPrograms();
  const ownEntry = realpathSync(script);
  let nextCheck = 0;
  return keepDashboard({
    listen: machine.value.dashboardListen,
    requireToken: machine.value.dashboardRequireToken,
    allowedHosts: machine.value.dashboardAllowedHosts,
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
      let entry: Outcome<string>;
      try {
        entry = ok(await installedEntry(programs));
      } catch (cause) {
        entry = failed(
          "registry-unavailable",
          "Dashboard installed-copy lookup unavailable",
          cause,
        );
      }
      if (!entry.ok) {
        console.error(
          "Dashboard installed-copy check unavailable; retrying within a minute",
        );
        return true;
      }
      return entry.value === ownEntry;
    },
  });
}
