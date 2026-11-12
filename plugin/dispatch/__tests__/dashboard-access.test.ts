import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { ownIdentity } from "../../shared/liveness.ts";
import { failed, ok } from "../../shared/outcome.ts";
import { type AccessTerminal, accessReport } from "../dashboard-access.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { decodeModules, parseDrawn } from "./qr-oracle.ts";

const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const FRONT = "https://host.tailnet.ts.net:8443/";
const TOKEN_URL = "http://100.64.0.7:8765/?token=0123456789abcdef";
const MACHINE_PATH = "/home/person/.jig/dispatch.yaml";
const TTY: AccessTerminal = { isTTY: true, term: "xterm-256color" };
const PIPE: AccessTerminal = { isTTY: false, term: "xterm-256color" };
const GLYPHS = /^[█▀▄ ]+$/;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const TOKENLESS =
  "dashboard:\n  listen: 127.0.0.1:8765\n  require_token: false\n";

function machine(yaml: string) {
  return parseMachineConfigText(yaml, MACHINE_PATH);
}

function frontOf(front: string, base = TOKENLESS) {
  const read = machine(`${base}  front: ${JSON.stringify(front)}\n`);
  return read.ok ? read.value.dashboardFront : read.failure.reason;
}

/** The address a drawn code decodes to, read by an independent decoder. */
function decodeDrawn(lines: string[]): string | undefined {
  const grid = parseDrawn(lines);
  return grid === null ? undefined : decodeModules(grid, 0)?.data;
}

describe("dashboard.front in the machine file", () => {
  it("is null unless the file names one", () => {
    const read = machine(TOKENLESS);
    expect(read.ok && read.value.dashboardFront).toBeNull();
  });

  it("keeps an https: address with a name or a private address, in its canonical form", () => {
    expect(frontOf("https://Host.Tailnet.ts.net:8443")).toBe(FRONT);
    expect(frontOf("https://jig.example.net/dashboard/")).toBe(
      "https://jig.example.net/dashboard/",
    );
    expect(frontOf("https://100.64.0.7:8443/")).toBe(
      "https://100.64.0.7:8443/",
    );
    expect(frontOf("https://[fd7a:115c::1]:8443/")).toBe(
      "https://[fd7a:115c::1]:8443/",
    );
  });

  it("refuses an address that is not https:, or that could carry a credential", () => {
    const refusals: Array<[string, string]> = [
      ["host.tailnet.ts.net:8443", "is not an https: address"],
      ["not a url", "is not an absolute URL"],
      ["http://host.tailnet.ts.net:8443/", "is not an https: address"],
      ["https://me:secret@host.tailnet.ts.net/", "carries a user or password"],
      ["https://me@host.tailnet.ts.net/", "carries a user or password"],
      ["https://host.tailnet.ts.net/?token=abc", "carries a query"],
      ["https://host.tailnet.ts.net/?", "carries a query"],
      ["https://host.tailnet.ts.net/#token=abc", "carries a fragment"],
      ["https://host.tailnet.ts.net/#", "carries a fragment"],
    ];
    for (const [front, reason] of refusals) {
      const refused = frontOf(front);
      expect(refused).toContain(`dashboard.front: ${front} ${reason}`);
    }
  });

  it("refuses a loopback or public address, and takes a name as written", () => {
    for (const front of [
      "https://127.0.0.1:8443/",
      "https://[::1]:8443/",
      "https://localhost:8443/",
      "https://app.localhost/",
      "https://8.8.8.8/",
      "https://[2001:db8::1]/",
    ])
      expect(frontOf(front)).toContain("names no host a phone reaches");
    expect(frontOf("https://dashboard.example.com/")).toBe(
      "https://dashboard.example.com/",
    );
  });

  it("needs require_token: false, since only a tokenless dashboard answers a front", () => {
    expect(frontOf(FRONT, "dashboard:\n  listen: 127.0.0.1:8765\n")).toContain(
      "needs dashboard.require_token: false",
    );
    expect(
      frontOf(
        FRONT,
        "dashboard:\n  listen: 127.0.0.1:8765\n  require_token: true\n",
      ),
    ).toContain("needs dashboard.require_token: false");
  });
});

