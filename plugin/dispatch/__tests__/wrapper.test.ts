/**
 * dispatch: the wrapper's claim, the walls' monotonic reset, and the
 * timer's install preview.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { jobFiles } from "../../runtime/scheduler.ts";
import { dispatchJobSpec } from "../install.ts";
import type { LaunchRecord } from "../lib/launches.ts";
import { stateDb } from "../lib/state.ts";
import { wallOf, writeWall } from "../lib/walls.ts";
import { type World, world } from "./fixtures.ts";
import {
  account,
  claimed,
  driveRuns,
  dispatchState,
  earlierRecord,
  machineFile,
} from "./launch-fixtures.ts";

/** The preview's cadence in whichever scheduler's own form it was rendered: systemd, launchd or cron. */
const cadence = (minutes: number) =>
  new RegExp(
    `OnUnitActiveSec=${minutes}min|StartInterval</key><integer>${minutes * 60}<|\\*/${minutes} \\* \\* \\* \\*`,
  );
const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

async function runWrapper(w: World, args: string[], onStderr?: () => void) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", `--config=${BUNFIG}`, RUN_TS, ...args],
    { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(
      child.stderr.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            onStderr?.();
            controller.enqueue(chunk);
          },
        }),
      ),
    ).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("the wrapper", () => {
  it("keeps later stdout after older stderr when the combined output exceeds its bound", async () => {
    const w = world();
    current = w;
    const id = "20261031T080000Z-abcdef14";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    writeFileSync(join(w.dir, "drive-stderr"), "old stderr\n".repeat(1000));
    writeFileSync(join(w.dir, "drive-hold"), "");
    writeFileSync(
      join(w.dir, "drive-output"),
      "newest stdout: digest read failed",
    );
    expectSpawnExit(
      await runWrapper(w, [id, "the-token"], () =>
        rmSync(join(w.dir, "drive-hold"), { force: true }),
      ),
      0,
    );
    const row = stateDb(dispatchState(w))
      .query("SELECT exit FROM launches WHERE id = ?")
      .get(id) as { exit: string };
    expect(JSON.parse(row.exit).context).toEndWith(
      "newest stdout: digest read failed",
    );
  });

  it("keeps a CI-stopped drive's output for the steward", async () => {
    const w = world();
    current = w;
    const id = "20261031T080000Z-abcdef13";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    writeFileSync(
      join(w.dir, "drive-output"),
      "CI-repair passes spent; inspect failing check",
    );
    writeFileSync(join(w.dir, "drive-exit"), "21");
    expectSpawnExit(await runWrapper(w, [id, "the-token"]), 21);
    const row = stateDb(dispatchState(w))
      .query("SELECT exit FROM launches WHERE id = ?")
      .get(id) as { exit: string };
    expect(JSON.parse(row.exit).context).toContain(
      "CI-repair passes spent; inspect failing check",
    );
  });

  it("retains a steward's output when it exits zero without a question or submission", async () => {
    const w = world();
    current = w;
    const id = "20261031T080000Z-abcdef12";
    earlierRecord(w, {
      id,
      account: "a",
      token: "the-token",
      action: "steward",
      headless: true,
      pr: null,
    });
    writeFileSync(
      join(w.dir, "claude-said"),
      "Cannot read digest; token=the-token",
    );
    writeFileSync(join(w.dir, "claude-exit"), "0");
    expectSpawnExit(await runWrapper(w, [id, "the-token"]), 0);
    const row = stateDb(dispatchState(w))
      .query("SELECT exit, result FROM launches WHERE id = ?")
      .get(id) as { exit: string; result: string | null };
    expect(row.result).toBeNull();
    const exit = JSON.parse(row.exit);
    expect(exit.context).toContain("Cannot read digest; token=[launch token]");
    expect(exit.context.length).toBeLessThanOrEqual(8000);
    expect(exit.said).toBeUndefined();
  });

  it("refuses a record another wrapper already claimed, and starts nothing", async () => {
    const w = world();
    current = w;
    const id = "20261031T080000Z-cccccccc";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    claimed(w, id, {
      hostId: "",
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

  describe("a Codex drive's bypass", () => {
    const BYPASS = "--dangerously-bypass-approvals-and-sandbox";

    /** Runs a Codex drive's record under `fields`, in `env`, and returns the pass command the wrapper started. */
    async function passOf(
      fields: Partial<LaunchRecord>,
      env: Record<string, string>,
    ): Promise<string[]> {
      const w = world();
      current = w;
      const id = "20261031T080000Z-eeeeeeee";
      earlierRecord(w, {
        id,
        account: "c",
        token: "the-token",
        vendor: "codex",
        ...fields,
      });
      w.env = { ...w.env, ...env };
      const r = await runWrapper(w, [id, "the-token"]);
      expectSpawnExit(r, 0);
      const [run] = driveRuns(w);
      return (run?.argv ?? []).slice((run?.argv ?? []).indexOf("--") + 1);
    }

    it("follows what the tick admitted it under, on a wrapper that reads no such setting", async () => {
      const pass = await passOf(
        { codexBypass: true },
        { JIG_HOME: "/nonexistent-jig-home" },
      );
      expect(pass).toEqual([
        "codex",
        "exec",
        BYPASS,
        "Use the jig:drive-pr skill: /jig:drive-pr --bots-only 7",
      ]);
    });

    it.each([
      ["says no", { codexBypass: false }],
      ["was written before it kept this", {}],
    ])(
      "adds nothing for a record that %s, whatever the wrapper's environment sets",
      async (_, fields) => {
        const pass = await passOf(fields, {
          JIG__DRIVE__CODEX_BYPASS: "true",
        });
        expect(pass).toEqual([
          "codex",
          "exec",
          "Use the jig:drive-pr skill: /jig:drive-pr --bots-only 7",
        ]);
      },
    );
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
    expect(r.stdout).toMatch(cadence(10));
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
    expect(kept.stdout).toMatch(cadence(10));
    const refused = await w.dispatch(["install", "--interval", "90s"]);
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("whole minutes");
    expect(refused.stderr).toContain("Usage:");
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
      "Preview only. Repeat with --yes to write the jobs.",
    );
    expect(
      existsSync(
        join(w.home, ".config", "systemd", "user", "jig-dispatch.timer"),
      ),
    ).toBe(false);
  });

  it("previews the change probe's job beside the tick's, and its removal when the machine file turns it off", async () => {
    const w = world();
    current = w;
    machineFile(w, [account(w, "a", "a@example.com")]);
    const on = await w.dispatch(["install"]);
    expectSpawnExit(on, 0);
    expect(on.stdout).toMatch(/jig[-.]dispatch[-.]probe/);
    expect(on.stdout).toMatch(cadence(1));
    expect(on.stdout).toContain("probe");
    machineFile(w, [account(w, "a", "a@example.com")], { change_probe: false });
    const off = await w.dispatch(["install"]);
    expectSpawnExit(off, 0);
    expect(off.stdout).toContain("the jig-dispatch-probe job is removed");
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
