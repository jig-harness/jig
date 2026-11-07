import { expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

it.each(["overflow", "timeout"])(
  "relays split accounting diagnostics after %s stops capture",
  async (stop) => {
    const script = `
      import { PassThrough } from "node:stream";
      import { captureProcessOutput } from ${JSON.stringify(join(import.meta.dir, "../process-output.ts"))};
      import { FORGE_ACCOUNTING_UNAVAILABLE as marker } from ${JSON.stringify(join(import.meta.dir, "../trace.ts"))};
      const child = { stdout: new PassThrough(), stderr: new PassThrough() };
      let timedOut = false;
      const timers = {};
      const output = captureProcessOutput(child, {maxBufferBytes: ${stop === "overflow" ? 1 : 1024}}, {
        timedOut: () => timedOut, timers, signalTree: () => {}, settle: () => {},
      });
      child.stderr.emit("data", "before");
      if (${JSON.stringify(stop)} === "timeout") timedOut = true;
      child.stderr.emit("data", marker.slice(0, 10));
      child.stderr.emit("data", marker.slice(10));
      child.stderr.emit("data", "z".repeat(8192));
      clearTimeout(timers.escalate);
      console.log(JSON.stringify({stderr:output.stderr, tail:output.tail, overflow:output.bufferExceeded}));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, JIG_FORGE_CALL_COUNT_FILE: "unused-counter" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(stderr).toContain("jig-forge-accounting-unavailable");
    expect(JSON.parse(stdout)).toEqual({
      stderr: "before",
      tail: "z".repeat(4096),
      overflow: stop === "overflow",
    });
  },
);