describe("what --access prints", () => {
  const withFront = machine(
    `${TOKENLESS}  front: ${FRONT}\n  allowed_hosts: [host.tailnet.ts.net]\n`,
  );
  const reader = ok({ url: TOKEN_URL });
  const noReader = failed(
    "unavailable",
    "no readable live dashboard access record; inspect --status",
  );

  it("prints the front's address, then its code and what the code holds, on a terminal", () => {
    const report = accessReport(withFront, reader, TTY, MACHINE_PATH);
    expect(report.code).toBe(0);
    expect(report.stderr).toEqual([]);
    expect(report.stdout[0]).toBe(FRONT);
    const drawn = report.stdout.slice(1, -1);
    expect(drawn.length).toBeGreaterThan(10);
    for (const line of drawn) expect(line).toMatch(GLYPHS);
    expect(decodeDrawn(drawn)).toBe(FRONT);
    expect(report.stdout.at(-1)).toBe(
      "The code holds only this address; the front still signs the viewer in.",
    );
    expect(JSON.stringify(report)).not.toContain("token=");
  });

  it("prints the address alone where the output is not a terminal, or the terminal is dumb", () => {
    for (const terminal of [PIPE, { isTTY: true, term: "dumb" }]) {
      const report = accessReport(withFront, reader, terminal, MACHINE_PATH);
      expect(report).toEqual({ stdout: [FRONT], stderr: [], code: 0 });
    }
  });

  it("prints the front's address without a reader, and says where to check it", () => {
    const report = accessReport(withFront, noReader, PIPE, MACHINE_PATH);
    expect(report.stdout).toEqual([FRONT]);
    expect(report.code).toBe(0);
    expect(report.stderr).toHaveLength(1);
    expect(report.stderr[0]).toContain("jig dispatch dashboard --status");
  });

  it("without a front, prints the reader's URL as before, says why, and draws no code", () => {
    const tokens = machine("dashboard:\n  listen: 100.64.0.7:8765\n");
    for (const read of [tokens, ok(null)]) {
      const report = accessReport(read, reader, TTY, MACHINE_PATH);
      expect(report.stdout).toEqual([TOKEN_URL]);
      expect(report.code).toBe(0);
      const said = report.stderr.join("\n");
      expect(said).toContain("private-HTTP fallback");
      expect(said).toContain("credential");
      expect(said).toContain("No QR code is drawn");
      expect(said).toContain(`dashboard.front in ${MACHINE_PATH}`);
      expect(said).toContain("phone-access.md");
      expect(said).not.toMatch(/[█▀▄]/);
    }
  });

  it("without a front or a reader, fails as before and still says how to get a phone address", () => {
    const report = accessReport(ok(null), noReader, TTY, MACHINE_PATH);
    expect(report.stdout).toEqual([]);
    expect(report.code).toBe(1);
    expect(report.stderr[0]).toBe(noReader.failure.reason);
    expect(report.stderr.join("\n")).toContain("dashboard.front");
    expect(report.stderr.join("\n")).not.toContain("private-HTTP fallback");
  });

  it("on a tokenless dashboard without a front, says the loopback address is this host's alone", () => {
    const loopback = ok({ url: "http://127.0.0.1:8765/" });
    const report = accessReport(
      machine(TOKENLESS),
      loopback,
      TTY,
      MACHINE_PATH,
    );
    expect(report.stdout).toEqual(["http://127.0.0.1:8765/"]);
    expect(report.stderr.join("\n")).toContain("on this host only");
    expect(report.stderr.join("\n")).toContain("dashboard.front");
    expect(report.stderr.join("\n")).not.toContain("credential");
  });

  it("with a machine file that does not validate, prints the reader's URL as before and why the file is refused", () => {
    const invalid = machine("dashboard:\n  listen: 8.8.8.8:8765\n");
    const report = accessReport(invalid, reader, TTY, MACHINE_PATH);
    expect(report.stdout).toEqual([TOKEN_URL]);
    expect(report.stderr).toEqual([invalid.ok ? "" : invalid.failure.reason]);
  });
});

