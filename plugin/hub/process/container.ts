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
 *   inside the container as outside it;
 * - shares the host's network (`--network=host`), so the listeners bind the
 *   host's loopback and private-network interfaces the settings name and
 *   no port is published beyond them;
 * - runs as the hub's own uid and gid, with a read-only root filesystem.
 */
import { dirname, join } from "node:path";
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
    "--replace",
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
  ].filter((arg) => runtime === "podman" || arg !== "--replace");
}

/** The command that stops the running container. */
export function stopCommand(runtime: ContainerRuntime): string[] {
  return [runtime, "stop", "--time", "10", CONTAINER_NAME];
}
