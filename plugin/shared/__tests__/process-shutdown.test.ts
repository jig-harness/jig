import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
const shared = resolve(import.meta.dir, "..");

test("manual and signal cancellation join one helper result before later generations", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
   Object.defineProperty(process,'platform',{value:'win32',configurable:true});
   const {registerCancellationGroup,cancelTrackedProcesses}=await import(${JSON.stringify(resolve(shared, "proc.ts"))});
   process.on('SIGTERM',()=>{});
   let calls=0;
   const unregister=registerCancellationGroup(777,undefined,async()=>{calls++;await new Promise(resolve=>setImmediate(resolve));return false;});
   const first=cancelTrackedProcesses(),second=cancelTrackedProcesses();
   if(first!==second) throw Error('cancellation did not singleflight');
   process.emit('SIGTERM');
   if(await first!==false||calls!==1) throw Error('unknown helper cancellation lost');
   unregister();
   const next=registerCancellationGroup(778,undefined,async()=>{calls++;return true;});
   if(await cancelTrackedProcesses()!==true||calls!==2) throw Error('new generation used stale cancellation');
   next(); console.log('joined false, then fresh true');
 `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("joined false, then fresh true");
});

for (const module of [
  resolve(shared, "proc.ts"),
  resolve(shared, "../skills/drive-pr/scripts/lib/proc.ts"),
]) {
  test(`explicit shutdown suspends new commands in ${module.endsWith("lib/proc.ts") ? "drive" : "shared"} runner`, () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
    import {beginShutdown,requestShutdown,registerCleanup,registerSignalHandler} from ${JSON.stringify(resolve(shared, "cleanup.ts"))};
    import {mock} from 'bun:test';
    let spawned=false,settled=false;
    const actual=await import('node:child_process');
    const nativeSpawn=actual.spawn;
    mock.module('node:child_process',()=>({...actual,spawn(...args){spawned=true;return nativeSpawn(...args);}}));
    const {run}=await import(${JSON.stringify(module)});
    registerCleanup(()=>{if(spawned||settled)process.exit(99);console.log('spawn and continuation blocked');});
    registerSignalHandler(async()=>{await new Promise(resolve=>setImmediate(resolve));});
    beginShutdown();
    void run([process.execPath,'-e','process.exit(0)']).then(()=>{settled=true;});
    requestShutdown('SIGTERM',31);
  `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, 31);
    expect(result.stdout.toString()).toContain(
      "spawn and continuation blocked",
    );
  });
}

for (const module of [
  resolve(shared, "proc.ts"),
  resolve(shared, "../skills/drive-pr/scripts/lib/proc.ts"),
]) {
  test(`a caller handling SIGTERM can still start a command in ${module.endsWith("lib/proc.ts") ? "drive" : "shared"} runner`, () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
    import {run} from ${JSON.stringify(module)};
    process.on('SIGTERM',()=>{});
    process.emit('SIGTERM');
    const result=await run([process.execPath,'-e',"console.log('child executed')"]);
    if(result.code!==0||!result.stdout.includes('child executed')) throw Error('caller-owned signal blocked a later command');
    console.log('caller continues');
  `,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toContain("caller continues");
  });
}