/** A home with a machine file, and an access record when given a URL, as the installed reader writes it. */
function home(machineFile: string, readerUrl?: string) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-access-"));
  roots.push(root);
  mkdirSync(join(root, ".jig"));
  writeFileSync(join(root, ".jig", "dispatch.yaml"), machineFile);
  if (readerUrl !== undefined) {
    const reader = join(root, ".local/state/jig/dispatch/dashboard");
    mkdirSync(reader, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(reader, "access.json"),
      JSON.stringify({
        url: readerUrl,
        configuration: "fixture",
        identity: ownIdentity(),
      }),
      { mode: 0o600 },
    );
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !key.startsWith("JIG_") &&
      !key.startsWith("DRIVE_PR_")
    )
      environment[key] = value;
  return {
    root,
    env: {
      ...environment,
      HOME: root,
      USERPROFILE: root,
      JIG_HOME: join(root, ".jig"),
      TERM: "xterm-256color",
    },
  };
}

const ACCESS = [
  process.execPath,
  "--no-env-file",
  `--config=${BUNFIG}`,
  JIG,
  "dispatch",
  "dashboard",
  "--access",
];

describe.skipIf(
  skipsOnWindows("file-system", "the access record is an owner-only file"),
)("jig dispatch dashboard --access", () => {
  it("prints the front's address alone into a pipe, and never the reader's token", () => {
    const h = home(`${TOKENLESS}  front: ${FRONT}\n`, TOKEN_URL);
    const result = Bun.spawnSync(ACCESS, {
      cwd: h.root,
      env: h.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toBe(`${FRONT}\n`);
    expect(result.stderr.toString()).not.toContain("token=");
  });

  it("without a front, prints the reader's URL as before, with why it draws no code", () => {
    const h = home("dashboard:\n  listen: 100.64.0.7:8765\n", TOKEN_URL);
    const result = Bun.spawnSync(ACCESS, {
      cwd: h.root,
      env: h.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toBe(`${TOKEN_URL}\n`);
    expect(result.stderr.toString()).toContain("No QR code is drawn");
    expect(result.stderr.toString()).toContain("dashboard.front");
  });

  it("draws a code of the front's address on a terminal", async () => {
    const h = home(`${TOKENLESS}  front: ${FRONT}\n`);
    let output = "";
    const decoder = new TextDecoder();
    let closed = (): void => undefined;
    const eof = new Promise<void>((settle) => {
      closed = settle;
    });
    const child = Bun.spawn(ACCESS, {
      cwd: h.root,
      env: h.env,
      terminal: {
        cols: 200,
        rows: 100,
        data: (_terminal, chunk) => {
          output += decoder.decode(chunk, { stream: true });
        },
        exit: () => closed(),
      },
    });
    // The terminal's end of output, or a deadline that ends a stuck child.
    const deadline = setTimeout(() => {
      child.kill();
      closed();
    }, 30_000);
    try {
      const exitCode = await child.exited;
      await eof;
      expectSpawnExit({ exitCode, stdout: output, stderr: null }, 0);
    } finally {
      clearTimeout(deadline);
      child.terminal?.close();
    }
    const lines = output.split(/\r?\n/);
    expect(lines[0]).toBe(FRONT);
    const drawn = lines.filter((line) => GLYPHS.test(line));
    expect(decodeDrawn(drawn)).toBe(FRONT);
    expect(output).toContain("the front still signs the viewer in");
    expect(output).toContain("jig dispatch dashboard --status");
  }, 60_000);
});
