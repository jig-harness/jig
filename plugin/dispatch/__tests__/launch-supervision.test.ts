/** A real headless stage survives wrapper death only while its launch keeps the account slot. */
import { expect, it } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { judge, thisHost } from "../../shared/liveness.ts";
import { processTable } from "../../shared/process-table.ts";
import {
  holds,
  inspectRow,
  readLaunches,
  type LaunchClaim,
} from "../lib/launches.ts";
import { asClaim } from "../lib/launch-supervision.ts";
import { world } from "./fixtures.ts";
import { dispatchState, earlierRecord, waitFor } from "./launch-fixtures.ts";

/** Keep live diagnostics without waiting for a surviving descendant to close its pipe. */
function pipeTail(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  const append = (chunk: string) => {
    text = (text + chunk).slice(-8192);
  };
  const read = async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(decoder.decode(chunk.value, { stream: true }));
      }
      append(decoder.decode());
    } catch (error) {
      append(String(error));
    } finally {
      ended = true;
      reader.releaseLock();
    }
  };
  void read();
  return {
    get text() {
      return text;
    },
    async stop() {
      if (ended) return;
      void reader.cancel().catch((error) => append(String(error)));
      const until = performance.now() + 1000;
      while (!ended && performance.now() < until) await Bun.sleep(10);
    },
  };
}

it.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "SIGKILL of only the wrapper and POSIX parent death",
  ),
)(
  "retains the slot after SIGKILL of the wrapper and the surviving supervisor stops its stage",
  async () => {
    const w = world();
    const root = dispatchState(w);
    const record = earlierRecord(w, {
      id: "20261104T090000Z-bbbbbbbb",
      account: "a",
    });
    const stage = join(w.root, "stage.ts");
    const pidFile = join(w.root, "stage-pid");
    const billFile = join(w.root, "billed-pid");
    writeFileSync(
      stage,
      `const billed = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await Bun.write(${JSON.stringify(billFile)}, String(billed.pid)); await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        resolve(import.meta.dir, "../run.ts"),
        record.id,
        record.token,
      ],
      {
        env: { ...w.env, JIG_DISPATCH_DRIVE_SCRIPT: stage },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = pipeTail(child.stdout);
    const stderr = pipeTail(child.stderr);
    let billedPid: number | undefined;
    let stagePid: number | undefined;
    let supervisorPid: number | undefined;
    try {
      await waitFor("stage startup", () => existsSync(pidFile));
      stagePid = Number(readFileSync(pidFile, "utf8"));
      billedPid = Number(readFileSync(billFile, "utf8"));
      let claim: LaunchClaim | null = null;
      const until = performance.now() + 15000;
      while (performance.now() < until) {
        const row = await inspectRow(record.id, root);
        claim = row?.claim ? asClaim(JSON.parse(row.claim)) : null;
        if (
          claim?.supervision?.child !== null &&
          claim?.supervision?.supervisor
        )
          break;
        await Bun.sleep(20);
      }
      expect(claim?.supervision?.child?.pid).toBe(stagePid);
      supervisorPid = claim?.supervision?.supervisor?.pid;
      expect(supervisorPid).toBeGreaterThan(0);
      child.kill("SIGKILL");
      const code = await child.exited;
      expectSpawnExit(
        { exitCode: code, stdout: stdout.text, stderr: stderr.text },
        137,
      );
      const read = await readLaunches(root);
      expect(
        read.records[0] !== undefined && holds(read.records[0].state),
      ).toBe(true);
      const stageIdentity = claim?.supervision?.child;
      if (stageIdentity == null)
        throw new Error("the stage identity was not recorded");
      const deadline = performance.now() + 15000;
      let gone = false;
      while (performance.now() < deadline) {
        const verdict = judge(stageIdentity, await processTable(), thisHost());
        gone = verdict.ok && verdict.value.state === "dead";
        if (gone) break;
        await Bun.sleep(20);
      }
      expect(gone).toBe(true);
      const ended = await inspectRow(record.id, root);
      expect(ended?.state.kind).toBe("unknown");
      expect(ended?.exit).toBeNull();
      process.kill(billedPid, 0);
      expect(ended !== null && holds(ended.state)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      if (billedPid !== undefined)
        try {
          process.kill(billedPid, "SIGKILL");
        } catch {
          /* The observed process already ended. */
        }
      if (stagePid !== undefined)
        try {
          process.kill(stagePid, "SIGKILL");
        } catch {
          /* The observed process already ended. */
        }
      if (supervisorPid !== undefined)
        try {
          process.kill(supervisorPid, "SIGKILL");
        } catch {
          /* The observed process already ended. */
        }
      await Promise.all([stdout.stop(), stderr.stop()]);
      w.close();
    }
  },
  30000,
);
