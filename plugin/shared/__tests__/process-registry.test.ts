import { captureRegisteredProcessTrees } from "../process-tree.ts";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  createProcessRegistry,
  markProcessRegistryUnconfirmed,
  clearProcessRegistryUnconfirmed,
  processCompletionPath,
  publishProcessCompletion,
  publishProcessIdentity,
  beginProcessRegistration,
  handoffProcessRegistration,
  processRegistryRoots,
  processRegistrySnapshot,
  processIdentityCompleted,
  processIdentityUnwitnessed,
} from "../process-registry.ts";

test("each pass has an isolated registry and an empty registry is readable", () => {
  const first = createProcessRegistry();
  const second = createProcessRegistry();
  try {
    expect(first.dir).not.toBe(second.dir);
    expect(processRegistryRoots(first.dir)).toEqual([]);
    writeFileSync(
      join(first.dir, "runner.json"),
      JSON.stringify({ pid: 123, start: "created" }),
    );
    expect(processRegistryRoots(first.dir)).toEqual([
      { pid: 123, start: "created" },
    ]);
    expect(processRegistryRoots(second.dir)).toEqual([]);
  } finally {
    first.dispose();
    second.dispose();
  }
  expect(processRegistryRoots(first.dir)).toBeNull();
});

for (const [name, value] of [
  ["runner.pending", ""],
  ["malformed.json", "{"],
  ["missing-start.json", '{"pid":123}'],
] as const) {
  test(`${name} withholds the termination witness`, () => {
    const registry = createProcessRegistry();
    try {
      writeFileSync(join(registry.dir, name), value);
      expect(processRegistryRoots(registry.dir)).toBeNull();
    } finally {
      registry.dispose();
    }
  });
}

test("an empty registry can be read without a native process-table query", async () => {
  const registry = createProcessRegistry();
  try {
    let queries = 0;
    expect(
      await captureRegisteredProcessTrees(registry.dir, async () => {
        queries++;
        return null;
      }),
    ).toEqual([]);
    expect(queries).toBe(0);
  } finally {
    registry.dispose();
  }
});

test("nested command scopes see their own descendants, while acquisition sees every scope", () => {
  const acquisition = createProcessRegistry();
  const command = createProcessRegistry(acquisition.dir);
  const nested = createProcessRegistry(command.dir);
  const sibling = createProcessRegistry(acquisition.dir);
  try {
    writeFileSync(
      join(acquisition.dir, "parent.json"),
      JSON.stringify({ pid: 1, start: "parent" }),
    );
    writeFileSync(
      join(command.dir, "command.json"),
      JSON.stringify({ pid: 2, start: "command" }),
    );
    writeFileSync(
      join(nested.dir, "nested.json"),
      JSON.stringify({ pid: 3, start: "nested" }),
    );
    writeFileSync(
      join(sibling.dir, "sibling.json"),
      JSON.stringify({ pid: 4, start: "sibling" }),
    );
    expect(
      processRegistryRoots(command.dir)
        ?.map((r) => r.pid)
        .sort(),
    ).toEqual([2, 3]);
    expect(
      processRegistryRoots(acquisition.dir)
        ?.map((r) => r.pid)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
    expect(processRegistryRoots(sibling.dir)?.map((r) => r.pid)).toEqual([4]);
  } finally {
    acquisition.dispose();
    command.dispose();
    nested.dispose();
    sibling.dispose();
  }
});

test("completed pending records are reconciled, but malformed completion cannot clear ownership uncertainty", () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  try {
    beginProcessRegistration(registry.dir, "runner", resultFile);
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(resultFile, '{"exitCode":"0"}');
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(resultFile, '{"exitCode":0,"signal":null}');
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(
      resultFile,
      '{"exitCode":0,"treeWitnessed":false,"note":"descendants may survive"}',
    );
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(
      resultFile,
      '{"exitCode":0,"signal":null,"treeWitnessed":true}',
    );
    expect(processRegistryRoots(registry.dir)).toEqual([]);
  } finally {
    registry.dispose();
  }
});

