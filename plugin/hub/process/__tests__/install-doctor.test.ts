/**
 * The hub's settings, install refusals, doctor checks and container
 * commands: `/v1/` never on a public interface or every interface,
 * `jig install hub` refused to root, another user and the dispatcher's
 * user, `jig doctor hub` failing on files another user can read, and the
 * image run with its settings mounted read-only.
 */
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { failed, ok } from "../../../shared/outcome.ts";
import {
  buildCommand,
  type ContainerRunner,
  removeContainer,
  runCommand,
  stopContainer,
} from "../container.ts";
import { hubDoctorChecks } from "../doctor.ts";
import { feedPathBlocks, prepareHostPaths } from "../host-paths.ts";
import {
  hubJobSpec,
  type InstallProbes,
  installHub,
  refusal,
} from "../install.ts";
import { parseHubSettings } from "../settings.ts";
import { lstatSync, statSync } from "node:fs";

const scratch = mkdtempSync(join(tmpdir(), "hub-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const me = userInfo();
let made = 0;

function settingsFile(body = ""): { file: string; database: string } {
  const root = join(scratch, `s-${++made}`);
  mkdirSync(root, { mode: 0o700 });
  const database = join(root, "data");
  mkdirSync(database, { mode: 0o700 });
  const file = join(root, "settings.yaml");
  writeFileSync(file, `user: ${me.username}\ndatabase: ${database}\n${body}`, {
    mode: 0o600,
  });
  return { file, database };
}

const parse = (text: string) => parseHubSettings(text, "/hub/settings.yaml");

test("/v1/ and the webhook listener take loopback and private-network addresses only", () => {
  for (const address of [
    "127.0.0.1:7461",
    "10.1.2.3:7461",
    "172.16.0.9:7461",
    "192.168.1.5:7461",
    "100.101.102.103:7461",
    "[::1]:7461",
    "[fd12::1]:7461",
  ])
    expect(parse(`host:\n  listen: ["${address}"]`).ok).toBe(true);
  for (const address of [
    "0.0.0.0:7461",
    "[::]:7461",
    "[fe80::1]:7461",
    "8.8.8.8:7461",
    "localhost:7461",
    "127.0.0.1",
  ]) {
    expect(parse(`host:\n  listen: ["${address}"]`).ok).toBe(false);
    expect(parse(`webhooks:\n  listen: "${address}"`).ok).toBe(false);
  }
});

test("the settings default to the hub's user and refuse an unknown setting or a feed secret without a port", () => {
  const defaults = parse("");
  expect(defaults.ok && defaults.value.user).toBe("jig-hub");
  expect(defaults.ok && defaults.value.host).toEqual([
    { host: "127.0.0.1", port: 7461 },
  ]);
  expect(parse("hots: {}").ok).toBe(false);
  expect(
    parse(`feed:\n  socket: /run/f.sock\n  secret: ${"x".repeat(40)}`).ok,
  ).toBe(false);
  expect(parse("feed:\n  listen: 127.0.0.1:7463\n  secret: short").ok).toBe(
    false,
  );
  expect(
    parse(`feed:\n  listen: 10.0.0.1:7463\n  secret: ${"x".repeat(40)}`).ok,
  ).toBe(false);
});

const probes = (over: Partial<InstallProbes> = {}): InstallProbes => ({
  identity: () => ({ uid: me.uid, gid: me.gid, user: me.username }),
  dispatcherHere: async () => ok(null),
  runtime: () => null,
  availability: async () => null,
  platform: "linux",
  ...over,
});

test("jig install hub refuses root, another user and the dispatcher's user, and accepts the hub's own", async () => {
  const { file } = settingsFile();
  const refused = async (over: Partial<InstallProbes>) => {
    const answer = await refusal({ settingsPath: file }, probes(over));
    return answer.ok ? null : answer.failure.reason;
  };
  expect(
    await refused({ identity: () => ({ uid: 0, gid: 0, user: "root" }) }),
  ).toContain("root");
  expect(
    await refused({
      identity: () => ({ uid: me.uid, gid: me.gid, user: "someone-else" }),
    }),
  ).toContain(`runs as the hub's user, ${me.username}`);
  expect(
    await refused({
      dispatcherHere: async () =>
        ok("this user holds the dispatcher's machine file"),
    }),
  ).toContain("never the dispatcher's");
  // A scheduler that cannot be read refuses the install rather than pass it.
  expect(
    await refused({
      dispatcherHere: async () =>
        failed("unreadable", "cannot tell: crontab -l failed"),
    }),
  ).toContain("cannot tell: crontab -l failed");
  expect(await refused({})).toBeNull();
  const job = hubJobSpec();
  expect(job.args).toEqual(["hub", "serve", "--scheduled"]);
  expect(job.schedule).toEqual({ everyMinutes: 1, afterExit: true });
});

test("jig install hub refuses a settings file another user can read, and a default user it is not", async () => {
  const { file } = settingsFile();
  chmodSync(file, 0o640);
  const exposed = await refusal({ settingsPath: file }, probes());
  expect(exposed.ok ? null : exposed.failure.reason).toContain(
    "readable beyond",
  );
  const other = join(scratch, "default-user.yaml");
  writeFileSync(other, "", { mode: 0o600 });
  const named = await refusal({ settingsPath: other }, probes());
  expect(named.ok ? null : named.failure.reason).toContain("jig-hub");
});

async function doctor(file: string, over: Partial<InstallProbes> = {}) {
  const p = probes(over);
  return hubDoctorChecks({
    identity: { uid: me.uid, user: me.username },
    settingsPath: file,
    stat: (path) => lstatSync(path),
    dispatcherHere: p.dispatcherHere,
    runtime: p.runtime,
  });
}

const statusOf = (checks: { id: string; status: string }[], id: string) =>
  checks.find((c) => c.id === id)?.status;

test("jig doctor hub fails a settings file or database directory another user can read", async () => {
  const { file, database } = settingsFile();
  const clean = await doctor(file, { runtime: () => "podman" });
  expect(clean.filter((c) => c.status === "fail")).toEqual([]);
  chmodSync(file, 0o644);
  expect(statusOf(await doctor(file), "hub:settings-mode")).toBe("fail");
  chmodSync(file, 0o600);
  chmodSync(database, 0o755);
  expect(statusOf(await doctor(file), "hub:database-mode")).toBe("fail");
  chmodSync(database, 0o700);
  expect(
    statusOf(
      await doctor(file, { dispatcherHere: async () => ok("dispatcher") }),
      "hub:user",
    ),
  ).toBe("fail");
  expect(
    statusOf(
      await doctor(file, {
        dispatcherHere: async () => failed("unreadable", "no scheduler"),
      }),
      "hub:user",
    ),
  ).toBe("fail");
  expect(statusOf(await doctor(file), "hub:container")).toBe("warn");
});

test("jig doctor hub skips a machine with no hub settings", async () => {
  const checks = await doctor(join(scratch, "absent.yaml"));
  expect(checks.map((c) => c.status)).toEqual(["skip"]);
});

test("the image is built from the plugin copy and run with its settings mounted read-only on the host's network", () => {
  expect(buildCommand("podman", "/plugin", "1.2.3", "1.4.4")).toEqual([
    "podman",
    "build",
    "--build-arg",
    "BUN_VERSION=1.4.4",
    "--tag",
    "jig-hub:1.2.3",
    "--file",
    "/plugin/hub/Containerfile",
    "/plugin",
  ]);
  const parsed = parseHubSettings(
    "database: /srv/hub/data\nfeed:\n  socket: /run/jig-hub/feed/feed.sock\n",
    "/srv/hub/settings.yaml",
  );
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  const identity = { uid: 1001, gid: 1001, home: "/home/jig-hub" };
  const podman = runCommand("podman", parsed.value, "1.2.3", identity);
  expect(podman).toContain("--network=host");
  expect(podman).toContain("--read-only");
  expect(podman).toContain("--userns=keep-id");
  expect(podman).toContain(
    "/srv/hub/settings.yaml:/run/jig-hub/settings.yaml:ro",
  );
  expect(podman).toContain("/srv/hub/data:/srv/hub/data:rw");
  expect(podman.slice(podman.indexOf("jig-hub:1.2.3"))).toEqual([
    "jig-hub:1.2.3",
    "hub",
    "serve",
    "--settings",
    "/run/jig-hub/settings.yaml",
  ]);
  expect(podman).not.toContain("--replace");
  expect(podman).toContain("/run/jig-hub/feed:/run/jig-hub/feed:rw");
  const docker = runCommand("docker", parsed.value, "1.2.3", identity);
  expect(docker).not.toContain("--replace");
  expect(docker).not.toContain("--userns=keep-id");
  expect(docker).toContain("1001:1001");
});

test("the default feed socket sits outside the hub's own directory", () => {
  const defaults = parseHubSettings("", "/hub/settings.yaml", {
    JIG_HOME: "/home/jig-hub/.jig",
  });
  expect(defaults.ok && defaults.value.feed).toEqual({
    socket: "/home/jig-hub/.jig/hub-feed/feed.sock",
    group: null,
  });
});

test("the host side makes the feed socket's directory the hub user's alone, or 0710 and the front's group", () => {
  const root = join(scratch, "paths");
  mkdirSync(root, { mode: 0o711 });
  const database = join(root, "data");
  const alone = prepareHostPaths({
    database,
    feed: { socket: join(root, "alone", "feed.sock"), group: null },
  });
  expect(alone).toEqual({ ok: true, value: [] });
  expect(statSync(database).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "alone")).mode & 0o777).toBe(0o700);
  // The front's group is resolved on the host; here, this user's own primary group.
  const shared = prepareHostPaths(
    {
      database,
      feed: { socket: join(root, "front", "feed.sock"), group: "front" },
    },
    () => ok(me.gid),
  );
  expect(shared.ok).toBe(true);
  const front = statSync(join(root, "front"));
  expect(front.mode & 0o777).toBe(0o710);
  expect(front.gid).toBe(me.gid);
  const unknown = prepareHostPaths(
    {
      database,
      feed: { socket: join(root, "x", "feed.sock"), group: "nobody-here" },
    },
    () => failed("unavailable", "no group named nobody-here in /etc/group"),
  );
  expect(unknown.ok ? null : unknown.failure.reason).toContain("nobody-here");
});

