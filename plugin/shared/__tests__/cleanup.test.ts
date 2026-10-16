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
  const module = new URL("../cleanup.ts", import.meta.url).pathname;
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
    const module = new URL("../cleanup.ts", import.meta.url).pathname;
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
      process.kill(process.pid, ${JSON.stringify(signal)});
    `,
    ]);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "stopped",
      "second",
      "first",
    ]);
    expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    expect(result.stderr.toString()).toContain("release failed");
  });
}

test("overlapping cancellation signals wait for all in-flight cancellation work", () => {
  const module = new URL("../cleanup.ts", import.meta.url).pathname;
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
    process.kill(process.pid, 'SIGINT');
    process.kill(process.pid, 'SIGTERM');
  `,
  ]);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "stopped",
    "released",
  ]);
});