test("a transient failed handoff retries and records only pid plus creation identity", async () => {
  const registry = createProcessRegistry();
  try {
    beginProcessRegistration(
      registry.dir,
      "runner",
      join(registry.dir, "result.tmp"),
    );
    let probes = 0;
    expect(
      await handoffProcessRegistration(
        registry.dir,
        "runner",
        123,
        () => false,
        () => true,
        {
          table: async () =>
            ++probes === 1
              ? null
              : [
                  {
                    pid: 123,
                    ppid: 1,
                    pgid: 0,
                    start: "created",
                    stat: "R",
                    args: "private prompt",
                  },
                ],
          timeoutMs: 1000,
          pollMs: 1,
        },
      ),
    ).toBe(true);
    expect(probes).toBe(2);
    expect(processRegistryRoots(registry.dir)).toEqual([
      {
        pid: 123,
        start: "created",
        resultFile: join(registry.dir, "result.tmp"),
      },
    ]);
    expect(
      readFileSync(join(registry.dir, "runner.json"), "utf8"),
    ).not.toContain("private prompt");
  } finally {
    registry.dispose();
  }
});

test("an unresolved handoff is bounded and a later result reconciles its marker", async () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  try {
    beginProcessRegistration(registry.dir, "runner", resultFile);
    expect(
      await handoffProcessRegistration(
        registry.dir,
        "runner",
        123,
        () => false,
        () => true,
        { table: async () => null, timeoutMs: 5, pollMs: 1 },
      ),
    ).toBe(false);
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":true}');
    expect(processRegistryRoots(registry.dir)).toEqual([]);
  } finally {
    registry.dispose();
  }
});

test("a pid owner lost during enumeration never becomes a registered stranger", async () => {
  const registry = createProcessRegistry();
  let owned = true;
  try {
    beginProcessRegistration(
      registry.dir,
      "runner",
      join(registry.dir, "result.tmp"),
    );
    expect(
      await handoffProcessRegistration(
        registry.dir,
        "runner",
        123,
        () => false,
        () => owned,
        {
          table: async () => {
            owned = false;
            return [
              {
                pid: 123,
                ppid: 1,
                pgid: 0,
                start: "stranger",
                stat: "R",
                args: "",
              },
            ];
          },
          timeoutMs: 5,
          pollMs: 1,
        },
      ),
    ).toBe(false);
    expect(processRegistryRoots(registry.dir)).toBeNull();
  } finally {
    registry.dispose();
  }
});

test("unresolved registration withholds completion while preserving independently verified roots", () => {
  const registry = createProcessRegistry();
  try {
    writeFileSync(
      join(registry.dir, "known.json"),
      JSON.stringify({ pid: 123, start: "known" }),
    );
    beginProcessRegistration(
      registry.dir,
      "pending",
      join(registry.dir, "missing-result.tmp"),
    );
    expect(processRegistryRoots(registry.dir)).toBeNull();
    expect(processRegistrySnapshot(registry.dir)).toEqual({
      roots: [{ pid: 123, start: "known" }],
      complete: false,
    });
  } finally {
    registry.dispose();
  }
});

test("identity records retain completion authority when no terminal result could be written", () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  try {
    const identity = { pid: 123, start: "created", resultFile };
    writeFileSync(join(registry.dir, "runner.json"), JSON.stringify(identity));
    expect(processRegistrySnapshot(registry.dir).roots).toEqual([identity]);
    expect(processIdentityCompleted(identity)).toBe(false);
    writeFileSync(
      resultFile,
      '{"exitCode":0,"treeWitnessed":false,"note":"descendants may survive"}',
    );
    expect(processIdentityCompleted(identity)).toBe(false);
    expect(processRegistrySnapshot(registry.dir).roots).toEqual([identity]);
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":true}');
    expect(processIdentityCompleted(identity)).toBe(true);
    expect(processRegistryRoots(registry.dir)).toEqual([]);
  } finally {
    registry.dispose();
  }
});

test("explicit unwitnessed completion differs from missing or malformed completion", () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  const identity = { pid: 123, start: "created", resultFile };
  try {
    expect(processIdentityUnwitnessed(identity)).toBe(false);
    writeFileSync(resultFile, '{"exitCode":"0","treeWitnessed":false}');
    expect(processIdentityUnwitnessed(identity)).toBe(false);
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":false}');
    expect(processIdentityUnwitnessed(identity)).toBe(true);
    expect(processIdentityCompleted(identity)).toBe(false);
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":true}');
    expect(processIdentityUnwitnessed(identity)).toBe(false);
    expect(processIdentityCompleted(identity)).toBe(true);
  } finally {
    registry.dispose();
  }
});

