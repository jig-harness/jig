/**
 * The dashboard's private socket (`dashboard.socket`): it answers the read
 * routes under mode 0600, refuses every non-GET as the TCP listener does,
 * replaces only a stale socket, and `--status` sees a Funnel route to it, or a
 * socket whose mode or owner changed. A second user cannot be created here, so
 * what keeps one out is checked where it lives: the socket's mode and owner.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentMs } from "../../shared/time.ts";
import { serveDashboard, type Dashboard } from "../dashboard.ts";
import { funnelExposure } from "../dashboard-funnel.ts";
import { readerSettings } from "../dashboard-reader.ts";
import {
  ancestorProblem,
  parentProblem,
  socketProblem,
  socketAnswers,
} from "../dashboard-socket.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";

const LISTEN = { host: "127.0.0.1", port: null } as const;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dash-sock-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serve(socket: string, token: string | null = "fixture-token") {
  const served: Dashboard = serveDashboard({
    listen: LISTEN,
    port: 0,
    root: scratch(),
    token,
    socket,
  });
  cleanups.push(() => served.stop());
  return served;
}

const overSocket = (socket: string, method = "GET", path = "/") =>
  fetch(`http://dashboard${path}`, { unix: socket, method });

describe("the private socket", () => {
  it("answers the read routes with no token, mode 0600 and the reader's own", async () => {
    const socket = join(scratch(), "d.sock");
    const served = serve(socket);
    const stat = lstatSync(socket);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(process.getuid?.() ?? stat.uid);
    expect((await overSocket(socket)).status).toBe(200);
    expect((await overSocket(socket, "GET", "/nothing-here")).status).toBe(404);
    // The same server's TCP address still wants its token.
    const base = new URL(served.url);
    expect((await fetch(new URL("/", `${base.origin}`))).status).toBe(403);
    expect(await socketAnswers(socket)).toBe(true);
  });

  it("answers 405 to every non-GET on the socket and on the TCP address", async () => {
    const socket = join(scratch(), "d.sock");
    const served = serve(socket);
    const tcp = new URL(served.url);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await overSocket(socket, method)).status).toBe(405);
      expect((await fetch(tcp, { method })).status).toBe(405);
    }
  });

  it("answers 405 on a loopback address that asks for no token", async () => {
    const socket = join(scratch(), "d.sock");
    const served = serve(socket, null);
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await fetch(served.url, { method })).status).toBe(405);
  });

  it("removes the socket when the server stops", () => {
    const socket = join(scratch(), "d.sock");
    const served = serve(socket);
    expect(existsSync(socket)).toBe(true);
    served.stop();
    expect(existsSync(socket)).toBe(false);
  });

  it("replaces a socket a killed reader left behind", async () => {
    const socket = join(scratch(), "d.sock");
    const dead = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.serve({ unix: ${JSON.stringify(socket)}, fetch: () => new Response("old") }); setInterval(() => {}, 1000);`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const deadline = currentMs() + 10_000;
    while (!existsSync(socket) && currentMs() < deadline) await Bun.sleep(20);
    dead.kill("SIGKILL");
    await dead.exited;
    expect(lstatSync(socket).isSocket()).toBe(true);
    serve(socket);
    expect(await (await overSocket(socket)).text()).toContain("<");
  });

  it("refuses a file that is not a socket and removes nothing", () => {
    const dir = scratch();
    const socket = join(dir, "d.sock");
    writeFileSync(socket, "keep");
    expect(() =>
      serveDashboard({ listen: LISTEN, port: 0, root: dir, socket }),
    ).toThrow("not a socket");
    expect(existsSync(socket)).toBe(true);
  });

  it("refuses a socket a live listener holds and leaves it answering", async () => {
    const dir = scratch();
    const socket = join(dir, "d.sock");
    serve(socket);
    expect(() =>
      serveDashboard({ listen: LISTEN, port: 0, root: dir, socket }),
    ).toThrow("running listener");
    expect((await overSocket(socket)).ok).toBe(true);
  });

  it("removes only its own socket when it stops", () => {
    const dir = scratch();
    const socket = join(dir, "d.sock");
    const served = serve(socket);
    rmSync(socket);
    const other = Bun.serve({ unix: socket, fetch: () => new Response("x") });
    cleanups.push(() => other.stop(true));
    served.stop();
    expect(existsSync(socket)).toBe(true);
  });

  it("refuses a parent directory that others can write to", () => {
    const dir = scratch();
    chmodSync(dir, 0o777);
    expect(() =>
      serveDashboard({
        listen: LISTEN,
        port: 0,
        root: dir,
        socket: join(dir, "d.sock"),
      }),
    ).toThrow("others can write");
    expect(
      parentProblem({ isDirectory: true, mode: 0o40700, uid: 5 }, 5),
    ).toBeNull();
    expect(
      parentProblem({ isDirectory: true, mode: 0o40700, uid: 6 }, 5),
    ).toContain("owned by");
  });

  it("refuses a directory under an ancestor others can write to, but allows a sticky one", () => {
    const outer = scratch();
    const inner = join(outer, "inner");
    mkdirSync(inner, { mode: 0o700 });
    const uid = process.getuid?.();
    expect(ancestorProblem(inner, uid)).toBeNull();
    chmodSync(outer, 0o777);
    expect(ancestorProblem(inner, uid)).toContain("others can write");
    chmodSync(outer, 0o1777);
    expect(ancestorProblem(inner, uid)).toBeNull();
  });

  it("walks through a link the reader made, and refuses one under a directory others can write to", () => {
    const real = scratch();
    const target = join(real, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(real, "link");
    symlinkSync(target, link);
    const uid = process.getuid?.();
    expect(ancestorProblem(join(link, "inner"), uid)).toBeNull();
    chmodSync(real, 0o777);
    expect(ancestorProblem(join(link, "inner"), uid)).toContain(
      "others can write",
    );
  });

  it("is created under a tight umask, so no mode is wider than 0600 to begin with", () => {
    const dir = scratch();
    const before = process.umask(0o000);
    try {
      const socket = join(dir, "d.sock");
      serve(socket);
      expect(lstatSync(socket).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(before);
    }
  });
});

describe("what --status reads of the socket", () => {
  const good = { isSocket: true, mode: 0o140600, uid: 1000 };

  it("passes mode 0600 owned by the reader", () => {
    expect(socketProblem(good, 1000)).toBeNull();
  });

  it("fails a changed mode, another owner, a non-socket and a missing socket", () => {
    expect(socketProblem({ ...good, mode: 0o140660 }, 1000)).toContain("0660");
    expect(socketProblem({ ...good, mode: 0o140666 }, 1000)).toContain("0666");
    expect(socketProblem({ ...good, uid: 0 }, 1000)).toContain(
      "owned by user 0",
    );
    expect(socketProblem({ ...good, isSocket: false }, 1000)).toContain(
      "not a socket",
    );
    expect(socketProblem(null, 1000)).toContain("does not exist");
  });

  it("sees a socket whose mode was loosened on disk", () => {
    const socket = join(scratch(), "d.sock");
    serve(socket);
    chmodSync(socket, 0o660);
    const stat = lstatSync(socket);
    expect(
      socketProblem(
        { isSocket: stat.isSocket(), mode: stat.mode, uid: stat.uid },
        stat.uid,
      ),
    ).toContain("0660");
  });
});

describe("Funnel", () => {
  const mine = {
    listen: { host: "127.0.0.1", port: 8765 },
    defaultPort: 8765,
    socket: "/run/user/1000/jig-dashboard.sock",
  };
  const route = (name: string, target: string) => ({
    Web: { [name]: { Handlers: { "/": { Proxy: target } } } },
    TCP: { [name.split(":")[1] as string]: { HTTPS: true } },
    AllowFunnel: { [name]: true },
  });

  it("names a Funnel route to the socket or to the TCP port", () => {
    for (const target of [
      "unix:/run/user/1000/jig-dashboard.sock",
      "http://127.0.0.1:8765",
      "http://localhost:8765/",
    ]) {
      const found = funnelExposure(route("h.ts.net:443", target), mine);
      expect(found).toMatchObject({ ok: true, value: ["h.ts.net:443"] });
    }
  });

  it("ignores a Funnel route to another service, and a route Funnel does not open", () => {
    expect(
      funnelExposure(route("h.ts.net:443", "http://127.0.0.1:9120"), mine),
    ).toMatchObject({ ok: true, value: [] });
    expect(
      funnelExposure(route("h.ts.net:443", "unix:/other.sock"), mine),
    ).toMatchObject({ ok: true, value: [] });
    const closed = {
      ...route("h.ts.net:8443", "unix:/run/user/1000/jig-dashboard.sock"),
      AllowFunnel: { "h.ts.net:8443": false },
    };
    expect(funnelExposure(closed, mine)).toMatchObject({ ok: true, value: [] });
    expect(funnelExposure({}, mine)).toMatchObject({ ok: true, value: [] });
  });

  it("names a raw TCP forward to the port under Funnel", () => {
    const status = {
      TCP: { "8443": { TCPForward: "127.0.0.1:8765" } },
      AllowFunnel: { "h.ts.net:8443": true },
    };
    expect(funnelExposure(status, mine)).toMatchObject({
      ok: true,
      value: ["h.ts.net:8443"],
    });
  });

  it("fails on a status it cannot read, never as no Funnel", () => {
    expect(funnelExposure("nope", mine).ok).toBe(false);
    expect(funnelExposure({ AllowFunnel: [true] }, mine).ok).toBe(false);
    for (const bad of [
      { AllowFunnel: { "h:443": true }, Web: [] },
      { AllowFunnel: { "h:443": true }, TCP: "x" },
      { AllowFunnel: { "h:443": true }, Web: { "h:443": "x" } },
      { AllowFunnel: { "h:443": true }, Web: { "h:443": { Handlers: [] } } },
      { AllowFunnel: { "h:443": true }, TCP: { "443": "x" } },
    ])
      expect(funnelExposure(bad, mine).ok).toBe(false);
  });
});

describe("dashboard.socket in the machine file", () => {
  const parse = (dashboard: string) =>
    parseMachineConfigText(
      `accounts: []\ndashboard:\n${dashboard}\n`,
      "/fixture/machine.yaml",
    );
  const listen = "  listen: 127.0.0.1:8765";

  it("reads an absolute path beside dashboard.listen", () => {
    const parsed = parse(`${listen}\n  socket: /run/user/1000/d.sock`);
    expect(parsed).toMatchObject({
      ok: true,
      value: { dashboardSocket: "/run/user/1000/d.sock" },
    });
    expect(parse(listen)).toMatchObject({
      ok: true,
      value: { dashboardSocket: null },
    });
  });

  it("refuses a relative path, a long one, a non-text value and a socket with no listen", () => {
    for (const socket of ["d.sock", `/${"a".repeat(120)}`, "[1]", "42"]) {
      const parsed = parse(`${listen}\n  socket: ${socket}`);
      expect(parsed.ok).toBe(false);
    }
    const alone = parse("  socket: /run/user/1000/d.sock");
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.failure.reason).toContain("dashboard.listen");
  });

  it("changes the reader's settings only when a socket is set or changed", () => {
    const base = readerSettings({ host: "127.0.0.1", port: 8765 }, true, []);
    expect(
      readerSettings({ host: "127.0.0.1", port: 8765 }, true, [], null),
    ).toBe(base);
    const withSocket = readerSettings(
      { host: "127.0.0.1", port: 8765 },
      true,
      [],
      "/a.sock",
    );
    expect(withSocket).not.toBe(base);
    expect(
      readerSettings({ host: "127.0.0.1", port: 8765 }, true, [], "/b.sock"),
    ).not.toBe(withSocket);
  });
});
