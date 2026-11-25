/**
 * `jig install hub` and `jig uninstall hub`: the hub's `jig hub serve` as
 * a resident job of the hub's own OS user, restarted when it exits and when
 * the installed copy changes, the way the dispatch dashboard's reader is
 * installed ([design/control-plane.md § Apart from the sessions on a shared machine](../../../design/control-plane.md#apart-from-the-sessions-on-a-shared-machine)).
 *
 * It runs as the hub's user and refuses, writing nothing, when that user
 * is root, is not the user the settings name (`jig-hub` by default), or is
 * the dispatcher's user: one whose Jig home holds the dispatcher's machine
 * file or whose scheduler holds the dispatcher's job, or whose scheduler
 * cannot be read to tell. Where podman or
 * docker is installed it builds the hub's image from the installed plugin
 * copy, and the job runs `jig hub serve` in it; elsewhere the job runs
 * `jig hub serve` directly. Before the job, it makes the database
 * directory and the feed socket's directory (`host-paths.ts`).
 *
 * `jig uninstall hub --machine` removes the job, then stops the running hub
 * (`instance.ts`) and any container of the hub's name, and fails when the
 * hub is still running. Without `--machine`, or with no job and no install
 * record here, it removes nothing.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { dispatchJobSpec } from "../../dispatch/install.ts";
import { machineConfigPath } from "../../dispatch/lib/machine-config.ts";
import { jobPresent } from "../../runtime/installed-job.ts";
import type { JobSpec } from "../../runtime/job-spec.ts";
import {
  checkLauncherResolves,
  detectScheduler,
  installedScript,
  jobPreview,
  restoreScheduler,
  snapshotScheduler,
  updateJob,
} from "../../runtime/scheduler.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { exclusiveInstallLock } from "../../shared/gc-lock.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import {
  buildCommand,
  type ContainerRuntime,
  containerRuntime,
  removeContainer,
} from "./container.ts";
import { prepareHostPathsReporting } from "./host-paths.ts";
import { stopRunningHub } from "./instance.ts";
import {
  checkPrivate,
  defaultSettingsPath,
  hubHome,
  readHubSettings,
} from "./settings.ts";

/** What `jig install hub` recorded: how the job runs the hub. */
export interface InstallRecord {
  /** The container tool the job runs the image with; null to run the process directly. */
  readonly runtime: ContainerRuntime | null;
  /** The settings file the job serves with. */
  readonly settings: string;
}

/** Where the install record lives. */
export function installRecordPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(hubHome(env), "install.json");
}

/** The resident job: `jig hub serve --scheduled`, started again a minute after it exits. */
export function hubJobSpec(): JobSpec {
  return {
    name: "jig-hub",
    label: "dev.jig.hub",
    description: "Jig hub",
    timerDescription: "Start the Jig hub again within a minute of it stopping",
    stateRoot: join(hubHome(), "job"),
    args: ["hub", "serve", "--scheduled"],
    schedule: { everyMinutes: 1, afterExit: true },
    deadlineSec: 86_400,
  };
}

/** Who runs the install, and the probes it asks; injected by tests. */
export interface InstallProbes {
  identity(): { uid: number; gid: number; user: string };
  /** Why this user is the dispatcher's, or null when it is not; `unreadable` when it cannot be told. */
  dispatcherHere(): Promise<Outcome<string | null, "unreadable">>;
  runtime(): ContainerRuntime | null;
  /** Why the job would not stay up after logout, or null. */
  availability(): Promise<string | null>;
  platform: string;
}

/**
 * Why this user is the dispatcher's: its machine file, or its scheduler's
 * dispatcher job; `unreadable` when its scheduler cannot be read, which is
 * never taken to mean it is not.
 */
export async function dispatcherReason(): Promise<
  Outcome<string | null, "unreadable">
> {
  const machine = machineConfigPath();
  if (existsSync(machine))
    return ok(`this user holds the dispatcher's machine file ${machine}`);
  const scheduler = detectScheduler();
  if (!scheduler.ok)
    return failed(
      "unreadable",
      `cannot tell whether this user's scheduler holds the dispatcher's job: ${scheduler.failure.reason}`,
    );
  const snapshot = await snapshotScheduler(scheduler.value, dispatchJobSpec(5));
  if (!snapshot.ok)
    return failed(
      "unreadable",
      `cannot tell whether this user's scheduler holds the dispatcher's job: ${snapshot.failure.reason}`,
    );
  return ok(
    jobPresent(snapshot.value)
      ? "this user's scheduler holds the dispatcher's job"
      : null,
  );
}

