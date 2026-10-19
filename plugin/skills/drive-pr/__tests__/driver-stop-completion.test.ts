import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
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
  stopCompletionPath,
  consumeDriverStopCompletion,
} from "../scripts/lib/stop-request.ts";
import { classify } from "../scripts/lib/state/artifacts.ts";

const nonce = "aaaaaaaaaaaaaaaaaaaaaaaa";
for (const receipt of [
  "matching",
  "missing",
  "wrong-generation",
  "wrong-owner",
  "malformed",
]) {
  test(`operator reconciles a disappeared incomplete registry only with ${receipt} receipt`, async () => {
    const root = mkdtempSync(join(tmpdir(), "driver-stop-proof-"));
    const lock = join(root, "pr-drive-999.lock"),
      registry = join(lock, "processes");
    mkdirSync(registry, { recursive: true });
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
      const completed = () => driverStopCompleted(lock, nonce, owner.pid);
      const refresh = registryCompletionTracker(registry, state, completed);
      expect(await refresh()).toBe(false);
      child.kill();
      await child.exited;
      if (receipt === "malformed")
        writeFileSync(stopCompletionPath(lock, nonce) ?? "", "{");
      else if (receipt !== "missing")
        publishDriverStopCompletion(
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
        consumeDriverStopCompletion(lock, nonce);
        expect(existsSync(stopCompletionPath(lock, nonce) ?? "")).toBe(false);
      }
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
}

const drive = new URL("../scripts/drive.ts", import.meta.url).href;
const stop = new URL("../scripts/lib/stop-request.ts", import.meta.url).href;
const cleanup = new URL("../../../shared/cleanup.ts", import.meta.url).href;
for (const failed of [false, true])
  test(`completion publication failure vetoes lock cleanup=${failed}`, () => {
    const root = mkdtempSync(join(tmpdir(), "driver-completion-publish-"));
    try {
      const result = Bun.spawnSync([
        process.execPath,
        "-e",
        `
   import {mock} from 'bun:test';
   import {mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
   const options=JSON.parse(process.argv[1]);
   const original=await import(${JSON.stringify(stop)});
   const publish=original.publishDriverStopCompletion;
   mock.module(${JSON.stringify(stop)},()=>({...original,publishDriverStopCompletion(...args){if(options.failed)throw Error('receipt storage unavailable');publish(...args);}}));
   const {registerCleanup,registerSignalHandler}=await import(${JSON.stringify(cleanup)});
   const {installStopControls,driverStopCompletionCleanup}=await import(${JSON.stringify(drive)});
   const lock={dir:options.root+'/pr-drive-999.lock',what:'fixture',nonce:options.nonce};
   mkdirSync(lock.dir);writeFileSync(lock.dir+'/claim','held');
   const held=[lock];
   const stack=new DisposableStack();
   stack.use(registerCleanup(()=>{if(held.includes(lock))rmSync(lock.dir,{recursive:true});}));
   stack.use(driverStopCompletionCleanup(held));
   registerSignalHandler(async()=>{await new Promise(resolve=>setTimeout(resolve,100));if(original.driverStopCompleted(lock.dir,options.nonce,process.pid))process.exit(91);});
   installStopControls(held);
   original.requestDriverStop(lock.dir,options.nonce);
   registerCleanup(()=>{});
   setInterval(()=>{},1000);
  `,
        JSON.stringify({ root, nonce, failed }),
      ]);
      expectSpawnExit(result, 143);
      const lock = join(root, "pr-drive-999.lock");
      expect(existsSync(lock)).toBe(failed);
      const receipt = stopCompletionPath(lock, nonce);
      expect(receipt !== null && existsSync(receipt)).toBe(!failed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("orphan completion receipts and publication temporaries retire with their PR family", () => {
  const files = [
    `drive-pr-999.stop-complete.${nonce}.json`,
    `drive-pr-999.stop-complete.${nonce}.json.123.tmp`,
  ];
  const inventory = classify(files);
  expect(inventory.unrecognised).toEqual([]);
  expect(inventory.families.get("pr:999")?.names).toEqual(files);
  expect(inventory.families.get("pr:999")?.anchors.size).toBe(0);
});

test("an unreadable completion receipt stays unconfirmed and retains its diagnostic cause", () => {
  const root = mkdtempSync(join(tmpdir(), "driver-receipt-unreadable-"));
  try {
    const lock = join(root, "pr-drive-999.lock");
    const receipt = stopCompletionPath(lock, nonce);
    expect(receipt).not.toBeNull();
    if (receipt === null) return;
    mkdirSync(receipt);
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
      const {driverStopCompleted}=await import(${JSON.stringify(stop)});
      const options=JSON.parse(process.argv[1]);
      console.log(driverStopCompleted(options.lock,options.nonce,123));
    `,
        JSON.stringify({ lock, nonce }),
      ],
      { env: { ...process.env, JIG_LOG: "debug" } },
    );
    expectSpawnExit(result, 0);
    expect(result.stdout.toString().trim()).toBe("false");
    expect(result.stderr.toString()).toContain(
      "unreadable stop completion receipt cannot confirm shutdown",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