test("an owner retries past only its own failed-stop marker while ancestors remain uncertain", () => {
  const ancestor = createProcessRegistry();
  const owner = createProcessRegistry(ancestor.dir);
  const sibling = createProcessRegistry(ancestor.dir);
  try {
    const marker = markProcessRegistryUnconfirmed(owner.dir);
    expect(processRegistrySnapshot(ancestor.dir).complete).toBe(false);
    expect(processRegistrySnapshot(owner.dir, marker)).toEqual({
      roots: [],
      complete: true,
    });
    const other = markProcessRegistryUnconfirmed(sibling.dir);
    expect(processRegistrySnapshot(ancestor.dir, marker).complete).toBe(false);
    clearProcessRegistryUnconfirmed(other);
    expect(processRegistrySnapshot(ancestor.dir).complete).toBe(false);
    clearProcessRegistryUnconfirmed(marker);
    expect(processRegistrySnapshot(ancestor.dir).complete).toBe(true);
  } finally {
    ancestor.dispose();
  }
});

test("retained acquisition completion fences a late identity publisher after generation cleanup", () => {
  const registry = createProcessRegistry();
  const generation = createProcessRegistry();
  const publicResult = join(generation.dir, "result.json");
  const first = "runner-first-nonce";
  try {
    const authority = processCompletionPath(registry.dir, first);
    beginProcessRegistration(registry.dir, first, authority);
    publishProcessIdentity(
      registry.dir,
      first,
      { pid: 123, start: "owned" },
      authority,
    );
    writeFileSync(
      publicResult,
      JSON.stringify({ exitCode: 0, treeWitnessed: true }),
    );
    publishProcessCompletion(registry.dir, first, {
      exitCode: 0,
      treeWitnessed: true,
    });
    generation.dispose();
    expect(existsSync(publicResult)).toBe(false);
    expect(processRegistryRoots(registry.dir)).toEqual([]);
    expect(JSON.parse(readFileSync(authority, "utf8"))).toEqual({
      exitCode: 0,
      treeWitnessed: true,
    });
    // A delayed publisher keeps the same authority even after its old public
    // result and identity record have been removed.
    publishProcessIdentity(
      registry.dir,
      first,
      { pid: 123, start: "owned" },
      authority,
    );
    expect(processRegistryRoots(registry.dir)).toEqual([]);
    const next = "runner-distinct-nonce";
    beginProcessRegistration(
      registry.dir,
      next,
      processCompletionPath(registry.dir, next),
    );
    expect(processRegistryRoots(registry.dir)).toBeNull();
  } finally {
    registry.dispose();
    generation.dispose();
  }
});

for (const terminal of [
  { exitCode: 0, treeWitnessed: false },
  { exitCode: 0, treeWitnessed: "false" },
])
  test("an unresolved durable terminal witness preserves actionable roots and withholds confirmation", () => {
    const registry = createProcessRegistry();
    try {
      const authority = processCompletionPath(registry.dir, "runner");
      publishProcessIdentity(
        registry.dir,
        "runner",
        { pid: 123, start: "owned" },
        authority,
      );
      writeFileSync(authority, JSON.stringify(terminal));
      expect(() =>
        publishProcessCompletion(registry.dir, "runner", {
          exitCode: 0,
          treeWitnessed: true,
        }),
      ).toThrow();
      const snapshot = processRegistrySnapshot(registry.dir);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.roots).toEqual([
        { pid: 123, start: "owned", resultFile: authority },
      ]);
      expect(snapshot.roots.map(processIdentityUnwitnessed)).toEqual([
        terminal.treeWitnessed === false,
      ]);
    } finally {
      registry.dispose();
    }
  });

