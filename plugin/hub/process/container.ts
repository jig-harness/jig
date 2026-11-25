/**
 * The hub's container image and how the resident job runs it
 * ([design/control-plane.md § Apart from the sessions on a shared machine](../../../design/control-plane.md#apart-from-the-sessions-on-a-shared-machine)).
 *
 * `jig install hub` builds the image locally from the installed plugin copy
 * with the `Containerfile` beside this directory, tagged with the plugin's
 * version, and never pushes it to a registry. Podman (rootless) is used
 * where it is installed, else Docker. The run:
 *
 * - mounts the settings file read-only at `/run/jig-hub/settings.yaml`;
 * - mounts the database directory, and a feed socket's directory,
 *   read-write at their own paths, so the paths the settings name hold
 *   inside the container as outside it; the host side makes both before
 *   the run (`host-paths.ts`);
 * - shares the host's network (`--network=host`), so the listeners bind the
 *   host's loopback and private-network interfaces the settings name and
 *   no port is published beyond them (the container reaches the host's
 *   loopback services as well);
 * - runs as the hub's own uid and gid, with a read-only root filesystem.
 *
 * One resident job runs the container at a time (`instance.ts`), so a
 * container of the hub's name that is there when the job starts is one a
 * stopped job left behind, which the job removes before its run.
 */
import { dirname, join } from "node:path";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run, type RunResult } from "../../shared/proc.ts";
import type { HubSettings } from "./settings.ts";

/** The container tools, in the order `jig install hub` prefers them. */
const CONTAINER_RUNTIMES = ["podman", "docker"] as const;
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

/** Where the settings file is mounted inside the container. */
const CONTAINER_SETTINGS = "/run/jig-hub/settings.yaml";
/** The container's name, one hub per user. */
const CONTAINER_NAME = "jig-hub";

/** The image's tag for a plugin version. */
function imageTag(version: string): string {
  return `jig-hub:${version}`;
}

/** The first container tool on PATH, or null. */
export function containerRuntime(
  which: (program: string) => string | null = Bun.which,
): ContainerRuntime | null {
  return CONTAINER_RUNTIMES.find((program) => which(program) !== null) ?? null;
}

/** The command that builds the image from the plugin copy at `pluginRoot`. */
export function buildCommand(
  runtime: ContainerRuntime,
  pluginRoot: string,
  version: string,
  bunVersion: string,
): string[] {
  return [
    runtime,
    "build",
    "--build-arg",
    `BUN_VERSION=${bunVersion}`,
    "--tag",
    imageTag(version),
    "--file",
    join(pluginRoot, "hub", "Containerfile"),
    pluginRoot,
  ];
}

/** The command that tells whether the image for `version` is built. */
export function imageExistsCommand(
  runtime: ContainerRuntime,
  version: string,
): string[] {
  return [runtime, "image", "inspect", imageTag(version)];
}

/** Who runs inside the container: the hub user's ids, and the home its paths expand against. */
export interface RunIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  /** `JIG_HOME`, when set. */
  readonly jigHome?: string;
}

/** The command that runs `jig hub serve` in the image, in the foreground. */
export function runCommand(
  runtime: ContainerRuntime,
  settings: Pick<HubSettings, "path" | "database" | "feed">,
  version: string,
  identity: RunIdentity,
): string[] {
  const mounts = [
    `${settings.path}:${CONTAINER_SETTINGS}:ro`,
    `${settings.database}:${settings.database}:rw`,
  ];
  if ("socket" in settings.feed) {
    const directory = dirname(settings.feed.socket);
    mounts.push(`${directory}:${directory}:rw`);
  }
  return [
    runtime,
    "run",
    "--rm",
    "--name",
    CONTAINER_NAME,
    "--network=host",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--user",
    `${identity.uid}:${identity.gid}`,
    ...(runtime === "podman" ? ["--userns=keep-id"] : []),
    "--env",
    `HOME=${identity.home}`,
    ...(identity.jigHome === undefined
      ? []
      : ["--env", `JIG_HOME=${identity.jigHome}`]),
    ...mounts.flatMap((mount) => ["--volume", mount]),
    imageTag(version),
    "hub",
    "serve",
    "--settings",
    CONTAINER_SETTINGS,
  ];
}

/** The command that tells whether a container of the hub's name is there. */
export function containerExistsCommand(runtime: ContainerRuntime): string[] {
  return [runtime, "container", "inspect", CONTAINER_NAME];
}

/** The command that removes a container of the hub's name, stopping it first. */
export function removeCommand(runtime: ContainerRuntime): string[] {
  return [runtime, "rm", "--force", CONTAINER_NAME];
}

/** The command that stops the running container. */
export function stopCommand(runtime: ContainerRuntime): string[] {
  return [runtime, "stop", "--time", "10", CONTAINER_NAME];
}

/** Runs a container command; injected by tests. */
export type ContainerRunner = (
  command: string[],
  options: { timeoutSec: number },
) => Promise<Pick<RunResult, "code" | "stderr">>;

/** What the container tool says when there is no container of that name. */
const NO_CONTAINER = /no such (container|object)|no container with name/i;

/** A container command's failure, with the tool's own words. */
function commandFailed(
  command: readonly string[],
  result: Pick<RunResult, "code" | "stderr">,
): Outcome<never, "unavailable"> {
  return failed(
    "unavailable",
    `${command.join(" ")} exited ${result.code}: ${result.stderr.trim().slice(-500) || "it printed nothing"}`,
  );
}

/** Stops the hub's running container; whether one was running, or why it could not be stopped. */
export async function stopContainer(
  runtime: ContainerRuntime,
  runner: ContainerRunner = run,
): Promise<Outcome<boolean, "unavailable">> {
  const command = stopCommand(runtime);
  const stopped = await runner(command, { timeoutSec: 30 });
  if (stopped.code === 0) return ok(true);
  return NO_CONTAINER.test(stopped.stderr)
    ? ok(false)
    : commandFailed(command, stopped);
}

/** Removes a container of the hub's name, running or not; whether there was one, or why it could not be removed. */
export async function removeContainer(
  runtime: ContainerRuntime,
  runner: ContainerRunner = run,
): Promise<Outcome<boolean, "unavailable">> {
  const inspect = containerExistsCommand(runtime);
  const found = await runner(inspect, { timeoutSec: 30 });
  if (found.code !== 0)
    return NO_CONTAINER.test(found.stderr)
      ? ok(false)
      : commandFailed(inspect, found);
  const command = removeCommand(runtime);
  const removed = await runner(command, { timeoutSec: 30 });
  return removed.code === 0 || NO_CONTAINER.test(removed.stderr)
    ? ok(true)
    : commandFailed(command, removed);
}
