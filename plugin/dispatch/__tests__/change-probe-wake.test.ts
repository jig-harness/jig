/**
 * A real `jig dispatch probe --apply` against a stand-in `gh`: a new review
 * comment on a dispatched pull request runs that repository's tick, and only
 * its (`dispatch --apply --repo <path>`, here a stand-in that records its
 * arguments, named by `JIG_WAKE_COMMAND`), before the probe exits, with the
 * wake's log naming the probe as who asked; the next minute, with no change,
 * starts no tick. A forge that does not answer wakes nothing and exits 1.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { tickWakeDir } from "../lib/wake-tick.ts";

const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

/**
 * The stand-in `gh`: a checkout's repository by its directory, and the
 * probe's GraphQL call answered from `forge.json`, the `updated:>=` search
 * filtered by its time; fails every call while `down` exists.
 */
const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.PROBE_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/gh-calls.log", args[0] + " " + args[1] + "\\n");
if (fs.existsSync(F + "/down")) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
const forge = JSON.parse(fs.readFileSync(F + "/forge.json", "utf8"));
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] === "repo" && args[1] === "view")
  out({ nameWithOwner: forge.repos[process.cwd()], defaultBranchRef: { name: "main" } });
if (args[0] === "api" && args[1] === "graphql") {
  const value = (name) => args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
  const query = value("query");
  const data = { rateLimit: { cost: 1, remaining: 4999 } };
  const repos = (q) => [...q.matchAll(/repo:(\\S+)/g)].map((m) => m[1]);
  const node = (pr) => ({ number: pr.number, updatedAt: pr.updatedAt, repository: { nameWithOwner: pr.slug },
    commits: { nodes: [{ commit: { oid: pr.head, statusCheckRollup: { state: pr.checks } } }] } });
  const changed = value("changed");
  if (changed !== undefined) {
    const since = Date.parse(/updated:>=(\\S+)/.exec(changed)[1]);
    data.changed = { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: forge.prs.filter((pr) => repos(changed).includes(pr.slug) && Date.parse(pr.updatedAt) >= since).map(node) };
  }
  const open = value("open");
  if (open !== undefined)
    data.open = { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: forge.prs.filter((pr) => repos(open).includes(pr.slug) && pr.open).map(node) };
  for (const m of query.matchAll(/(r\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\)/g))
    data[m[1]] = { nameWithOwner: m[2] + "/" + m[3] };
  out({ data });
}
process.stderr.write("unhandled gh " + args.join(" ") + "\\n");
process.exit(1);
`;

interface Pr {
  slug: string;
  number: number;
  updatedAt: string;
  head: string;
  checks: string;
  open: boolean;
}

interface ProbeWorld {
  root: string;
  home: string;
  web: string;
  api: string;
  setPrs(prs: Pr[]): void;
  down(on: boolean): void;
  probe(): { exitCode: number | null; stdout: string; stderr: string };
  ticks(): string[][];
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function world(): ProbeWorld {
  const root = mkdtempSync(join(tmpdir(), "change-probe-wake-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const fake = join(root, "fake");
  const web = join(root, "web");
  const api = join(root, "api");
  for (const dir of [home, bin, fake, web, api, join(home, ".jig")])
    mkdirSync(dir, { recursive: true });
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  const log = join(root, "ticks.jsonl");
  const stub = join(root, "fake-tick.ts");
  writeFileSync(log, "");
  writeFileSync(
    stub,
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  writeFileSync(
    join(home, ".jig", "dispatch.yaml"),
    `repositories:\n  - path: ${web}\n    stages: [rearm]\n  - path: ${api}\n    stages: [rearm]\n`,
  );
  const repos = { [web]: "acme/web", [api]: "acme/api" };
  let prs: Pr[] = [];
  const write = () =>
    writeFileSync(join(fake, "forge.json"), JSON.stringify({ repos, prs }));
  write();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    JIG_HOME: join(home, ".jig"),
    JIG_USER_LAYER: "off",
    PROBE_FAKE_DIR: fake,
    JIG_WAKE_COMMAND: JSON.stringify([process.execPath, stub]),
  };
  for (const key of Object.keys(env))
    if (/^(?:GH_|GITHUB_|DRIVE_PR_)/.test(key)) delete env[key];
  return {
    root,
    home,
    web,
    api,
    setPrs: (next) => {
      prs = next;
      write();
    },
    down: (on) =>
      on
        ? writeFileSync(join(fake, "down"), "")
        : rmSync(join(fake, "down"), { force: true }),
    probe: () => {
      const r = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          JIG,
          "dispatch",
          "probe",
          "--apply",
        ],
        { cwd: home, env, timeout: 60_000, stdout: "pipe", stderr: "pipe" },
      );
      return {
        exitCode: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      };
    },
    ticks: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
  };
}

const HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString();
const pr = (slug: string, number: number, updatedAt: string): Pr => ({
  slug,
  number,
  updatedAt,
  head: "a".repeat(40),
  checks: "SUCCESS",
  open: true,
});

describe("jig dispatch probe --apply", () => {
  it("runs the tick of the repository a new review comment landed on, and none the next minute", () => {
    const w = world();
    w.setPrs([pr("acme/web", 12, HOUR_AGO()), pr("acme/api", 7, HOUR_AGO())]);
    const first = w.probe();
    expectSpawnExit(first, 0);
    expect(first.stdout).toContain("no change: nothing woken");
    expect(w.ticks()).toEqual([]);

    // A person reviews acme/web#12.
    const reviewed = new Date().toISOString();
    w.setPrs([pr("acme/web", 12, reviewed), pr("acme/api", 7, HOUR_AGO())]);
    const next = w.probe();
    expectSpawnExit(next, 0);
    expect(next.stdout).toContain(`acme/web: #12 updated ${reviewed}`);
    expect(w.ticks()).toEqual([["dispatch", "--apply", "--repo", w.web]]);
    const wakeLog = readFileSync(
      join(
        tickWakeDir(w.web, join(w.home, ".local", "state", "jig", "dispatch")),
        "last-run.log",
      ),
      "utf8",
    );
    expect(wakeLog).toContain(
      `taking 1 requests (probe: acme/web #12 updated ${reviewed})`,
    );

    const quiet = w.probe();
    expectSpawnExit(quiet, 0);
    expect(quiet.stdout).toContain("no change: nothing woken");
    expect(w.ticks()).toHaveLength(1);
  });

  it("wakes nothing and exits 1 when the forge does not answer", () => {
    const w = world();
    w.setPrs([pr("acme/web", 12, HOUR_AGO())]);
    expectSpawnExit(w.probe(), 0);
    w.down(true);
    w.setPrs([pr("acme/web", 12, new Date().toISOString())]);
    const r = w.probe();
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("the forge did not read, so nothing is woken");
    expect(w.ticks()).toEqual([]);
    expect(
      existsSync(
        join(
          w.home,
          ".local",
          "state",
          "jig",
          "dispatch",
          "probe",
          "state.json",
        ),
      ),
    ).toBe(true);
  });
});
