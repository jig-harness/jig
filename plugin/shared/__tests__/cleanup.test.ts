import { fileURLToPath } from "node:url";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { expect, test } from "bun:test";
import { registerCleanup } from "../cleanup.ts";

test("scoped cleanup is idempotent and detaches before executing", () => {
  const calls: number[] = [];
  {
    using cleanup = registerCleanup(() => calls.push(1));
    cleanup[Symbol.dispose]();
  }
  expect(calls).toEqual([1]);
});

test("process exit releases live registrations newest first", () => {
  const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import { registerCleanup } from ${JSON.stringify(module)};
    registerCleanup(() => console.log('first'));
    registerCleanup(() => { console.log('second'); throw new Error('cleanup failed'); });
    registerCleanup(() => console.log('third'));
    process.exit(0);
  `,
  ]);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "third",
    "second",
    "first",
  ]);
});

test("a growing resource count uses one process handler", () => {
  const before = process.listenerCount("SIGTERM");
  let disposed = 0;
  {
    using stack = new DisposableStack();
    for (let i = 0; i < 30; i++)
      stack.use(
        registerCleanup(() => {
          disposed++;
        }),
      );
    expect(process.listenerCount("SIGTERM")).toBe(before);
  }
  expect(disposed).toBe(30);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} awaits cancellation before releasing live resources in order`, () => {
    const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
    const result = Bun.spawnSync([
      process.execPath,
      "-e",
      `
      import { registerCleanup, registerSignalHandler } from ${JSON.stringify(module)};
      registerCleanup(() => console.log('first'));
      registerCleanup(() => { console.log('second'); throw new Error('release failed'); });
      registerSignalHandler(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        console.log('stopped');
      });
      setInterval(() => {}, 1000);
      if (process.platform === "win32") process.emit(${JSON.stringify(signal)});
      else process.kill(process.pid, ${JSON.stringify(signal)});
    `,
    ]);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "stopped",
      "second",
      "first",
    ]);
    expectSpawnExit(result, signal === "SIGINT" ? 130 : 143);
    expect(result.stderr.toString()).toContain("release failed");
  });
}

test("overlapping cancellation signals wait for all in-flight cancellation work", () => {
  const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import { registerCleanup, registerSignalHandler } from ${JSON.stringify(module)};
    registerCleanup(() => console.log('released'));
    let stopping = false;
    registerSignalHandler(() => {
      if (stopping) return;
      stopping = true;
      return new Promise(resolve => setImmediate(() => {
        console.log('stopped');
        resolve();
      }));
    });
    setInterval(() => {}, 1000);
    if (process.platform === "win32") {
      process.emit("SIGINT");
      process.emit("SIGTERM");
    } else {
      process.kill(process.pid, "SIGINT");
      process.kill(process.pid, "SIGTERM");
    }
  `,
  ]);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "stopped",
    "released",
  ]);
});

test("Windows console break awaits cleanup and exits without re-raising a POSIX signal", () => {
  const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { registerCleanup, registerSignalHandler } = await import(${JSON.stringify(module)});
    registerCleanup(() => console.log('released'));
    registerSignalHandler(async () => { await Promise.resolve(); console.log('stopped'); });
    process.kill = () => { throw new Error('must not re-raise'); };
    process.emit('SIGBREAK');
  `,
  ]);
  expectSpawnExit(result, 149);
  expect(result.stdout.toString().trim()).toBe("stopped\nreleased");
});

test("cooperative shutdown awaits every cancellation before resource release", () => {
  const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import {registerCleanup,registerSignalHandler,requestShutdown} from ${JSON.stringify(module)};
    const resource=registerCleanup(()=>console.log('released'));
    registerSignalHandler(async()=>{await new Promise(resolve=>setImmediate(resolve));console.log('helper stopped');});
    registerSignalHandler(()=>console.log('driver stopped'));
    requestShutdown('SIGTERM',23);
    resource[Symbol.dispose]();
  `,
  ]);
  expectSpawnExit(result, 23);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "driver stopped",
    "helper stopped",
    "released",
  ]);
});

test("signal-driven scope unwind defers resources until sibling cancellation settles", () => {
  const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import {registerCleanup,registerSignalHandler} from ${JSON.stringify(module)};
    async function main(){
      using first=registerCleanup(()=>console.log('first'));
      using second=registerCleanup(()=>console.log('second'));
      await new Promise(resolve=>{
        registerSignalHandler(async()=>{await new Promise(done=>setImmediate(done));console.log('helper stopped');});
        registerSignalHandler(()=>resolve());
        if(process.platform==='win32') process.emit('SIGTERM');
        else process.kill(process.pid,'SIGTERM');
      });
    }
    await main();
  `,
  ]);
  expectSpawnExit(result, 143);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "helper stopped",
    "second",
    "first",
  ]);
});

test("synchronous callback disposal waits for cancellation callbacks not yet started", () => {
  const module = fileURLToPath(new URL("../cleanup.ts", import.meta.url));
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import {registerCleanup,registerSignalHandler,requestShutdown} from ${JSON.stringify(module)};
    const first=registerCleanup(()=>console.log('first'));
    const second=registerCleanup(()=>{console.log('second');throw Error('deferred failure');});
    registerSignalHandler(async()=>{await new Promise(done=>setImmediate(done));console.log('helper stopped');});
    registerSignalHandler(()=>{second[Symbol.dispose]();first[Symbol.dispose]();});
    requestShutdown('SIGTERM',29);
  `,
  ]);
  expectSpawnExit(result, 29);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "helper stopped",
    "second",
    "first",
  ]);
  expect(result.stderr.toString()).toContain("deferred failure");
});
