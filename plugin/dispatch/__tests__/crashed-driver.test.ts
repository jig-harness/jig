import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { poll } from "../../shared/retry.ts";
import { processTable } from "../../shared/process-table.ts";
import { observationPath } from "../../skills/drive-pr/scripts/lib/driver-observation.ts";
import { scopedStateDir } from "../../skills/drive-pr/__tests__/scoped-state-dir.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import {
  leaseRef,
  treeLeaseRef,
  readLease,
  readTreeLease,
} from "../../skills/drive-pr/scripts/lib/state/lease.ts";
import {
  ledgerComment,
  openPr,
  stoppedLedger,
  world,
  SLUG,
  type World,
} from "./fixtures.ts";
import {
  account,
  machineFile,
  recordIds,
  exitWritten,
  waitFor,
} from "./launch-fixtures.ts";

let fixture: World | null = null;
let driver: Bun.Subprocess | null = null;
let passPid: number | null = null;
afterEach(async () => {
  driver?.kill("SIGKILL");
  if (driver !== null) await driver.exited;
  if (passPid !== null) {
    try {
      process.kill(passPid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  fixture?.close();
  driver = null;
  passPid = null;
  fixture = null;
});

test("an abruptly killed hand-armed driver waits for its observed pass, then re-arms without retaining a lease", async () => {
  const w = world();
  fixture = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [openPr(7, "feature/7")]);
  const leaf = scopedStateDir(w.env.DRIVE_PR_STATE_DIR as string, w.repo);
  const started = "2026-10-30T20:00:00.000Z";
  const actor = `wt-${worktreePathKey(w.repo)}`;
  const ledger = stoppedLedger(7, undefined);
  ledger.driver = {
    ...ledger.driver,
    actor,
    clone: cloneId(leaf),
    started,
    recoveryVersion: 1,
    position: 0,
    state: "running",
  };
  w.setComments(7, [ledgerComment(701, ledger)]);
  const ready = join(w.root, "pass-ready");
  const script = join(w.root, "driver.ts");
  const module = (path: string) =>
    JSON.stringify(resolve(import.meta.dir, path));
  writeFileSync(
    script,
    `
    import {writeFileSync} from "node:fs";
    import {hostname} from "node:os";
    import {captureIdentity} from ${module("../../shared/liveness.ts")};
    import {putLock} from ${module("../../skills/drive-pr/__tests__/state-rows.ts")};
    import {writeDriverRecord} from ${module("../../skills/drive-pr/scripts/lib/ledger-stop.ts")};
    import {startDriverObservation,runObservedPass} from ${module("../../skills/drive-pr/scripts/lib/driver-observation.ts")};
    const leaf=${JSON.stringify(leaf)}, started=${JSON.stringify(started)}, worktree=${JSON.stringify(w.repo)};
    const identity=await captureIdentity();
    if(!identity.ok) process.exit(2);
    putLock(leaf,"pr-drive-7",{...identity.value,token:"abc123",diag:{pr:"7",worktree,started,log:"",account:{account:null,vendor:null,provenance:"none",reason:"test"}}});
    writeDriverRecord(leaf,"7",{worktree,started,pid:process.pid,host:hostname()});
    await startDriverObservation(leaf,"7",started,null,"abc123");
    await runObservedPass([process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdout:"ignore",stderr:"ignore",onSpawn:h=>writeFileSync(${JSON.stringify(ready)},String(h.pid))});
  `,
  );
  driver = Bun.spawn([process.execPath, script], {
    cwd: w.repo,
    env: w.env,
    stdout: "ignore",
    stderr: "pipe",
  });
  await poll(
    () => {
      if (!existsSync(ready)) return false;
      const observation = observationPath(leaf, "7", started);
      if (!existsSync(observation)) return false;
      return JSON.parse(readFileSync(observation, "utf8")).pending === false;
    },
    { everyMs: 20, deadlineMs: Date.now() + 15_000, until: (v) => v },
  );
  passPid = Number(readFileSync(ready, "utf8"));
  driver.kill("SIGKILL");
  expectSpawnExitNot(
    {
      exitCode: await driver.exited,
      stdout: null,
      stderr:
        driver.stderr instanceof ReadableStream
          ? await new Response(driver.stderr).text()
          : null,
    },
    0,
    "intentional abrupt driver kill",
  );
  driver = null;
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm"]);
  const survivor = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(survivor, 0);
  expect(JSON.parse(survivor.stdout).repos[0].actions).toContainEqual(
    expect.objectContaining({ target: "PR #7", stage: "notify" }),
  );
  process.kill(passPid, "SIGKILL");
  await poll(processTable, {
    everyMs: 20,
    deadlineMs: Date.now() + 10_000,
    until: (rows) =>
      rows !== null &&
      !rows.some((r) => r.pid === passPid && !r.stat.startsWith("Z")),
  });
  passPid = null;
  const recovered = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(recovered, 0);
  expect(JSON.parse(recovered.stdout).repos[0].actions).toContainEqual(
    expect.objectContaining({
      stage: "rearm",
      evidence: expect.objectContaining({
        driver: "stopped",
        noCause: true,
        exit: null,
      }),
    }),
  );
  expect(readLease(leaseRef(leaf, "7", actor))).toBeNull();
  expect(readTreeLease(treeLeaseRef(leaf, actor))).toBeNull();
  expect(existsSync(observationPath(leaf, "7", started))).toBe(false);
  await waitFor("recovered wrapper exits", () =>
    recordIds(w).every((id) => exitWritten(w, id)),
  );
}, 30_000);
