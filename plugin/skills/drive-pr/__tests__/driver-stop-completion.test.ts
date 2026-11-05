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
  appendDirective,
  appendOutboxRecord,
} from "../scripts/lib/state/mailbox.ts";
import {
  ackDirective,
  directiveAcked,
} from "../scripts/lib/state/mailbox-stop.ts";
import { lockRow, putLock } from "./state-rows.ts";

const nonce = "aaaaaaaaaaaaaaaaaaaaaaaa";
const lock = "pr-drive-999";
for (const receipt of [
  "matching",
  "missing",
  "another directive's",
  "a pass's",
]) {
  test(`operator reconciles a disappeared incomplete registry only with ${receipt} acknowledgement`, async () => {
    const root = mkdtempSync(join(tmpdir(), "driver-stop-proof-"));
    const stateDir = join(root, "clone"),
      mailbox = join(root, "mailbox"),
      registry = join(stateDir, `${lock}.processes.${nonce}`);
    mkdirSync(registry, { recursive: true });
    const stop = await appendDirective(mailbox, "999", "test", "stop", {
      generation: 1,
      now: true,
    });
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
      const completed = () => directiveAcked(mailbox, "999", stop.id);
      const refresh = registryCompletionTracker(registry, state, completed);
      expect(await refresh()).toBe(false);
      child.kill();
      await child.exited;
      if (receipt === "matching")
        await ackDirective(mailbox, "999", stop.id, 1);
      if (receipt === "another directive's")
        await ackDirective(mailbox, "999", "m-another", 1);
      if (receipt === "a pass's")
        await appendOutboxRecord(mailbox, {
          id: stop.id,
          ts: new Date().toISOString(),
          pr: "999",
          status: "received",
        });
      rmSync(registry, { recursive: true });
      expect(await refresh()).toBe(receipt === "matching");
      expect(
        await forceStopDriver(owner, targets, refresh, 0, state, completed),
      ).toBe(receipt === "matching" ? 0 : 1);
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
}

const drive = new URL("../scripts/drive.ts", import.meta.url).href;
const locks = new URL("../scripts/lib/driver/locks.ts", import.meta.url).href;
const stops = new URL("../scripts/lib/state/mailbox-stop.ts", import.meta.url)
  .href;
const mailboxModule = new URL(
  "../scripts/lib/state/mailbox.ts",
  import.meta.url,
).href;
const cleanup = new URL("../../../shared/cleanup.ts", import.meta.url).href;
for (const failed of [false, true])
  test(`an acknowledgement the driver cannot append keeps its locks=${failed}`, () => {
    const root = mkdtempSync(join(tmpdir(), "driver-completion-publish-"));
    const stateDir = join(root, "clone");
    const mailbox = join(root, "mailbox");
    mkdirSync(stateDir);
    putLock(stateDir, lock, { token: nonce });
    try {
      const result = Bun.spawnSync([
        process.execPath,
        "-e",
        `
   import {mock} from 'bun:test';
   const options=JSON.parse(process.argv[1]);
   const original=await import(${JSON.stringify(stops)});
   const ack=original.ackDirective;
   mock.module(${JSON.stringify(stops)},()=>({...original,async ackDirective(...args){if(options.failed)throw Error('outbox unavailable');return ack(...args);}}));
   const {registerCleanup}=await import(${JSON.stringify(cleanup)});
   const {appendDirective}=await import(${JSON.stringify(mailboxModule)});
   const {installStopControls}=await import(${JSON.stringify(drive)});
   const {release}=await import(${JSON.stringify(locks)});
   const lock={stateDir:options.stateDir,name:options.lock,what:'fixture',nonce:options.nonce};
   const held=[lock];
   const stack=new DisposableStack();
   stack.use(registerCleanup(()=>{if(held.includes(lock))release(lock);}));
   installStopControls(held,undefined,{dir:options.mailbox,pr:'999',generation:1});
   const stop=await appendDirective(options.mailbox,'999','test','stop',{generation:1,now:true});
   console.log(stop.id);
   setInterval(()=>{},1000);
  `,
        JSON.stringify({ stateDir, mailbox, lock, nonce, failed }),
      ]);
      expectSpawnExit(result, 143);
      const id = result.stdout.toString().trim();
      expect(lockRow(stateDir, lock) !== null).toBe(failed);
      expect(directiveAcked(mailbox, "999", id)).toBe(!failed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
