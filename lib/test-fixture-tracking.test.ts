import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "./test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "./test-helpers/windows-skip.ts";
import { Defect, swallow } from "../plugin/shared/errors.ts";
import {
  fixtureScopeInventory,
  proveFixtureScope,
} from "../plugin/shared/test-fixture-registry.ts";

const TMPDIR = resolve(import.meta.dir, "test-tmpdir.ts");
const PROBES = resolve(import.meta.dir, "../plugin/shared/process-table.ts");
const REGISTRY = resolve(
  import.meta.dir,
  "../plugin/shared/test-fixture-registry.ts",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(startup = true) {
  const base = mkdtempSync(join(tmpdir(), "fixture-membership-"));
  roots.push(base);
  const home = join(base, "home");
  mkdirSync(home);
  const config = join(base, "bunfig.toml");
  writeFileSync(config, "");
  const store = join(home, ".local/state/jig/test-fixtures-v1");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: base,
    TMP: base,
    TEMP: base,
  };
  const prefix = `delete process.env.JIG_TEST_FIXTURE_REGISTRY; delete process.env.JIG_TEST_FIXTURE_NODE;
    const { scopeTestTmpdir } = await import(${JSON.stringify(TMPDIR)});
    const { fixtureScopeInventory } = await import(${JSON.stringify(REGISTRY)});
    const scope = scopeTestTmpdir({ fixtureStartup: ${startup} });
    const fixtureArgs=(...args)=>[process.execPath,'--no-env-file','--config='+${JSON.stringify(config)},...args];`;
  return {
    base,
    home,
    config,
    store,
    env,
    prefix,
    argv: (source: string) => {
      const file = join(base, "runner.ts");
      writeFileSync(file, prefix + source);
      // `run` is intentionally opaque to the outer test process. This
      // isolated runner starts its own registry after clearing that context.
      return [
        process.execPath,
        "--no-env-file",
        `--config=${config}`,
        "run",
        file,
      ];
    },
  };
}

function runFixtureSource(f: ReturnType<typeof fixture>, source: string) {
  const result = Bun.spawnSync(f.argv(source), {
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(result, 0);
  return result;
}
function inventory(store: string) {
  const result = fixtureScopeInventory(store);
  if (!result.ok) throw new Defect(result.failure.reason);
  return result.value;
}
function firstScope(store: string) {
  const scope = inventory(store)[0];
  if (!scope) throw new Defect("fixture scope was not registered");
  return scope;
}
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Defect(`Deadline waiting for ${label}`);
    await Bun.sleep(20);
  }
}

test("a killed runner leaves durable membership outside its disposable scope", async () => {
  const f = fixture();
  const ready = join(f.base, "ready");
  const child = Bun.spawn(
    f.argv(
      `await Bun.write(${JSON.stringify(ready)}, scope.root); setInterval(() => {}, 1000);`,
    ),
    { env: f.env, stdout: "pipe", stderr: "pipe" },
  );
  try {
    await until(() => existsSync(ready), "scope publication");
    const records = inventory(f.store);
    expect(records).toHaveLength(1);
    const scope = firstScope(f.store);
    expect(scope.registry.startsWith(scope.root)).toBe(false);
    expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
      "live",
    );
    child.kill();
    await child.exited;
    expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
      "dead",
    );
  } finally {
    child.kill();
    await child.exited;
  }
}, 30000);

test("ownership probes do not turn a closed runner into an opaque native tree", async () => {
  const f = fixture();
  const result = Bun.spawnSync(
    f.argv(
      `const { processTable } = await import(${JSON.stringify(PROBES)}); await processTable(); console.log(scope.root);`,
    ),
    { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 20000 },
  );
  expectSpawnExit(result, 0);
  const scope = firstScope(f.store);
  expect(scope).toBeDefined();
  expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
    "dead",
  );
}, 30000);

