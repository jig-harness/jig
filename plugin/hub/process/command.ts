/**
 * `jig hub serve`, in the foreground or as the resident job
 * (`--scheduled`).
 *
 * In the foreground it starts the hub in this process and stops on an
 * interrupt or a terminate signal. As the resident job it runs the hub the
 * way `jig install hub` recorded: in the hub's image (built again when the
 * installed release has none yet) or in this process. Either way it ends
 * when the settings file changes or the installed plugin copy is no
 * longer this one, so the job's timer starts it again on the new copy, as
 * the dispatch dashboard's reader does. The resident job runs once per
 * user at a time (`instance.ts`): a start while one runs leaves at once,
 * exit 0, saying nothing.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { installedEntry } from "../../runtime/launcher.ts";
import { pluginPrograms } from "../../runtime/scheduler.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import { currentMs } from "../../shared/time.ts";
import {
  type ContainerRuntime,
  imageExistsCommand,
  removeContainer,
  runCommand,
  stopContainer,
} from "./container.ts";
import { prepareHostPaths } from "./host-paths.ts";
import { withServeLock } from "./instance.ts";
import {
  buildImage,
  type InstallRecord,
  installRecordPath,
  pluginVersion,
} from "./install.ts";
import { startHub } from "./serve.ts";
import { defaultSettingsPath, readHubSettings } from "./settings.ts";

/** How often the resident job looks for a changed settings file; the installed copy, once a minute. */
const WATCH_MS = 1_000;
const COPY_CHECK_MS = 60_000;

/** The signal that aborts on an interrupt or a terminate. */
function signalled(): AbortController {
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => stop.abort(signal));
  return stop;
}

/** Starts the hub in this process; resolves when it has stopped. */
async function serveHere(
  settingsPath: string,
  stop: AbortSignal,
): Promise<number> {
  const settings = readHubSettings(settingsPath);
  if (!settings.ok) {
    console.error(`jig hub serve: ${settings.failure.reason}`);
    return 1;
  }
  const started = await startHub({
    settings: settings.value,
    identity: { uid: userInfo().uid },
    stop,
  });
  if (!started.ok) {
    console.error(`jig hub serve: ${started.failure.reason}`);
    return 1;
  }
  for (const listener of started.value.listeners)
    console.log(`${listener.name}: ${listener.address}`);
  await started.value.stopped;
  return 0;
}

/** `jig hub serve` in the foreground. */
export function serveForeground(
  settingsPath: string | undefined,
): Promise<number> {
  return serveHere(settingsPath ?? defaultSettingsPath(), signalled().signal);
}

function readRecord(): Outcome<InstallRecord, "unreadable"> {
  const parsed = attempt(
    "unreadable",
    "jig install hub has not run as this user",
    (): unknown => JSON.parse(readFileSync(installRecordPath(), "utf8")),
  );
  if (!parsed.ok) return parsed;
  const value = isMapping(parsed.value) ? parsed.value : {};
  if (typeof value.settings !== "string")
    return failed(
      "unreadable",
      `${installRecordPath()} names no settings file`,
    );
  return ok({
    runtime:
      value.runtime === "podman" || value.runtime === "docker"
        ? value.runtime
        : null,
    settings: value.settings,
  });
}

/** Watches for a changed settings file or installed copy, and aborts `stop` when one changes. */
function watchForChange(
  script: string,
  settingsPath: string,
  stop: AbortController,
): () => void {
  const read = () =>
    attempt("unreadable", "", () => readFileSync(settingsPath, "utf8"));
  const first = read();
  const own = attempt("unreadable", "", () => realpathSync(script));
  let nextCopyCheck = currentMs() + COPY_CHECK_MS;
  let lookupFailing = false;
  const timer = setInterval(async () => {
    const now = read();
    if (!first.ok || !now.ok || now.value !== first.value) {
      stop.abort("the settings changed");
      return;
    }
    if (currentMs() < nextCopyCheck) return;
    nextCopyCheck = currentMs() + COPY_CHECK_MS;
    const entry = await installedEntry(pluginPrograms()).then(
      (path) => ok(path),
      (error: unknown) =>
        failed(
          "unreadable",
          error instanceof Error ? error.message : String(error),
        ),
    );
    // An unreadable registry is no change: the next check asks again, and the first failure in a row is logged.
    if (!entry.ok) {
      if (!lookupFailing)
        console.error(
          `jig hub serve: cannot find the installed plugin copy (${entry.failure.reason}); looking again each minute`,
        );
      lookupFailing = true;
      return;
    }
    lookupFailing = false;
    // A copy that no longer resolves has been replaced or removed.
    const installed = attempt("unreadable", "", () =>
      realpathSync(entry.value),
    );
    if (!own.ok || !installed.ok || installed.value !== own.value)
      stop.abort("the installed copy changed");
  }, WATCH_MS);
  return () => clearInterval(timer);
}

