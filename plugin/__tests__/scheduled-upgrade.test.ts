/**
 * The timers keep the plugin current, end to end: an installed job run as
 * its scheduler starts it (`lifecycle-fixtures.ts`, `runJob`), whose
 * launcher runs the installed copy's `jig upgrade --scheduled` first, with
 * fake agent tools whose channel offers the next release (`agent-fakes.ts`).
 * What the upgrade did is read back from the job's receipt, the agent tools'
 * log, the stamp, `jig doctor` and the morning report's upgrades.
 */
import { expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../lib/test-helpers/windows-skip.ts";
import { readReceipt, receiptPaths } from "../gc/receipts.ts";
import type { Receipt } from "../gc/types.ts";
import type { ScheduledUpgrade } from "../runtime/upgrade-record.ts";
import { stampPath, upgradeStateRoot } from "../runtime/upgrade-stamp.ts";
import { withFileLock } from "../shared/file-lock.ts";
import { ownIdentity } from "../shared/liveness.ts";
import { upgradesSince } from "../skills/drive-pr/scripts/lib/morning-report-upgrades.ts";
import { dump, load } from "../shared/yaml.ts";
import { type Machine, machine, SCHEDULERS } from "./lifecycle-fixtures.ts";

const onWindows = skipsOnWindows(
  "powershell",
  "the platform schedulers the jobs are written for are launchd, systemd and cron",
);

/** A job runs the launcher, an upgrade and collection: longer than one command. */
const TIMEOUT = 120_000;

const jobsLog = (m: Machine) => join(m.root, "jobs.log");

/** Makes the plugin copy at `directory` log each job it runs to the machine's jobs log, as `<name> <arguments>`. */
function mark(m: Machine, directory: string, name: string): void {
  appendFileSync(
    join(directory, "jig.ts"),
    `\nif (["gc", "dispatch"].includes(process.argv[2] ?? "")) require("node:fs").appendFileSync(${JSON.stringify(jobsLog(m))}, ${JSON.stringify(`${name} `)} + process.argv.slice(2).join(" ") + "\\n");\n`,
  );
}

/** The jobs each copy ran, in order. */
function jobsRun(m: Machine): string[] {
  return existsSync(jobsLog(m))
    ? readFileSync(jobsLog(m), "utf8").split("\n").filter(Boolean)
    : [];
}

/** A copy of the installed plugin the channel offers next as `version`. */
function nextRelease(m: Machine, version: string, name: string): string {
  const directory = join(m.root, name);
  cpSync(m.plugin, directory, { recursive: true });
  m.release(version, directory);
  return directory;
}

/** Collection's machine policy with its weekday moved off today, so the job only reports. */
function reportOnly(m: Machine): void {
  const path = join(m.home, ".jig", "jig.yaml");
  const values = load(readFileSync(path, "utf8")) as {
    gc: Record<string, unknown>;
  };
  values.gc.collect_day = (new Date().getDay() + 1) % 7;
  writeFileSync(path, dump(values));
}

/** Installs collection's job and the jig command, collecting nothing today. */
function installed(m: Machine): void {
  expectSpawnExit(m.jig(["install", "gc", "--yes"]), 0);
  reportOnly(m);
}

const gcState = (m: Machine) => join(m.home, ".local", "state", "jig", "gc");

/** Collection's receipts, oldest first. */
function receipts(m: Machine): Receipt[] {
  return receiptPaths(gcState(m)).map(readReceipt);
}

/** The scheduled upgrade the newest receipt carries. */
function lastUpgrade(m: Machine): ScheduledUpgrade | undefined {
  return receipts(m).at(-1)?.upgrade;
}

/** The commands that change what an agent tool has installed. */
function updates(m: Machine): string[] {
  return m
    .agentCalls()
    .filter((call) =>
      /plugin (marketplace update|update|marketplace upgrade|add) /.test(call),
    );
}

const stampFile = (m: Machine) =>
  join(m.home, ".local", "state", "jig", "upgrade", "last.json");

/** How many times an agent tool was asked for its plugins. */
function lists(m: Machine): number {
  return m.agentCalls().filter((call) => call.endsWith("plugin list --json"))
    .length;
}

/** Writes the latest attempt's stamp as `fields` say. */
function stamp(m: Machine, fields: Record<string, unknown>): void {
  mkdirSync(join(stampFile(m), ".."), { recursive: true });
  writeFileSync(
    stampFile(m),
    JSON.stringify({
      version: 1,
      outcome: "unchanged",
      detail: "claude at 0.2.0",
      at: new Date().toISOString(),
      pid: process.pid,
      ...fields,
    }),
  );
}

/** A process that has exited, for a stamp whose holder is gone. */
function exitedPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", "0"]);
  expectSpawnExit(child, 0);
  return child.pid;
}

