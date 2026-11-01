/**
 * dispatch: the wrapper's claim, the walls' monotonic reset, and the
 * timer's install preview.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { jobFiles } from "../../gc/scheduler.ts";
import { dispatchJobSpec } from "../install.ts";
import { wallOf, writeWall } from "../lib/walls.ts";
import { type World, world } from "./fixtures.ts";
import {
  account,
  claimed,
  driveRuns,
  earlierRecord,
  machineFile,
} from "./launch-fixtures.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

async function runWrapper(w: World, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", `--config=${BUNFIG}`, RUN_TS, ...args],
    { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("the wrapper", () => {
  it("refuses a record another wrapper already claimed, and starts nothing", async () => {
    const w = world();
    current = w;
    const id = "20261031T080000Z-cccccccc";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    claimed(w, id, {
      host: "elsewhere",
      bootId: "",
      pid: 4242,
      start: "x",
      claimedAt: "2026-10-31T08:00:00.000Z",
    });
    const r = await runWrapper(w, [id, "the-token"]);
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain(`${id} is already claimed; nothing started`);
    expect(driveRuns(w)).toEqual([]);
  });

  it("refuses a token that is not the record's", async () => {
    const w = world();
    current = w;
    const id = "20261031T080000Z-dddddddd";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    const r = await runWrapper(w, [id, "another-token"]);
    expectSpawnExit(r, 2);
    expect(driveRuns(w)).toEqual([]);
  });
});

describe("walls", () => {
  it("never move a reset earlier, whatever order the writes come in", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-walls-"));
    const now = Date.parse("2026-10-31T09:00:00.000Z");
    writeWall(
      { account: "a", resetAt: "2026-10-31T10:00:00.000Z", source: "first" },
      root,
    );
    for (const [hour, source] of [
      ["11", "second"],
      ["15", "third"],
      ["12", "fourth"],
    ] as const)
      writeWall(
        { account: "a", resetAt: `2026-10-31T${hour}:00:00.000Z`, source },
        root,
      );
    expect(wallOf("a", now, root)?.resetAt).toBe("2026-10-31T15:00:00.000Z");
    expect(wallOf("b", now, root)).toBeNull();
    expect(
      wallOf("a", Date.parse("2026-10-31T15:00:00.000Z"), root),
    ).toBeNull();
  });
});

describe("jig dispatch install", () => {
  it("lets the last of a repeated --interval win", async () => {
    const w = world();
    current = w;
    machineFile(w, [account(w, "a", "a@example.com")]);
    const r = await w.dispatch([
      "install",
      "--interval",
      "5m",
      "--interval",
      "10m",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("every 10 minutes");
  });

  it("checks whole minutes on the interval that wins, not on each one given", async () => {
    const w = world();
    current = w;
    machineFile(w, [account(w, "a", "a@example.com")]);
    const kept = await w.dispatch([
      "install",
      "--interval",
      "90s",
      "--interval",
      "10m",
    ]);
    expectSpawnExit(kept, 0);
    expect(kept.stdout).toContain("every 10 minutes");
    const refused = await w.dispatch(["install", "--interval", "90s"]);
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("whole minutes");
  });

  it("previews the tick's job, every interval, and writes nothing without --yes", async () => {
    const w = world();
    current = w;
    machineFile(w, [account(w, "a", "a@example.com")]);
    const r = await w.dispatch(["install", "--interval", "10m"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toMatch(/jig[-.]dispatch/);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).toContain(
      "Preview only. Repeat with --yes to write the job.",
    );
    expect(
      existsSync(
        join(w.home, ".config", "systemd", "user", "jig-dispatch.timer"),
      ),
    ).toBe(false);
  });

  it("refuses --yes from a checkout, and without a machine file", async () => {
    const w = world();
    current = w;
    const none = await w.dispatch(["install", "--yes"]);
    expectSpawnExit(none, 2);
    expect(none.stderr).toContain("needs the machine file");
    machineFile(w, [account(w, "a", "a@example.com")]);
    const r = await w.dispatch(["install", "--yes"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("requires the installed plugin copy");
    expect(
      existsSync(
        join(w.home, ".config", "systemd", "user", "jig-dispatch.timer"),
      ),
    ).toBe(false);
  });

  it("writes an interval job on each scheduler", () => {
    const job = {
      command: ["bun", "jig.ts", "dispatch", "--apply"],
      env: {},
      hour: 0,
      spec: dispatchJobSpec(5),
    };
    expect(jobFiles("systemd", job)["jig-dispatch.timer"]).toContain(
      "OnUnitActiveSec=5min",
    );
    expect(jobFiles("launchd", job)["dev.jig.dispatch.plist"]).toContain(
      "<key>StartInterval</key><integer>300</integer>",
    );
    expect(jobFiles("cron", job).crontab).toMatch(
      /^\*\/5 \* \* \* \* .* # jig-dispatch\n$/,
    );
  });
});