test("an interrupted completion write leaves no final authority and permits a complete retry", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import {mock} from 'bun:test';
    const fs=await import('node:fs');
    const write=fs.writeFileSync;
    let injected=false,armed=false;
    mock.module('node:fs',()=>({...fs,writeFileSync(path,data,options){
      if(armed && !injected && (typeof path==='number'||String(path).endsWith('.result.json')||String(path).endsWith('.tmp'))){
        injected=true;write(path,'{',options);throw Object.assign(Error('full disk'),{code:'ENOSPC'});
      }
      return write(path,data,options);
    }}));
    const registry=await import(${JSON.stringify(resolve(import.meta.dir, "../process-registry.ts"))});
    const scope=registry.createProcessRegistry();
    try{
      const final=registry.processCompletionPath(scope.dir,'runner');
      registry.beginProcessRegistration(scope.dir,'runner',final);armed=true;
      try{registry.publishProcessCompletion(scope.dir,'runner',{exitCode:0,treeWitnessed:true});throw Error('injection missed');}
      catch(error){if(error.code!=='ENOSPC')throw error;}
      if(fs.existsSync(final))throw Error('partial write occupied authoritative path');
      if(registry.processRegistrySnapshot(scope.dir).complete)throw Error('pending write certified completion');
      registry.publishProcessCompletion(scope.dir,'runner',{exitCode:0,treeWitnessed:true});
      if(!registry.processRegistrySnapshot(scope.dir).complete)throw Error('complete retry failed');
      if(fs.readdirSync(scope.dir).some(name=>name.endsWith('.tmp')))throw Error('own failed temporary leaked');
      console.log('retry verified');
    }finally{scope.dispose();}
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("retry verified");
});

for (const firstWitness of [false, true])
  test("an overlapping completion preserves the first terminal authority and foreign temporary", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
      import {mock} from 'bun:test';
      const fs=await import('node:fs');
      const write=fs.writeFileSync,link=fs.linkSync;
      let final;
      mock.module('node:fs',()=>({...fs,linkSync(source,target){
        write(target,JSON.stringify({exitCode:7,treeWitnessed:${firstWitness}}),{flag:'wx'});
        return link(source,target);
      }}));
      const registry=await import(${JSON.stringify(resolve(import.meta.dir, "../process-registry.ts"))});
      const scope=registry.createProcessRegistry();
      try{
        final=registry.processCompletionPath(scope.dir,'runner');
        const foreign=scope.dir+'/foreign.tmp';write(foreign,'other publisher');
        let rejected=false;
        try{registry.publishProcessCompletion(scope.dir,'runner',{exitCode:0,treeWitnessed:${!firstWitness}});}
        catch(error){if(error.code!=='EEXIST')throw error;rejected=true;}
        if(!rejected)throw Error('overlapping authority replaced first result');
        const saved=JSON.parse(fs.readFileSync(final,'utf8'));
        if(saved.exitCode!==7||saved.treeWitnessed!==${firstWitness})throw Error('first result changed');
        if(fs.readFileSync(foreign,'utf8')!=='other publisher')throw Error('foreign temporary removed');
        if(fs.readdirSync(scope.dir).filter(name=>name.endsWith('.tmp')).length!==1)throw Error('own temporary leaked');
        console.log('exclusive commit verified');
      }finally{scope.dispose();}
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toContain("exclusive commit verified");
  });

test("a temporary-name collision never removes another publisher's file", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import {mock} from 'bun:test';
    const crypto=await import('node:crypto');
    mock.module('node:crypto',()=>({...crypto,randomUUID:()=> 'collision'}));
    const fs=await import('node:fs');
    const registry=await import(${JSON.stringify(resolve(import.meta.dir, "../process-registry.ts"))});
    const scope=registry.createProcessRegistry();
    try{
      const final=registry.processCompletionPath(scope.dir,'runner');
      const foreign=final+'.'+process.pid+'.collision.tmp';
      fs.writeFileSync(foreign,'other publisher',{flag:'wx'});
      let rejected=false;
      try{registry.publishProcessCompletion(scope.dir,'runner',{exitCode:0,treeWitnessed:true});}
      catch(error){if(error.code!=='EEXIST')throw error;rejected=true;}
      if(!rejected||fs.existsSync(final))throw Error('collision admitted publication');
      if(fs.readFileSync(foreign,'utf8')!=='other publisher')throw Error('collision deleted foreign temporary');
      console.log('collision retained');
    }finally{scope.dispose();}
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("collision retained");
});