/** Moves the latest attempt's stamp back by `ms`, as if that much time had passed. */
function age(m: Machine, ms: number): void {
  const stamp = JSON.parse(readFileSync(stampFile(m), "utf8"));
  stamp.at = new Date(Date.parse(stamp.at) - ms).toISOString();
  writeFileSync(stampFile(m), JSON.stringify(stamp));
}

test.skipIf(onWindows)(
  "two timers firing within one interval run the upgrade once, and the job after it runs the newly installed copy",
  async () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    const next = nextRelease(m, "0.3.0", "next-release");
    mark(m, m.plugin, "installed");
    mark(m, next, "next");

    const runs = await Promise.all([
      m.startJob("jig-gc"),
      m.startJob("jig-gc"),
    ]);
    for (const run of runs) expectSpawnExit(run, 0);
    expect(
      updates(m).filter((call) => call.startsWith("claude plugin update")),
    ).toHaveLength(1);
    const outcomes = receipts(m).map((receipt) => receipt.upgrade?.outcome);
    expect(outcomes.sort()).toEqual(["updated", "withheld"]);
    expect(
      receipts(m).find((receipt) => receipt.upgrade?.outcome === "updated")
        ?.upgrade,
    ).toMatchObject({ from: "0.2.0", to: "0.3.0" });
    expect(m.agents().claude.version).toBe("0.3.0");
    // The job that upgraded ran the copy the upgrade installed.
    expect(jobsRun(m)).toContain("next gc --scheduled");

    // A third firing inside the interval upgrades nothing and runs that copy,
    // asking the agent tool for it once: a withheld upgrade moved nothing.
    const listed = lists(m);
    const third = m.runJob("jig-gc");
    expectSpawnExit(third, 0);
    expect(lists(m)).toBe(listed + 1);
    expect(
      updates(m).filter((call) => call.startsWith("claude plugin update")),
    ).toHaveLength(1);
    expect(jobsRun(m).at(-1)).toBe("next gc --scheduled");
    expect(lastUpgrade(m)?.outcome).toBe("withheld");
    expect(lastUpgrade(m)?.detail).toContain("0.2.0 -> 0.3.0");
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a timer that finds another job claiming the interval withholds its upgrade and still runs its job",
  async () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    mark(m, m.plugin, "installed");
    const root = upgradeStateRoot(m.home);
    // This test holds the claim, as a job between its read and its write of the stamp does.
    const held = await withFileLock(
      stampPath(root),
      () => m.startJob("jig-gc"),
      { root, name: "claim" },
    );
    expect(held).not.toBeNull();
    expectSpawnExit(held?.value as Awaited<ReturnType<Machine["startJob"]>>, 0);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)).toMatchObject({
      outcome: "withheld",
      detail: "another job is claiming this interval's upgrade",
    });
    expect(jobsRun(m)).toEqual(["installed gc --scheduled"]);
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a successful and a failed upgrade each reach the job's receipt and the morning report; the failure is withheld for the rest of the interval while the job runs on the copy there, and jig doctor names only the failed one",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    const started = Date.now();
    const next = nextRelease(m, "0.3.0", "next-release");
    mark(m, next, "next");
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)).toMatchObject({
      outcome: "updated",
      from: "0.2.0",
      to: "0.3.0",
    });
    const healthy = m.jig(["doctor", "--json"]);
    const checks = JSON.parse(healthy.stdout.toString()).checks as {
      id: string;
      status: string;
      detail: string;
    }[];
    expect(checks.find((check) => check.id === "upgrade")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("0.2.0 -> 0.3.0"),
    });

    // An hour later the channel offers another release, and the fetch fails.
    age(m, 2 * 3_600_000);
    nextRelease(m, "0.4.0", "release-0.4.0");
    m.agentState((state) => {
      state.claude.fail =
        "fatal: unable to access the marketplace: network down";
    });
    const failed = m.runJob("jig-gc");
    expectSpawnExit(failed, 0);
    expect(lastUpgrade(m)?.outcome).toBe("failed");
    expect(lastUpgrade(m)?.detail).toContain(
      "fatal: unable to access the marketplace: network down",
    );
    expect(receipts(m).at(-1)?.completed).toBe(true);
    // The job still ran, on the copy that is installed.
    expect(jobsRun(m).at(-1)).toBe("next gc --scheduled");
    expect(m.agents().claude.version).toBe("0.3.0");

    // Within the interval the failure is not tried again.
    const tried = updates(m).length;
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(updates(m)).toHaveLength(tried);
    expect(lastUpgrade(m)?.outcome).toBe("withheld");
    expect(lastUpgrade(m)?.detail).toContain("network down");

    const doctor = m.jig(["doctor"]);
    expectSpawnExit(doctor, 1);
    const out = doctor.stdout.toString();
    expect(out).toMatch(
      /FAIL {2}upgrade: the scheduled upgrade at \S+ failed: .*network down/,
    );
    expect(out).not.toContain("0.2.0 -> 0.3.0");
    expect(out).toContain("Failing: upgrade.");

    // The fix doctor names: a jig upgrade a person runs stamps the interval, and the failure clears.
    m.agentState((state) => {
      delete state.claude.fail;
    });
    expectSpawnExit(m.jig(["upgrade"]), 0);
    const cleared = m.jig(["doctor", "--json"]);
    expect(
      (
        JSON.parse(cleared.stdout.toString()).checks as {
          id: string;
          status: string;
          detail: string;
        }[]
      ).find((check) => check.id === "upgrade"),
    ).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(
        /^the latest upgrade, at \S+: 0\.3\.0 -> 0\.4\.0$/,
      ),
    });

    const report = upgradesSince(started, { gc: gcState(m) });
    expect(report.unread).toEqual([]);
    expect(report.entries.map((entry) => entry.outcome)).toEqual([
      "updated",
      "failed",
    ]);
    expect(report.entries[0]?.line).toBe("0.2.0 -> 0.3.0");
    expect(report.entries[1]?.line).toContain("network down");
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a pinned machine runs no upgrade, and the receipt says why",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    m.agentState((state) => {
      state.claude.marketplace = {
        name: "jig",
        source: "git",
        url: "https://github.com/jig-harness/jig.git",
        ref: "v0.2.0",
      };
    });
    writeFileSync(
      join(m.home, ".codex", "config.toml"),
      '[marketplaces.jig]\nsource_type = "git"\nsource = "https://github.com/jig-harness/jig.git"\nref = "v0.2.0"\n',
    );
    mark(m, m.plugin, "installed");
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)).toMatchObject({
      outcome: "withheld",
      detail: expect.stringContaining("v0.2.0, pinned"),
    });
    expect(jobsRun(m)).toEqual(["installed gc --scheduled"]);
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a machine with upgrade: off, or one installed with --no-upgrade, runs no upgrade",
  () => {
    const off = machine(SCHEDULERS[0]);
    installed(off);
    nextRelease(off, "0.3.0", "next-release");
    const file = join(off.home, ".jig", "jig.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}upgrade: off\n`);
    expectSpawnExit(off.runJob("jig-gc"), 0);
    expect(updates(off)).toEqual([]);
    expect(lastUpgrade(off)).toMatchObject({
      outcome: "withheld",
      detail: `upgrade is off in ${file}`,
    });
    expect(existsSync(stampFile(off))).toBe(false);

    const opted = machine(SCHEDULERS[0]);
    expectSpawnExit(opted.jig(["install", "gc", "--no-upgrade"]), 0);
    expect(existsSync(join(opted.home, ".jig", "jig.yaml"))).toBe(false);
    const written = opted.jig(["install", "gc", "--no-upgrade", "--yes"]);
    expectSpawnExit(written, 0);
    expect(written.stdout.toString()).toContain("Wrote upgrade.enabled: false");
    expect(
      load(readFileSync(join(opted.home, ".jig", "jig.yaml"), "utf8")),
    ).toMatchObject({
      upgrade: { enabled: false },
      gc: { repositories: [{ path: opted.repo }] },
    });
    reportOnly(opted);
    nextRelease(opted, "0.3.0", "next-release");
    expectSpawnExit(opted.runJob("jig-gc"), 0);
    expect(updates(opted)).toEqual([]);
    expect(lastUpgrade(opted)?.outcome).toBe("withheld");
    const doctor = opted.jig(["doctor", "--json"]);
    expect(
      (
        JSON.parse(doctor.stdout.toString()).checks as {
          id: string;
          status: string;
        }[]
      ).find((check) => check.id === "upgrade")?.status,
    ).toBe("skip");
  },
  TIMEOUT,
);