test("a directory above the socket's that the front's group cannot pass is named", () => {
  const root = join(scratch, "closed");
  mkdirSync(join(root, "feed"), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const socket = join(root, "feed", "feed.sock");
  const blocks = feedPathBlocks(socket, me.gid + 100_000);
  expect(blocks[0]).toBe(`${root} (mode 0700)`);
  chmodSync(root, 0o711);
  expect(feedPathBlocks(socket, me.gid + 100_000)).not.toContain(
    `${root} (mode 0711)`,
  );
});

test("a container stop or removal that fails says so; a missing container is no failure", async () => {
  const answer =
    (code: number, stderr = ""): ContainerRunner =>
    async () => ({ code, stderr });
  expect(await stopContainer("podman", answer(0))).toEqual(ok(true));
  expect(
    await stopContainer(
      "podman",
      answer(125, 'Error: no container with name or ID "jig-hub" found'),
    ),
  ).toEqual(ok(false));
  const refused = await stopContainer(
    "docker",
    answer(1, "permission denied while trying to connect to the Docker daemon"),
  );
  expect(refused.ok ? null : refused.failure.reason).toContain(
    "permission denied",
  );
  expect(
    await removeContainer(
      "docker",
      answer(1, "Error: No such container: jig-hub"),
    ),
  ).toEqual(ok(false));
  const calls: string[][] = [];
  const removed = await removeContainer("podman", async (command) => {
    calls.push(command);
    return command[1] === "rm"
      ? { code: 2, stderr: "cannot remove" }
      : { code: 0, stderr: "" };
  });
  expect(calls.map((command) => command[1])).toEqual(["container", "rm"]);
  expect(removed.ok ? null : removed.failure.reason).toContain("cannot remove");
});

test("jig uninstall hub without --machine leaves the hub's job, saying how to remove it", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const code = await installHub(
      {
        confirm: true,
        remove: true,
        machine: false,
        script: "/nowhere/jig.ts",
      },
      probes(),
    );
    expect(code).toBe(0);
  } finally {
    console.log = log;
  }
  expect(lines.join("\n")).toContain("jig uninstall hub --machine");
});

test("jig doctor hub checks the feed socket's directory", async () => {
  const { file } = settingsFile(
    `feed:\n  socket: ${join(scratch, "doctor-feed", "feed.sock")}\n`,
  );
  expect(statusOf(await doctor(file), "hub:feed")).toBe("warn");
  mkdirSync(join(scratch, "doctor-feed"), { mode: 0o700 });
  chmodSync(join(scratch, "doctor-feed"), 0o700);
  expect(statusOf(await doctor(file), "hub:feed")).toBe("pass");
  chmodSync(join(scratch, "doctor-feed"), 0o755);
  expect(statusOf(await doctor(file), "hub:feed")).toBe("fail");
});
