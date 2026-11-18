import { expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

it.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "detached POSIX descendants keep their inherited descriptors",
  ),
)(
  "forwards the leader's output and preserves its exit when a detached descendant holds the pipes",
  async () => {
    const leader = `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", 'setTimeout(() => console.error("descendant output"), 2000)'], {
        detached: true,
        stdio: "inherit",
      }).unref();
      console.log("leader output");
      console.error("leader error");
    `;
    const proc = join(import.meta.dir, "../scripts/lib/proc.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { run } from ${JSON.stringify(proc)};
          const observed = [];
          const result = await run([process.execPath, "-e", ${JSON.stringify(leader)}], {
            stdout: "inherit",
            stderr: "inherit",
            timeoutSec: 1,
            onInheritedOutput: (stream, bytes) => observed.push(stream + ": " + bytes.toString().trim()),
          });
          console.log(JSON.stringify({ ...result, observed }));
          process.exitCode = result.code;
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(stdout).toStartWith("leader output\n");
    expect(stderr).toBe("leader error\n");
    const result = JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(result.timedOut).toBe(false);
    expect(result.observed.sort()).toEqual([
      "stderr: leader error",
      "stdout: leader output",
    ]);
  },
);