/** A systemd user manager stops at logout unless lingering is on. */
async function lingering(): Promise<string | null> {
  const scheduler = detectScheduler();
  if (!scheduler.ok) return scheduler.failure.reason;
  if (scheduler.value !== "systemd") return null;
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
  return result.code === 0 && result.stdout.trim() === "yes"
    ? null
    : "the hub's user needs systemd lingering to stay up after logout: an administrator runs loginctl enable-linger <hub user>, then retry";
}

const systemProbes: InstallProbes = {
  identity: () => {
    const info = userInfo();
    return { uid: info.uid, gid: info.gid, user: info.username };
  },
  dispatcherHere: dispatcherReason,
  runtime: () => containerRuntime(),
  availability: lingering,
  platform: process.platform,
};

export interface HubInstallRequest {
  readonly confirm: boolean;
  readonly remove: boolean;
  /** For a removal: `--machine`, without which the hub's job stays. */
  readonly machine?: boolean;
  /** The running `jig.ts`. */
  readonly script: string;
  readonly settingsPath?: string;
}

/** Why the install is refused before anything is written, or null. */
export async function refusal(
  request: Pick<HubInstallRequest, "settingsPath">,
  probes: InstallProbes,
): Promise<Outcome<{ settings: string }, "refused">> {
  const refuse = (reason: string) => ({
    ok: false as const,
    failure: { code: "refused" as const, reason },
  });
  if (probes.platform === "win32")
    return refuse("the hub runs on Linux or macOS");
  const who = probes.identity();
  if (who.uid === 0)
    return refuse(
      "the hub never runs as root: run jig install hub as the hub's own user (jig-hub by default)",
    );
  const path = request.settingsPath ?? defaultSettingsPath();
  const settings = readHubSettings(path);
  if (!settings.ok)
    return refuse(
      `${settings.failure.reason}; write the hub's settings first (plugin/hub/README.md)`,
    );
  if (who.user !== settings.value.user)
    return refuse(
      `jig install hub runs as the hub's user, ${settings.value.user}, not ${who.user}`,
    );
  const dispatcher = await probes.dispatcherHere();
  if (!dispatcher.ok)
    return refuse(
      `${dispatcher.failure.reason}; the hub runs under an OS user of its own, never the dispatcher's`,
    );
  if (dispatcher.value !== null)
    return refuse(
      `${dispatcher.value}: the hub runs under an OS user of its own, never the dispatcher's`,
    );
  const exposed = checkPrivate(
    {
      path,
      database: existsSync(settings.value.database)
        ? settings.value.database
        : dirname(path),
    },
    who,
  );
  if (!exposed.ok) return refuse(exposed.failure.reason);
  return ok({ settings: path });
}

/** The plugin copy's version, from its manifest. */
export function pluginVersion(
  pluginRoot: string,
): Outcome<string, "unreadable"> {
  const manifest = attempt(
    "unreadable",
    "cannot read the plugin's version",
    (): unknown =>
      JSON.parse(
        readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
      ),
  );
  if (!manifest.ok) return manifest;
  const version = isMapping(manifest.value) ? manifest.value.version : null;
  return typeof version === "string" && /^[0-9A-Za-z.+-]+$/.test(version)
    ? ok(version)
    : failed("unreadable", "the plugin's manifest names no version");
}

/** Builds the image for this plugin copy. */
export async function buildImage(
  runtime: ContainerRuntime,
  pluginRoot: string,
): Promise<Outcome<string, "unavailable" | "unreadable">> {
  const version = pluginVersion(pluginRoot);
  if (!version.ok) return version;
  const command = buildCommand(runtime, pluginRoot, version.value, Bun.version);
  console.log(`Building the hub's image: ${command.join(" ")}`);
  const built = await run(command, { timeoutSec: 900 });
  return built.code === 0
    ? ok(version.value)
    : {
        ok: false,
        failure: {
          code: "unavailable",
          reason: `${command.join(" ")} failed: ${built.stderr.trim().slice(-500)}`,
        },
      };
}

async function writeJob(
  spec: JobSpec,
  remove: boolean,
): Promise<Outcome<string, string>> {
  const scheduler = detectScheduler();
  if (!scheduler.ok) return scheduler;
  const snapshot = await snapshotScheduler(scheduler.value, spec);
  if (!snapshot.ok) return snapshot;
  const updated = await updateJob(spec, remove);
  if (updated.ok) return updated;
  const restored = await restoreScheduler(snapshot.value);
  return {
    ok: false,
    failure: {
      code: updated.failure.code,
      reason: `${updated.failure.reason}; ${restored.ok ? "the previous job is restored" : `rollback failed: ${restored.failure.reason}`}`,
    },
  };
}

