import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTable } from "../../../shared/process-table.ts";
import {
  forceStopDriver,
  registryCompletionTracker,
} from "../scripts/drives.ts";
import { beginProcessRegistration } from "../../../shared/process-registry.ts";
import {
  driverStopCompleted,
  publishDriverStopCompletion,
  consumeDriverStopCompletion,
  requestDriverStop,
} from "../scripts/lib/stop-request.ts";
import { lockRow, putLock, stopRows } from "./state-rows.ts";

const nonce = "aaaaaaaaaaaaaaaaaaaaaaaa";
const lock = "pr-drive-999";
for (const receipt of [
  "matching",
  "missing",
  "wrong-generation",
  "wrong-owner",
]) {
  test(`operator reconciles a disappeared incomplete registry only with ${receipt} receipt`, async () => {
    const root = mkdtempSync(join(tmpdir(), "driver-stop-proof-"));
    const stateDir = join(root, "clone"),
      registry = join(stateDir, `${lock}.processes.${nonce}`);
    mkdirSync(registry, { recursive: true });
    requestDriverStop(stateDir, lock, nonce);
    const child = Bun.spawn(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      const owner = (await processTable())?.find(
        (row) => row.pid === child.pid,
      );
      expect(owner?.start).toBeTruthy();
      if (!owner) return;
      beginProcessRegistration(
        registry,
        "owned-stop",
        join(root, "result.json"),
      );
      const targets = [owner],
        state = { root: owner, targets };
      const completed = () =>
        driverStopCompleted(stateDir, lock, nonce, owner.pid);
      const refresh = registryCompletionTracker(registry, state, completed);
      expect(await refresh()).toBe(false);
      child.kill();
      await child.exited;
      if (receipt === "wrong-generation")
        requestDriverStop(stateDir, lock, "bbbbbbbbbbbbbbbbbbbbbbbb");
      if (receipt !== "missing")
        publishDriverStopCompletion(
          stateDir,
          lock,
          receipt === "wrong-generation" ? "bbbbbbbbbbbbbbbbbbbbbbbb" : nonce,
          receipt === "wrong-owner" ? owner.pid + 1 : owner.pid,
        );
      rmSync(registry, { recursive: true });
      expect(await refresh()).toBe(receipt === "matching");
      expect(
        await forceStopDriver(owner, targets, refresh, 0, state, completed),
      ).toBe(receipt === "matching" ? 0 : 1);
      if (receipt === "matching") {
        consumeDriverStopCompletion(stateDir, lock, nonce);
        expect(driverStopCompleted(stateDir, lock, nonce, owner.pid)).toBe(
          false,
        );
        expect(stopRows(stateDir)).toEqual([]);
      }
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
}

const drive = new URL("../scripts/drive.ts", import.meta.url).href;
const locks = new URL("../scripts/lib/driver/locks.ts", import.meta.url).href;
const stop = new URL("../scripts/lib/stop-request.ts", import.meta.url).href;
const cleanup = new URL("../../../shared/cleanup.ts", import.meta.url).href;
for (const failed of [false, true])
  test(`completion publication failure vetoes lock cleanup=${failed}`, () => {
    const root = mkdtempSync(join(tmpdir(), "driver-completion-publish-"));
    const stateDir = join(root, "clone");
    mkdirSync(stateDir);
    putLock(stateDir, lock, { token: nonce });
    try {
      const result = Bun.spawnSync([
        process.execPath,
        "-e",
        `
   import {mock} from 'bun:test';
   const options=JSON.parse(process.argv[1]);
   const original=await import(${JSON.stringify(stop)});
   const publish=original.publishDriverStopCompletion;
   mock.module(${JSON.stringify(stop)},()=>({...original,publishDriverStopCompletion(...args){if(options.failed)throw Error('receipt storage unavailable');publish(...args);}}));
   const {registerCleanup,registerSignalHandler}=await import(${JSON.stringify(cleanup)});
   const {installStopControls,driverStopCompletionCleanup}=await import(${JSON.stringify(drive)});
   const {release}=await import(${JSON.stringify(locks)});
   const lock={stateDir:options.stateDir,name:options.lock,what:'fixture',nonce:options.nonce};
   const held=[lock];
   const stack=new DisposableStack();
   stack.use(registerCleanup(()=>{if(held.includes(lock))release(lock);}));
   stack.use(driverStopCompletionCleanup(held));
   registerSignalHandler(async()=>{await new Promise(resolve=>setTimeout(resolve,100));if(original.driverStopCompleted(lock.stateDir,lock.name,lock.nonce,process.pid))process.exit(91);});
   installStopControls(held);
   original.requestDriverStop(lock.stateDir,lock.name,lock.nonce);
   registerCleanup(()=>{});
   setInterval(()=>{},1000);
  `,
        JSON.stringify({ stateDir, lock, nonce, failed }),
      ]);
      expectSpawnExit(result, 143);
      expect(lockRow(stateDir, lock) !== null).toBe(failed);
      expect(driverStopCompleted(stateDir, lock, nonce, result.pid)).toBe(
        !failed,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
