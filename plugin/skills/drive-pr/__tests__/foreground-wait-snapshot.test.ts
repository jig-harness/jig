import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { hostEnv } from "../../../../lib/test-helpers/host-env.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processTable } from "../../../shared/process-table.ts";
import {
  captureProcessTree,
  signalIdentityTargets,
} from "../../../shared/process-tree.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import {
  awaitObserved,
  capturedCommand,
  capturedRunner,
  installSnapshotFailureFixture,
} from "./foreground-wait-observation.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/foreground-wait.ts");
const T = 60_000;
const PACING = {
  DRIVE_PR_FOREGROUND_WAIT_POLL_MS: "100",
  DRIVE_PR_FOREGROUND_WAIT_TRACK_MS: "200",
  DRIVE_PR_FOREGROUND_WAIT_KILL_GRACE_MS: "1000",
};
const busy = "setInterval(() => {}, 1000)";
const bunCommand = (source: string) => [process.execPath, "-e", source];
const childTree = (source: string) =>
  `Bun.spawn([process.execPath, '-e', ${JSON.stringify(source)}], {stdout:'ignore',stderr:'ignore'}); ${busy}`;

describe("foreground-wait snapshot recovery", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fgwait-snapshot-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const latestGen = () => join(cwd, ".context", "foreground-wait", "gen-1");
  const pidOf = (name: string): number | null => {
    const file = join(latestGen(), name);
    return existsSync(file)
      ? Number.parseInt(readFileSync(file, "utf8"), 10)
      : null;
  };
  const alive = async (pid: number): Promise<boolean> =>
    (await processTable())?.some(
      (row) => row.pid === pid && !row.stat.startsWith("Z"),
    ) ?? true;
  const run = (env: Record<string, string>, ...args: string[]) =>
    Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd,
      stderr: "pipe",
      env: { ...hostEnv, ...PACING, ...env },
    });

  test(
    "a descendant recovered after a failed process snapshot receives its cancellation grace",
    async () => {
      const {
        broken,
        captured,
        deadlineGate,
        flag,
        nativeFailure,
        path,
        restored,
      } = installSnapshotFailureFixture(cwd);
      let descendant: number | null = null;
      let runner: number | null = null;
      let cleanupTargets: { pid: number; start: string }[] = [];
      try {
        expectSpawnExit(
          run(
            {
              NODE_ENV: "test",
              DRIVE_PR_FOREGROUND_WAIT_CAPTURE_ACK: captured,
              DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "3",
              DRIVE_PR_FOREGROUND_WAIT_DEADLINE_GATE: deadlineGate,
              PATH: path,
            },
            "launch",
            "--",
            ...bunCommand(
              childTree(
                `process.on("SIGTERM",()=>{require("node:fs").writeFileSync("termed.marker","term");process.exit(0)});require("node:fs").writeFileSync("descendant.pid",String(process.pid));${busy}`,
              ),
            ),
          ),
          0,
        );
        await awaitObserved(
          "the runner recorded its command",
          () => pidOf("cmd.pid") !== null,
        );
        const command = pidOf("cmd.pid") as number;
        runner = pidOf("runner.pid") as number;
        cleanupTargets = await capturedRunner(runner, [command]);
        await awaitObserved("the descendant announced itself", () =>
          existsSync(join(cwd, "descendant.pid")),
        );
        descendant = Number.parseInt(
          readFileSync(join(cwd, "descendant.pid"), "utf8"),
          10,
        );
        cleanupTargets = await capturedRunner(runner, [command, descendant]);
        await capturedCommand(captured, [command, descendant]);
        rmSync(restored, { force: true });
        writeFileSync(flag, "");
        writeFileSync(deadlineGate, "");
        await awaitObserved(
          "the process snapshot failed after the deadline began",
          () => existsSync(broken),
        );
        await awaitObserved(
          "the deadline ended the command while snapshots failed",
          () => alive(command).then((isAlive) => !isAlive),
        );
        writeFileSync(nativeFailure, "");
        rmSync(flag);
        await Bun.sleep(200);
        expect(existsSync(restored)).toBe(false);
        rmSync(nativeFailure);
        await awaitObserved("the process snapshot recovered", () =>
          existsSync(restored),
        );
        const cancellationEvidence = byPlatform(
          "Windows has no cooperative POSIX TERM handler",
          { windows: restored, posix: join(cwd, "termed.marker") },
        );
        await awaitObserved("the recovered descendant was cancelled", () =>
          existsSync(cancellationEvidence),
        );
        expectSpawnExit(run({}, "wait", "--max-sec", "40"), 30);
        expect(await alive(descendant)).toBe(false);
        expect(
          JSON.parse(readFileSync(join(latestGen(), "result.json"), "utf8"))
            .treeWitnessed,
        ).toBe(
          byPlatform(
            "Windows cannot witness descendants after its unresolved-child fallback",
            { windows: "false", posix: "true" },
          ) === "true",
        );
      } finally {
        rmSync(flag, { force: true });
        rmSync(nativeFailure, { force: true });
        if (runner !== null) {
          const liveTargets = await captureProcessTree(runner);
          if (liveTargets !== null) cleanupTargets = liveTargets;
        }
        await signalIdentityTargets(cleanupTargets, "SIGKILL");
      }
    },
    T,
  );
});
