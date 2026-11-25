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
import { buildCommand, runCommand } from "../container.ts";
import { hubDoctorChecks } from "../doctor.ts";
import { hubJobSpec, type InstallProbes, refusal } from "../install.ts";
import { parseHubSettings } from "../settings.ts";
import { lstatSync } from "node:fs";

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
  dispatcherHere: async () => null,
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
        "this user holds the dispatcher's machine file",
    }),
  ).toContain("never the dispatcher's");
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
      await doctor(file, { dispatcherHere: async () => "dispatcher" }),
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
  const docker = runCommand("docker", parsed.value, "1.2.3", identity);
  expect(docker).not.toContain("--replace");
  expect(docker).not.toContain("--userns=keep-id");
  expect(docker).toContain("1001:1001");
});