/** Every file under `directory` with its size and modification time. */
function tree(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) walk(child);
      else entries[relative(directory, child)] = `${stat.size} ${stat.mtimeMs}`;
    }
  };
  walk(directory);
  return entries;
}

test.skipIf(onWindows)(
  "a scheduled run on a plugin loaded in place from a local marketplace leaves that folder untouched, records the skip in the receipt and runs the job",
  () => {
    const m = machine(SCHEDULERS[0]);
    const folder = join(m.root, "local-marketplace");
    cpSync(m.plugin, folder, { recursive: true });
    mark(m, folder, "folder");
    m.agentState((state) => {
      state.claude.readFromFolder = folder;
      state.claude.marketplace = {
        name: "jig",
        source: "directory",
        path: folder,
      };
      state.codex.marketplace = {
        name: "jig",
        marketplaceSource: { sourceType: "local", source: folder },
      };
    });
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    const before = tree(folder);

    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(tree(folder)).toEqual(before);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)).toMatchObject({
      outcome: "skipped",
      detail: expect.stringContaining(`loaded in place from ${folder}`),
    });
    expect(jobsRun(m)).toEqual(["folder gc --scheduled"]);
  },
  TIMEOUT,
);

test.skipIf(onWindows).each(["0.111.0", "0.156.0"])(
  "a job release %s installed, with that release's launcher copy, still runs, and the jig command never upgrades",
  (release) => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    mark(m, m.plugin, "installed");
    copyFileSync(
      join(import.meta.dir, "fixtures", `launcher-${release}.ts`),
      join(gcState(m), "launcher", "launcher.ts"),
    );
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(jobsRun(m)).toEqual(["installed gc --scheduled"]);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)).toBeUndefined();

    const command = Bun.spawnSync(
      [join(m.home, ".local", "bin", "jig"), "gc", "--scheduled"],
      {
        cwd: m.repo,
        env: m.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60000,
      },
    );
    expectSpawnExit(command, 0);
    expect(updates(m)).toEqual([]);
    expect(jobsRun(m).at(-1)).toBe("installed gc --scheduled");
    expect(lastUpgrade(m)).toBeUndefined();
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "jig upgrade --scheduled refuses the options that choose what to install, and the program options without it",
  () => {
    const m = machine(SCHEDULERS[0]);
    const refused = m.jig(["upgrade", "--scheduled", "--jobs-only"]);
    expectSpawnExit(refused, 2);
    expect(refused.stderr.toString()).toContain("--scheduled upgrades on");
    const loose = m.jig(["upgrade", "--claude-program=/bin/true"]);
    expectSpawnExit(loose, 2);
    expect(loose.stderr.toString()).toContain("go with --scheduled");
  },
);

