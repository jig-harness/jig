import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const drive = new URL("../scripts/drive.ts", import.meta.url).href;
const tree = new URL("../../../shared/process-tree.ts", import.meta.url).href;
const proc = new URL("../../../shared/proc.ts", import.meta.url).href;
const cleanup = new URL("../../../shared/cleanup.ts", import.meta.url).href;

for (const failure of [false, true]) {
  test(`driver boundary retains locks when registry drain rejects=${failure}`, () => {
    const result = Bun.spawnSync([
      process.execPath,
      "-e",
      `
      import {mock} from 'bun:test';
      const original=await import(${JSON.stringify(tree)});
      mock.module(${JSON.stringify(tree)},()=>({...original,reapRegisteredProcessTrees:async()=>{${failure ? "throw new Error('registry publication failed')" : "return {survived:false,confirmed:true}"};}}));
      const {finishDriverPassRegistrations}=await import(${JSON.stringify(drive)});
      const locks=[{dir:'fixture',what:'fixture'}];
      try {await finishDriverPassRegistrations(locks,'registry');}catch{}
      console.log(locks.length);
    `,
    ]);
    expectSpawnExit(result, 0);
    expect(result.stdout.toString().trim()).toBe(failure ? "0" : "1");
  });
}

test("driver cancellation rejection cannot release claims", () => {
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import {mock} from 'bun:test';
    const original=await import(${JSON.stringify(proc)});
    mock.module(${JSON.stringify(proc)},()=>({...original,cancelTrackedProcesses:async()=>{throw new Error('cancellation publication failed');}}));
    const {registerCleanup,requestShutdown}=await import(${JSON.stringify(cleanup)});
    const {installStopControls}=await import(${JSON.stringify(drive)});
    const locks=[{dir:'fixture',what:'fixture'}];
    registerCleanup(()=>console.log(locks.length));
    installStopControls(locks);
    requestShutdown('SIGTERM');
  `,
  ]);
  expectSpawnExit(result, 143);
  expect(result.stdout.toString().trim()).toBe("0");
});
