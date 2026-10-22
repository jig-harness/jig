import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

test("an enumerated policy environment can refuse ambient trace propagation", () => {
  const directory = mkdtempSync(join(tmpdir(), "jig-proc-isolation-"));
  try {
    const runner = join(directory, "runner.ts");
    writeFileSync(
      runner,
      `import {run} from ${JSON.stringify(new URL("../proc.ts", import.meta.url).href)};import {withoutTracePropagation} from ${JSON.stringify(new URL("../trace.ts", import.meta.url).href)};\nconst env={...process.env};for(const key of ['JIG_TRACE','JIG_TRACE_FILE','TRACEPARENT'])delete env[key];\nconst execute=()=>run([process.execPath,'-e',"console.log(JSON.stringify({trace:process.env.JIG_TRACE,parent:process.env.TRACEPARENT}))"],{env,timeoutSec:5});const result=await (process.argv[2] === 'false' ? withoutTracePropagation(execute) : execute());process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.code;`,
    );
    for (const inherit of ["false", "true"]) {
      const result = Bun.spawnSync([process.execPath, runner, inherit], {
        env: {
          ...process.env,
          JIG_TRACE: "1",
          JIG_TRACE_FILE: join(directory, "trace.jsonl"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(result, 0);
      const output = JSON.parse(result.stdout.toString());
      if (inherit === "false") expect(output).toEqual({});
      else {
        expect(output.trace).toBe("1");
        expect(output.parent).toMatch(/^00-/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
