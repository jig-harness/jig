/**
 * `jig hub serve`'s process on real listeners: the webhook listener
 * answers only `/webhooks/<source>`, each listener answers from its own
 * table, a slow job in the worker thread leaves webhook acknowledgements
 * under a second, and the hub refuses settings another user can read.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userInfo } from "node:os";
import { ok } from "../../../shared/outcome.ts";
import type { HubRoutes } from "../../core/routes.ts";
import { emptyRoutes } from "../../core/routes.ts";
import type { RequestHandler } from "../../core/serving.ts";
import { FRONT_SECRET_HEADER } from "../listeners.ts";
import { readServeRecord, type RunningHub, startHub } from "../serve.ts";
import { type HubSettings, parseHubSettings } from "../settings.ts";
import { fakePorts } from "../../core/__tests__/fake-ports.ts";
import * as hubJobs from "../jobs.ts";
import {
  endedMarker,
  JOB_NAMES,
  jobHandlers,
  SLOW_MS,
  startedMarker,
} from "./slow-jobs.ts";

const scratch = mkdtempSync(join(tmpdir(), "hub-serve-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const identity = { uid: userInfo().uid };
let stops: AbortController[] = [];
afterEach(async () => {
  for (const stop of stops) stop.abort();
  stops = [];
});

let made = 0;
/** Settings on ephemeral ports in a fresh directory, mode 0600, its database 0700. */
function settingsIn(feed: string): HubSettings {
  const root = join(scratch, `hub-${++made}`);
  mkdirSync(root, { mode: 0o700 });
  const file = join(root, "settings.yaml");
  const text = `user: ${userInfo().username}
database: ${join(root, "data")}
host:
  listen: [127.0.0.1:0]
webhooks:
  listen: 127.0.0.1:0
feed:
${feed.replaceAll("ROOT", root)}
`;
  writeFileSync(file, text, { mode: 0o600 });
  const parsed = parseHubSettings(text, file);
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  return parsed.value;
}

const acknowledge: RequestHandler = async () =>
  ok({ status: 202, headers: {}, body: "accepted" });

async function start(
  settings: HubSettings,
  routes: HubRoutes = emptyRoutes(),
): Promise<RunningHub> {
  const stop = new AbortController();
  stops.push(stop);
  const started = await startHub({
    settings,
    identity,
    stop: stop.signal,
    routes,
    jobs: {
      module: new URL("./slow-jobs.ts", import.meta.url).href,
      names: JOB_NAMES,
    },
  });
  if (!started.ok) throw new Error(started.failure.reason);
  return started.value;
}

const url = (hub: RunningHub, name: string) =>
  hub.listeners.find((listener) => listener.name === name)?.address as string;

const SOCKET_FEED = "  socket: ROOT/feed/feed.sock";

test("the webhook listener answers 404 to every path outside /webhooks/<source>", async () => {
  const hub = await start(settingsIn(SOCKET_FEED), {
    ...emptyRoutes(),
    webhooks: new Map([["github", acknowledge]]),
  });
  const webhook = url(hub, "webhook");
  for (const path of [
    "/",
    "/v1/join",
    "/webhooks/",
    "/webhooks/github/x",
    "/health",
  ]) {
    const answer = await fetch(`${webhook}${path}`, { method: "POST" });
    expect({ path, status: answer.status }).toEqual({ path, status: 404 });
  }
  const unknown = await fetch(`${webhook}/webhooks/linear`, { method: "POST" });
  expect(unknown.status).toBe(404);
  expect(
    ((await unknown.json()) as { error: { code: string } }).error.code,
  ).toBe("unknown-source");
  const known = await fetch(`${webhook}/webhooks/github`, { method: "POST" });
  expect(known.status).toBe(202);
  // The host listener never serves a webhook path, whatever the webhook table holds.
  const host = await fetch(`${url(hub, "host")}/webhooks/github`, {
    method: "POST",
  });
  expect(host.status).toBe(404);
});

test("the listeners bind the settings' loopback addresses, recorded in serve.json, and the feed's socket is the hub user's alone", async () => {
  const settings = settingsIn(SOCKET_FEED);
  const hub = await start(settings);
  const record = readServeRecord(settings.database);
  expect(record?.listeners.map((listener) => listener.name).sort()).toEqual([
    "feed",
    "host",
    "webhook",
  ]);
  for (const listener of hub.listeners.filter((l) => l.name !== "feed"))
    expect(listener.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const socket = join(settings.database, "..", "feed", "feed.sock");
  expect(statSync(socket).mode & 0o777).toBe(0o600);
  const answer = await fetch("http://hub/anything", { unix: socket });
  expect(answer.status).toBe(404);
});

test("a feed on loopback answers 401 without the front's secret", async () => {
  const secret = "s".repeat(40);
  const hub = await start(
    settingsIn(`  listen: 127.0.0.1:0\n  secret: ${secret}`),
  );
  const feed = url(hub, "feed");
  expect((await fetch(`${feed}/feed`)).status).toBe(401);
  expect(
    (
      await fetch(`${feed}/feed`, {
        headers: { [FRONT_SECRET_HEADER]: "wrong" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${feed}/feed`, {
        headers: { [FRONT_SECRET_HEADER]: secret },
      })
    ).status,
  ).toBe(404);
});

test("a slow job in the worker thread leaves every webhook acknowledged within a second", async () => {
  rmSync(startedMarker(), { force: true });
  rmSync(endedMarker(), { force: true });
  const hub = await start(settingsIn(SOCKET_FEED), {
    ...emptyRoutes(),
    webhooks: new Map([["github", acknowledge]]),
  });
  const context = {
    unit: "test",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
  expect((await hub.scheduling.runSoon(context, "slow")).ok).toBe(true);
  const deadline = performance.now() + 10_000;
  while (!existsSync(startedMarker())) {
    if (performance.now() > deadline)
      throw new Error("the slow job never started");
    await Bun.sleep(10);
  }
  const webhook = `${url(hub, "webhook")}/webhooks/github`;
  const latencies: number[] = [];
  const until = performance.now() + SLOW_MS / 2;
  while (performance.now() < until) {
    const sent = performance.now();
    const answer = await fetch(webhook, { method: "POST", body: "{}" });
    latencies.push(performance.now() - sent);
    expect(answer.status).toBe(202);
    await Bun.sleep(20);
  }
  // Every acknowledgement came while the job still held its thread.
  expect(existsSync(endedMarker())).toBe(false);
  expect(latencies.length).toBeGreaterThan(5);
  expect(Math.max(...latencies)).toBeLessThan(1_000);
}, 20_000);

test("the hub refuses to start on a settings file or database directory another user can read", async () => {
  const settings = settingsIn(SOCKET_FEED);
  const stop = new AbortController();
  stops.push(stop);
  chmodSync(settings.path, 0o644);
  const file = await startHub({ settings, identity, stop: stop.signal });
  expect(file.ok ? null : file.failure.code).toBe("exposed");
  chmodSync(settings.path, 0o600);
  mkdirSync(settings.database, { recursive: true });
  chmodSync(settings.database, 0o750);
  const directory = await startHub({ settings, identity, stop: stop.signal });
  expect(directory.ok ? null : directory.failure.code).toBe("exposed");
});

test("every job a module names has a handler the worker runs, the hub's own and the test's", () => {
  for (const module of [hubJobs, { JOB_NAMES, jobHandlers }])
    expect([...module.jobHandlers(fakePorts()).keys()].sort()).toEqual(
      [...module.JOB_NAMES].sort(),
    );
});
