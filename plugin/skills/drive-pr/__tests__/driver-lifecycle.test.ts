import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const drive = new URL("../scripts/drive.ts", import.meta.url).href;
const tree = new URL("../../../shared/process-tree.ts", import.meta.url).href;
const cleanup = new URL("../../../shared/cleanup.ts", import.meta.url).href;
const mailbox = new URL("../scripts/lib/state/mailbox.ts", import.meta.url)
  .href;

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
          import {writeFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
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
          const {appendDirective}=await import(${JSON.stringify(mailbox)});
          const {installDriverLifecycle}=await import(${JSON.stringify(drive)});
          const claim=options.dir+'/claim';writeFileSync(claim,'held');
          const stateDir=options.dir+'/clone';mkdirSync(stateDir);
          const lock={stateDir,name:'pr-drive-1',what:'fixture',nonce:'generation'};
          const held=[lock];
          registerCleanup(()=>{
            if(held.includes(lock))rmSync(claim);
            console.log(JSON.stringify({completed,claimed:existsSync(claim)}));
          });
          const watch={dir:options.dir+'/mailbox',pr:'1',generation:1};
          if(options.mode==='cooperative')await appendDirective(watch.dir,'1','test','stop',{generation:1,now:true});
          await (async()=>{await using lifecycle=installDriverLifecycle(held,options.dir,watch);})();
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