/** `jig install hub` (or, with `remove`, `jig uninstall hub`). */
export async function installHub(
  request: HubInstallRequest,
  probes: InstallProbes = systemProbes,
): Promise<number> {
  const spec = hubJobSpec();
  if (request.remove) return uninstallHub(request, probes, spec);
  const refused = await refusal(request, probes);
  if (!refused.ok) {
    console.error(`jig install hub: ${refused.failure.reason}`);
    return 1;
  }
  const runtime = probes.runtime();
  console.log(jobPreview(spec, false));
  console.log(
    runtime === null
      ? "No podman or docker on PATH: the job runs jig hub serve directly."
      : `The job runs jig hub serve in an image ${runtime} builds from the installed plugin copy.`,
  );
  if (!request.confirm) {
    console.log("Preview only; add --yes to apply.");
    return 0;
  }
  if (!installedScript(request.script)) {
    console.error("Install from the installed plugin copy, outside a checkout");
    return 1;
  }
  const unavailable = await probes.availability();
  if (unavailable !== null) {
    console.error(unavailable);
    return 1;
  }
  const resolves = await checkLauncherResolves();
  if (!resolves.ok) {
    console.error(resolves.failure.reason);
    return 1;
  }
  const settings = readHubSettings(refused.value.settings);
  if (!settings.ok) {
    console.error(`jig install hub: ${settings.failure.reason}`);
    return 1;
  }
  if (!prepareHostPathsReporting(settings.value, "jig install hub")) return 1;
  if (runtime !== null) {
    const built = await buildImage(runtime, dirname(request.script));
    if (!built.ok) {
      console.error(built.failure.reason);
      return 1;
    }
  }
  const record: InstallRecord = { runtime, settings: refused.value.settings };
  return exclusiveInstallLock(async () => {
    mkdirSync(hubHome(), { recursive: true, mode: 0o700 });
    writeFileSync(installRecordPath(), JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
    const written = await writeJob(spec, false);
    if (!written.ok) {
      rmSync(installRecordPath(), { force: true });
      console.error(written.failure.reason);
      return 1;
    }
    console.log(`Installed: ${written.value}`);
    return 0;
  });
}

/** Whether this user has a hub to remove: its job, or its install record. */
async function hubHere(spec: JobSpec): Promise<Outcome<boolean, string>> {
  if (existsSync(installRecordPath())) return ok(true);
  const scheduler = detectScheduler();
  if (!scheduler.ok) return scheduler;
  const snapshot = await snapshotScheduler(scheduler.value, spec);
  return snapshot.ok ? ok(jobPresent(snapshot.value)) : snapshot;
}

/** Stops the running hub and any container of its name; why it could not, or null. */
async function stopHub(probes: InstallProbes): Promise<string | null> {
  const stopped = await stopRunningHub();
  if (!stopped.ok) return stopped.failure.reason;
  if (stopped.value !== null) console.log(`Stopped the hub: ${stopped.value}.`);
  // Only a hub this user installed has a container to remove.
  const runtime = existsSync(installRecordPath()) ? probes.runtime() : null;
  if (runtime === null) return null;
  const removed = await removeContainer(runtime);
  if (!removed.ok) return removed.failure.reason;
  if (removed.value) console.log("Removed the hub's container.");
  return null;
}

async function uninstallHub(
  request: HubInstallRequest,
  probes: InstallProbes,
  spec: JobSpec,
): Promise<number> {
  if (!request.machine) {
    console.log(
      "The hub's job is the machine's, not a repository's, so it stays: remove it with jig uninstall hub --machine.",
    );
    return 0;
  }
  const here = await hubHere(spec);
  if (!here.ok) {
    console.error(`jig uninstall hub: ${here.failure.reason}`);
    return 1;
  }
  if (!here.value) {
    console.log("No hub job or install record here: nothing to remove.");
    return 0;
  }
  console.log(jobPreview(spec, true));
  if (!request.confirm) {
    console.log(
      "Preview only; add --yes to apply. The running hub stops; the database stays.",
    );
    return 0;
  }
  return exclusiveInstallLock(async () => {
    const written = await writeJob(spec, true);
    if (!written.ok) {
      console.error(written.failure.reason);
      return 1;
    }
    const unstopped = await stopHub(probes);
    if (unstopped !== null) {
      console.error(
        `jig uninstall hub: removed ${written.value}, but the hub did not stop: ${unstopped}`,
      );
      return 1;
    }
    rmSync(installRecordPath(), { force: true });
    console.log(`Removed: ${written.value}. The database stays.`);
    return 0;
  });
}