test("implicit children preserve the startup environment while explicit children receive live changes", () => {
  const f = fixture();
  const source = `process.env.JIG_FIXTURE_SAMPLE='after';
    const program="console.log(process.env.JIG_FIXTURE_SAMPLE);";
    const implicit=Bun.spawnSync(fixtureArgs('-e',program),{stdout:'pipe',stderr:'pipe'});
    const explicit=Bun.spawnSync(fixtureArgs('-e',program),{env:{...process.env},stdout:'pipe',stderr:'pipe'});
    const {spawnSync}=await import('node:child_process');
    const node=spawnSync(process.execPath,fixtureArgs('-e',program).slice(1),{encoding:'utf8'});
    if(implicit.exitCode!==0||explicit.exitCode!==0){process.stderr.write(implicit.stderr);process.stderr.write(explicit.stderr);process.exit(1);}
    if(node.status!==0){process.stderr.write(node.stderr);process.exit(1);}
    console.log(JSON.stringify([implicit.stdout.toString().trim(),explicit.stdout.toString().trim(),node.stdout.trim()]));`;
  const result = Bun.spawnSync(f.argv(source), {
    env: { ...f.env, JIG_FIXTURE_SAMPLE: "before" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toEqual([
    "before",
    "after",
    "after",
  ]);
}, 30000);

test("a late first helper and a later startup claim preserve native implicit environment behavior", async () => {
  const f = fixture(false);
  const program = `const command=[process.execPath,'-e',"console.log(process.env.JIG_FIXTURE_SAMPLE);"];
    const first=Bun.spawnSync(command,{stdout:'pipe',stderr:'pipe'});
    const later=scopeTestTmpdir({fixtureStartup:true});
    const second=Bun.spawnSync(command,{stdout:'pipe',stderr:'pipe'});
    if(first.exitCode!==0||second.exitCode!==0)process.exit(1);
    console.log(JSON.stringify([first.stdout.toString().trim(),second.stdout.toString().trim()]));`;
  const args = f.argv(program);
  const file = join(f.base, "runner.ts");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "const { scopeTestTmpdir } = await import",
      "process.env.JIG_FIXTURE_SAMPLE='after'; const { scopeTestTmpdir } = await import",
    ),
  );
  const result = Bun.spawnSync(args, {
    env: { ...f.env, JIG_FIXTURE_SAMPLE: "before" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toEqual(["before", "before"]);
  const scope = firstScope(f.store);
  expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
    "unverified",
  );
}, 30000);

test("an isolated file fixture preserves relative imports and closes its membership", async () => {
  const f = fixture();
  const source = `const fs=require('node:fs');
    fs.writeFileSync(scope.root+'/value.ts',"export const value='closed';");
    fs.writeFileSync(scope.root+'/program.ts',"import {value} from './value.ts';console.log(value);");
    const child=Bun.spawnSync(fixtureArgs('./program.ts'),{cwd:scope.root,env:process.env,stdout:'pipe',stderr:'pipe'});
    if(child.exitCode!==0){process.stderr.write(child.stderr);process.exit(1);}process.stdout.write(child.stdout);`;
  const result = runFixtureSource(f, source);
  expect(result.stdout.toString().trim()).toBe("closed");
  const scope = firstScope(f.store);
  expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
    "dead",
  );
}, 30000);

test("an opaque launch preserves an application argument that also names the original config", async () => {
  const f = fixture();
  const original = `--config=${f.config}`;
  const source = `const fs=require('node:fs');const file=scope.root+'/argv.ts';
    fs.writeFileSync(file,'console.log(process.argv[2]);');
    const child=Bun.spawnSync(fixtureArgs(file,${JSON.stringify(original)}),{env:process.env,stdout:'pipe',stderr:'pipe'});
    if(child.exitCode!==0){process.stderr.write(child.stderr);process.exit(1);}process.stdout.write(child.stdout);`;
  const result = runFixtureSource(f, source);
  expect(result.stdout.toString().trim()).toBe(original);
  const scope = firstScope(f.store);
  expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
    "unverified",
  );
}, 30000);

test("a trailing Bun runtime flag cannot override the bootstrap config and close membership", async () => {
  const f = fixture();
  const source = `const fs=require('node:fs');const config=scope.root+'/hooks.toml';const hook=scope.root+'/hook.ts';
    fs.writeFileSync(hook,"Bun.spawnSync([process.execPath,'--version']);");
    fs.writeFileSync(config,'preload=['+JSON.stringify(hook)+']');
    const child=Bun.spawnSync(fixtureArgs('-e','0','--config='+config),{env:process.env,stdout:'pipe',stderr:'pipe'});
    if(child.exitCode!==0){process.stderr.write(child.stderr);process.exit(1);}`;
  runFixtureSource(f, source);
  const scope = firstScope(f.store);
  const proof = await proveFixtureScope(scope.root, scope.registry);
  expect(proof.state).toBe("unverified");
  expect(proof.reason).toContain("opaque native launch");
}, 30000);

test("a native child remains opaque after its parent and immediate child exit", async () => {
  const f = fixture();
  const result = Bun.spawnSync(
    f.argv(
      `const result = Bun.spawnSync([process.execPath, '--version']); if (result.exitCode !== 0) process.exit(1);`,
    ),
    { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 20000 },
  );
  expectSpawnExit(result, 0);
  const scope = firstScope(f.store);
  const proof = await proveFixtureScope(scope.root, scope.registry);
  expect(proof.state).toBe("unverified");
  expect(proof.reason).toContain("opaque native launch");
}, 30000);

function nestedProgram(program: string): string {
  return `const child=Bun.spawnSync(fixtureArgs('-e',${JSON.stringify(program)}),{env:process.env});if(child.exitCode!==0)process.exit(1);`;
}
test.each([
  [
    "node subprocess",
    "const {spawnSync}=await import('node:child_process');spawnSync(process.execPath,['--version']);",
  ],
  ["configured Bun shell", "await Bun.$.cwd(process.cwd())`echo fixture`;"],
  [
    "node worker",
    "const {Worker}=await import('node:worker_threads');const worker=new Worker('0',{eval:true});await new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject);});",
  ],
  [
    "statically imported node worker",
    nestedProgram(
      "import {Worker} from 'node:worker_threads';const worker=new Worker('0',{eval:true});await new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject);});",
    ),
  ],
  [
    "statically imported Bun shell",
    nestedProgram("import {$} from 'bun';await $`echo fixture`;"),
  ],
  [
    "statically imported Bun spawn",
    nestedProgram(
      "import {spawnSync} from 'bun';spawnSync([process.execPath,'--version']);",
    ),
  ],
])(
  "%s keeps descendant membership opaque",
  async (_name, program) => {
    const f = fixture();
    const result = Bun.spawnSync(f.argv(program), {
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    });
    expectSpawnExit(result, 0);
    const scope = firstScope(f.store);
    const proof = await proveFixtureScope(scope.root, scope.registry);
    expect(proof.state).toBe("unverified");
    expect(proof.reason).toContain("opaque native launch");
  },
  30000,
);

test("a first scope created after program startup cannot claim earlier child membership", async () => {
  const f = fixture(false);
  const result = Bun.spawnSync(f.argv("console.log(scope.root);"), {
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(result, 0);
  const scope = firstScope(f.store);
  const proof = await proveFixtureScope(scope.root, scope.registry);
  expect(proof.state).toBe("unverified");
  expect(proof.reason).toContain("earlier child membership is unknown");
}, 30000);

test("a nested test runner's earlier configured preload keeps its membership opaque", async () => {
  const f = fixture();
  const program = `
    const fs=require('node:fs'); const path=scope.root+'/nested-tests';fs.mkdirSync(path);
    fs.writeFileSync(path+'/bunfig.toml','[test]\\npreload=["./before.ts"]\\n');
    fs.writeFileSync(path+'/before.ts',"Bun.spawnSync([process.execPath,'--version']);");
    fs.writeFileSync(path+'/probe.test.ts',"import {test} from 'bun:test';test('probe',()=>{});");
    const run=Bun.spawnSync([process.execPath,'test','probe.test.ts'],{cwd:path,env:process.env,stdout:'pipe',stderr:'pipe'});
    if(run.exitCode!==0){process.stderr.write(run.stderr);process.exit(1);}`;
  const result = Bun.spawnSync(f.argv(program), {
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(result, 0);
  const scope = firstScope(f.store);
  const proof = await proveFixtureScope(scope.root, scope.registry);
  expect(proof.state).toBe("unverified");
  expect(proof.reason).toContain("opaque native launch");
}, 30000);

test.skipIf(
  skipsOnWindows(
    "file-system",
    "POSIX permissions do not simulate a read-only home on Windows",
  ) || process.getuid?.() === 0,
)(
  "an isolated read-only home keeps scratch usable without inventing membership",
  () => {
    const f = fixture();
    const args = f.argv("console.log(scope.root); scope.release();");
    const file = join(f.base, "runner.ts");
    const source = readFileSync(file, "utf8").replace(
      "const scope = scopeTestTmpdir",
      "require('node:fs').chmodSync(process.env.HOME, 0o500); const scope = scopeTestTmpdir",
    );
    writeFileSync(file, source);
    try {
      const result = Bun.spawnSync(args, {
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20000,
      });
      expectSpawnExit(result, 0);
      expect(result.stderr.toString()).toContain("scope remains report-only");
    } finally {
      chmodSync(f.home, 0o700);
    }
    expect(inventory(f.store)).toEqual([]);
  },
  30000,
);

test.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "Bun's Windows job ends the registered grandchild when its parent exits",
  ),
)(
  "a registered Bun child can recreate a released root without losing membership",
  async () => {
    const f = fixture();
    const ready = join(f.base, "child-ready");
    const recreate = join(f.base, "recreate");
    const childPid = join(f.base, "child-pid");
    const source = `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(childPid)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(recreate)})) {
      fs.mkdirSync(process.env.FIXTURE_SCRATCH, {recursive:true});
      fs.writeFileSync(process.env.FIXTURE_SCRATCH + '/recreated', 'alive');
    } }, 20);`;
    const parent = Bun.spawn(
      f.argv(`
    Bun.spawn(fixtureArgs('-e', ${JSON.stringify(source)}), {env:{...process.env, FIXTURE_SCRATCH:scope.root}, stdout:'ignore', stderr:'ignore'});
    const fs = require('node:fs');
    while (!fs.existsSync(${JSON.stringify(ready)})) await Bun.sleep(20);
    scope.release();
    fs.writeFileSync(${JSON.stringify(recreate)}, 'go');
    setInterval(() => {}, 1000);`),
      { env: f.env, stdout: "pipe", stderr: "pipe" },
    );
    let pid: number | undefined;
    try {
      await until(
        () => existsSync(childPid) && existsSync(recreate),
        "child registration and parent release",
      );
      pid = Number(readFileSync(childPid, "utf8"));
      const scope = firstScope(f.store);
      await until(
        () => existsSync(join(scope.root, "recreated")),
        "root recreation",
      );
      expect(readdirSync(scope.root)).toEqual(["recreated"]);
      parent.kill();
      await parent.exited;
      expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
        "live",
      );
      process.kill(pid, "SIGKILL");
      await until(
        async () =>
          (await proveFixtureScope(scope.root, scope.registry)).state ===
          "dead",
        "child exit",
      );
      expect((await proveFixtureScope(scope.root, scope.registry)).state).toBe(
        "dead",
      );
    } finally {
      parent.kill();
      await parent.exited;
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          swallow(error, "the fixture child has already exited");
        }
    }
  },
  45000,
);