test.skipIf(onWindows || SCHEDULERS[0] !== "launchd")(
  "a scheduled upgrade refreshes a loaded launchd job's launcher copy and leaves its job for the jig upgrade a person runs, since rewriting it would stop the run",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    const next = nextRelease(m, "0.3.0", "next-release");
    const launcher = join(next, "runtime", "launcher.ts");
    writeFileSync(
      launcher,
      `${readFileSync(launcher, "utf8")}// the next release\n`,
    );
    const scheduler = join(next, "runtime", "scheduler.ts");
    const source = readFileSync(scheduler, "utf8");
    const changed = source.replace(
      '    "--no-env-file",\n    `--config=',
      '    "--no-env-file",\n    "--smol",\n    `--config=',
    );
    expect(changed).not.toBe(source);
    writeFileSync(scheduler, changed);
    const before = m.jobText("jig-gc");

    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)).toMatchObject({ outcome: "updated" });
    expect(m.jobText("jig-gc")).toBe(before);
    expect(
      readFileSync(join(gcState(m), "launcher", "launcher.ts"), "utf8"),
    ).toBe(readFileSync(launcher, "utf8"));

    expectSpawnExit(m.jig(["upgrade"]), 0);
    expect(m.jobText("jig-gc")).toContain("<string>--smol</string>");
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "an agent tool that fails with a flood of output leaves a bounded line in the receipt, and every job of the interval still runs",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    mark(m, m.plugin, "installed");
    m.agentState((state) => {
      state.claude.fail = `${"x".repeat(250_000)} network down`;
    });
    expectSpawnExit(m.runJob("jig-gc"), 0);
    const failed = lastUpgrade(m);
    expect(failed?.outcome).toBe("failed");
    expect(failed?.detail).toContain("network down");
    expect(failed?.detail.length).toBeLessThan(4000);
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)?.outcome).toBe("withheld");
    expect(lastUpgrade(m)?.detail.length).toBeLessThan(4000);
    expect(jobsRun(m)).toEqual([
      "installed gc --scheduled",
      "installed gc --scheduled",
    ]);
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a running stamp withholds the upgrade while its holder lives, whatever its age; once its holder is gone it fails doctor and counts as a failed attempt, withheld for the rest of its interval",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    // This test's process, judged alive, holds it.
    stamp(m, {
      outcome: "running",
      detail: "a scheduled job started it",
      at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      holder: ownIdentity(),
    });
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)?.detail).toMatch(/started at \S+ is still running$/);

    // A holder named by its pid alone cannot be judged, and the line says so.
    stamp(m, {
      outcome: "running",
      detail: "a scheduled job started it",
      at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    });
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)?.detail).toContain(
      "is taken to be still running: its process cannot be judged",
    );

    stamp(m, {
      outcome: "running",
      detail: "a scheduled job started it",
      at: new Date(Date.now() - 60_000).toISOString(),
      pid: exitedPid(),
    });
    const doctor = m.jig(["doctor"]);
    expectSpawnExit(doctor, 1);
    expect(doctor.stdout.toString()).toMatch(
      /FAIL {2}upgrade: the scheduled upgrade started at \S+ did not finish: no process has pid \d+ now/,
    );
    // Killed at its deadline, say: not tried again inside the interval.
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(updates(m)).toEqual([]);
    expect(lastUpgrade(m)).toMatchObject({
      outcome: "withheld",
      detail: expect.stringMatching(
        /the upgrade started at \S+ did not finish \(no process has pid \d+ now\); the next is due at /,
      ),
    });

    // Once the interval has passed, it is due.
    stamp(m, {
      outcome: "running",
      detail: "a scheduled job started it",
      at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      pid: exitedPid(),
    });
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)).toMatchObject({ outcome: "updated", to: "0.3.0" });
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a stamp a little ahead of the clock withholds the upgrade, one more than an interval ahead does not",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    stamp(m, { at: new Date(Date.now() + 10 * 60_000).toISOString() });
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)?.outcome).toBe("withheld");
    expect(updates(m)).toEqual([]);
    stamp(m, { at: new Date(Date.now() + 3 * 3_600_000).toISOString() });
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)).toMatchObject({ outcome: "updated", to: "0.3.0" });
  },
  TIMEOUT,
);

test.skipIf(onWindows)(
  "a stamp that does not read fails doctor, naming it, and the next job upgrades and writes it again",
  () => {
    const m = machine(SCHEDULERS[0]);
    installed(m);
    nextRelease(m, "0.3.0", "next-release");
    mkdirSync(join(stampFile(m), ".."), { recursive: true });
    writeFileSync(stampFile(m), "not a stamp");
    const doctor = m.jig(["doctor"]);
    expectSpawnExit(doctor, 1);
    expect(doctor.stdout.toString()).toContain(
      `FAIL  upgrade: ${stampFile(m)} is not JSON`,
    );
    expectSpawnExit(m.runJob("jig-gc"), 0);
    expect(lastUpgrade(m)).toMatchObject({ outcome: "updated", to: "0.3.0" });
    expect(JSON.parse(readFileSync(stampFile(m), "utf8"))).toMatchObject({
      outcome: "updated",
      holder: expect.objectContaining({ pid: expect.any(Number) }),
    });
  },
  TIMEOUT,
);
