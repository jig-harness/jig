import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const drive = new URL("../scripts/drive.ts", import.meta.url).href;
const tree = new URL("../../../shared/process-tree.ts", import.meta.url).href;
const cleanup = new URL("../../../shared/cleanup.ts", import.meta.url).href;
const request = new URL("../scripts/lib/stop-request.ts", import.meta.url).href;

for (const mode of ["signal", "cooperative"]) {
  for (const confirmed of [false, true]) {
    test(`${mode} cancellation during final drain retains ownership until confirmed=${confirmed}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "jig-driver-drain-"));
      try {
        const result = Bun.spawnSync([
          process.execPath,
          "-e",
          `
          import {mock} from 'bun:test';
          import {writeFileSync,existsSync,rmSync} from 'node:fs';
          const options=JSON.parse(process.argv[1]);
          const original=await import(${JSON.stringify(tree)});
          const child=Bun.spawn([process.execPath,'-e','setTimeout(()=>process.exit(0),2000)'],{stdout:'ignore',stderr:'ignore'});
          let completed=false;
          mock.module(${JSON.stringify(tree)},()=>({...original,reapRegisteredProcessTrees:async()=>{
            if(options.mode==='signal') setTimeout(()=>process.emit('SIGTERM'),20);
            await new Promise(resolve=>setTimeout(resolve,350));
            child.kill();await child.exited;
            completed=true;
            return {survived:true,confirmed:options.confirmed};
          }}));
          const {registerCleanup}=await import(${JSON.stringify(cleanup)});
          const {requestDriverStop}=await import(${JSON.stringify(request)});
          const {installDriverLifecycle}=await import(${JSON.stringify(drive)});
          const claim=options.dir+'/claim';writeFileSync(claim,'held');
          const lock={dir:options.dir,what:'fixture',nonce:'generation'};
          const held=[lock];
          registerCleanup(()=>{
            if(held.includes(lock))rmSync(claim);
            console.log(JSON.stringify({completed,claimed:existsSync(claim)}));
          });
          if(options.mode==='cooperative')requestDriverStop(options.dir,'generation');
          await (async()=>{await using lifecycle=installDriverLifecycle(held,options.dir);})();
        `,
          JSON.stringify({ mode, confirmed, dir }),
        ]);
        expectSpawnExit(result, 143);
        expect(JSON.parse(result.stdout.toString().trim())).toEqual({
          completed: true,
          claimed: !confirmed,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
