import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const lifecycle = resolve(import.meta.dir, "../windows-process.ts");
const tree = resolve(import.meta.dir, "../process-tree.ts");
const registry = resolve(import.meta.dir, "../process-registry.ts");

test("nested lifecycle owns its scope, retains registrations and retries failed cancellation", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import {mock} from 'bun:test';
    import {existsSync,unlinkSync} from 'node:fs';
    import {dirname,join} from 'node:path';
    import {createProcessRegistry,publishProcessIdentity,processRegistryRoots,PROCESS_REGISTRY_ENV} from ${JSON.stringify(registry)};
    let calls=0, killed=0;
    mock.module(${JSON.stringify(tree)},()=>({
      stopWindowsTree:async(pid,grace,dir,owned,control)=>{calls++; control.killOwned(); return calls>1;},
      reapRegisteredProcessTrees:async()=>({survived:false,confirmed:true}),
    }));
    const {windowsProcessLifecycle}=await import(${JSON.stringify(lifecycle)});
    const parent=createProcessRegistry();
    const platform=process.platform;
    Object.defineProperty(process,'platform',{value:'win32',configurable:true});
    const scope=windowsProcessLifecycle({[PROCESS_REGISTRY_ENV]:parent.dir});
    Object.defineProperty(process,'platform',{value:platform,configurable:true});
    try {
      if(scope.dir===parent.dir || dirname(scope.dir)!==parent.dir) throw Error('must own nested scope');
      publishProcessIdentity(scope.dir,'runner',{pid:123,start:'owned'});
      scope.finish(()=>{});
      if(!existsSync(scope.dir)) throw Error('normal finish deleted live registration');
      scope.bind({pid:123,exitCode:null,signalCode:null,kill(){killed++;}});
      if(await scope.stop(123,0)!==false) throw Error('unknown cancellation falsely confirmed');
      if(!existsSync(scope.dir)) throw Error('failed cancellation deleted registration');
      unlinkSync(join(scope.dir,'runner.json'));
      scope.finish(()=>{});
      if(!existsSync(scope.dir)) throw Error('failed cancellation deleted its empty retry scope');
      if(processRegistryRoots(parent.dir)!==null) throw Error('ancestor forgot uncertain cancellation');
      if(await scope.stop(123,0)!==true || calls!==2 || killed!==2) throw Error('later cancellation was cached or fallback omitted');
      scope.finish(()=>{});
      if(existsSync(scope.dir)) throw Error('confirmed cancellation did not dispose scope');
      console.log('scope and retry verified');
    } finally {parent.dispose();}
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("scope and retry verified");
});

test("nested command cancellation leaves its live ancestor and sibling running", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import {spawn} from 'node:child_process';
    import {createProcessRegistry,publishProcessIdentity,PROCESS_REGISTRY_ENV} from ${JSON.stringify(registry)};
    import {processTable} from ${JSON.stringify(resolve(import.meta.dir, "../process-table.ts"))};
    import {windowsProcessLifecycle} from ${JSON.stringify(lifecycle)};
    const parent=createProcessRegistry();
    const siblingScope=createProcessRegistry(parent.dir);
    const platform=process.platform;
    Object.defineProperty(process,'platform',{value:'win32',configurable:true});
    const scope=windowsProcessLifecycle({[PROCESS_REGISTRY_ENV]:parent.dir});
    Object.defineProperty(process,'platform',{value:platform,configurable:true});
    const start=()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const sibling=start(), child=start();
    scope.bind(child);
    try {
      let rows;
      const deadline=Date.now()+20000;
      while(Date.now()<deadline){
        rows=await processTable();
        if(rows?.some(row=>row.pid===child.pid)&&rows.some(row=>row.pid===sibling.pid)) break;
      }
      const own=rows?.find(row=>row.pid===process.pid), other=rows?.find(row=>row.pid===sibling.pid);
      if(!own?.start||!other?.start) throw Error('missing native identities');
      publishProcessIdentity(parent.dir,'ancestor',own);
      publishProcessIdentity(siblingScope.dir,'sibling',other);
      if(!await scope.stop(child.pid,0,()=>child.exitCode===null&&child.signalCode===null)) throw Error('nested stop unconfirmed');
      process.kill(process.pid,0); process.kill(sibling.pid,0);
      console.log('ancestor and sibling remain live');
    } finally {
      for(const proc of [sibling,child]) {
        const exited=new Promise(resolve=>proc.once('exit',resolve));
        if(proc.exitCode===null&&proc.signalCode===null){proc.kill('SIGKILL');await exited;}
      }
      parent.dispose();
    }
  `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 60000 },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain(
    "ancestor and sibling remain live",
  );
}, 65000);

test("an exited child with an already released empty registry remains promptly unconfirmed", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import {spawn} from 'node:child_process';
    import {windowsProcessLifecycle} from ${JSON.stringify(lifecycle)};
    const platform=process.platform;
    Object.defineProperty(process,'platform',{value:'win32',configurable:true});
    const scope=windowsProcessLifecycle();
    Object.defineProperty(process,'platform',{value:platform,configurable:true});
    const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
    scope.bind(child);
    await new Promise(resolve=>child.once('exit',resolve));
    await new Promise(resolve=>scope.finish(resolve));
    const watchdog=setTimeout(()=>{throw Error('released empty scope became an unreadable registry');},1000);
    const confirmed=await scope.stop(child.pid,0,()=>false);
    clearTimeout(watchdog);
    if(confirmed) throw Error('uncaptured exited root was falsely confirmed');
    console.log('promptly unconfirmed');
  `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("promptly unconfirmed");
});

test("marker publication failure still cancels the owned child and remains unconfirmed", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
   import {mock} from 'bun:test';
   import {spawn} from 'node:child_process';
   import {existsSync} from 'node:fs';
   const actual=await import(${JSON.stringify(registry)});
   mock.module(${JSON.stringify(registry)},()=>({...actual,markProcessRegistryUnconfirmed(){throw Error('read-only registry');}}));
   mock.module(${JSON.stringify(tree)},()=>({stopWindowsTree:async(pid,grace,dir,owned,control)=>{control.killOwned();return false;},reapRegisteredProcessTrees:async()=>({survived:false,confirmed:false})}));
   const {windowsProcessLifecycle}=await import(${JSON.stringify(lifecycle)});
   const platform=process.platform;
   Object.defineProperty(process,'platform',{value:'win32',configurable:true});
   const scope=windowsProcessLifecycle();
   Object.defineProperty(process,'platform',{value:platform,configurable:true});
   const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
   scope.bind(child);
   const exited=new Promise(resolve=>child.once('exit',resolve));
   try {
     if(await scope.stop(child.pid,0,()=>child.exitCode===null&&child.signalCode===null)!==false) throw Error('uncertain stop confirmed');
     await exited;
     scope.finish(()=>{});
     if(!existsSync(scope.dir)) throw Error('uncertain scope removed');
     console.log('owned child killed, scope retained');
   } finally {child.kill('SIGKILL');actual.clearProcessRegistryUnconfirmed(scope.dir+'/owned-stop.pending');const {rmSync}=await import('node:fs');rmSync(scope.dir,{recursive:true,force:true});}
 `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain(
    "owned child killed, scope retained",
  );
});