/** Runs the hub's image in the foreground until `stop` aborts. */
async function serveInContainer(
  runtime: ContainerRuntime,
  script: string,
  settingsPath: string,
  stop: AbortSignal,
): Promise<number> {
  const pluginRoot = dirname(script);
  const version = pluginVersion(pluginRoot);
  const settings = readHubSettings(settingsPath);
  if (!version.ok || !settings.ok) {
    console.error(
      `jig hub serve: ${version.ok ? (settings.ok ? "" : settings.failure.reason) : version.failure.reason}`,
    );
    return 1;
  }
  const present = await run(imageExistsCommand(runtime, version.value), {
    timeoutSec: 60,
  });
  if (present.code !== 0) {
    const built = await buildImage(runtime, pluginRoot);
    if (!built.ok) {
      console.error(`jig hub serve: ${built.failure.reason}`);
      return 1;
    }
  }
  const info = userInfo();
  const command = runCommand(runtime, settings.value, version.value, {
    uid: info.uid,
    gid: info.gid,
    home: homedir(),
    ...(process.env.JIG_HOME ? { jigHome: process.env.JIG_HOME } : {}),
  });
  // Only one resident job runs at a time, so a container of the hub's name is one a stopped job left.
  const leftover = await removeContainer(runtime);
  if (!leftover.ok) {
    console.error(`jig hub serve: ${leftover.failure.reason}`);
    return 1;
  }
  console.log(`jig hub serve: ${command.join(" ")}`);
  const child = Bun.spawn(command, { stdio: ["ignore", "inherit", "inherit"] });
  const stopping: { outcome?: ReturnType<typeof stopContainer> } = {};
  const onStop = () => {
    stopping.outcome = stopContainer(runtime);
  };
  stop.addEventListener("abort", onStop, { once: true });
  const code = await child.exited;
  stop.removeEventListener("abort", onStop);
  if (stopping.outcome === undefined) return code;
  const outcome = await stopping.outcome;
  if (outcome.ok) return 0;
  console.error(`jig hub serve: ${outcome.failure.reason}`);
  return 1;
}

/** The resident job's run, holding the single-instance lock. */
async function serveRecorded(script: string): Promise<number> {
  const record = readRecord();
  if (!record.ok) {
    console.error(`jig hub serve --scheduled: ${record.failure.reason}`);
    return 1;
  }
  const settings = readHubSettings(record.value.settings);
  if (!settings.ok) {
    console.error(`jig hub serve --scheduled: ${settings.failure.reason}`);
    return 1;
  }
  const prepared = prepareHostPaths(settings.value);
  if (!prepared.ok) {
    console.error(`jig hub serve --scheduled: ${prepared.failure.reason}`);
    return 1;
  }
  for (const warning of prepared.value)
    console.error(`jig hub serve --scheduled: ${warning}`);
  const stop = signalled();
  const unwatch = watchForChange(script, record.value.settings, stop);
  try {
    return record.value.runtime === null
      ? await serveHere(record.value.settings, stop.signal)
      : await serveInContainer(
          record.value.runtime,
          script,
          record.value.settings,
          stop.signal,
        );
  } finally {
    unwatch();
  }
}

/** `jig hub serve --scheduled`: the resident job, once per user; a start while one runs leaves, exit 0. */
export async function serveScheduled(script: string): Promise<number> {
  const locked = await withServeLock(() => serveRecorded(script));
  if (!locked.ok) {
    console.error(`jig hub serve --scheduled: ${locked.failure.reason}`);
    return 1;
  }
  return locked.value === null ? 0 : locked.value.value;
}
