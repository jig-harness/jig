import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

it("scopes a drive listing to its PR and includes nested forge calls in the answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-drive-accounting-"));
  try {
    const listing = join(root, "listing.ts");
    const trace = join(import.meta.dir, "../../shared/trace.ts");
    writeFileSync(
      listing,
      `import { traceGhRunner } from ${JSON.stringify(trace)};
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--json", "--pr", "123"])) process.exit(2);
      const gh = traceGhRunner(async () => ({code: 0, timedOut: false}), () => 1, {});
      await gh(["api"]); await gh(["pr", "view"]);
      console.log(JSON.stringify({rows: []}));`,
    );
    const code = `import { driveRow } from ${JSON.stringify(join(import.meta.dir, "../lib/local.ts"))};
      import { reading } from ${JSON.stringify(join(import.meta.dir, "../lib/reading.ts"))};
      const r = reading(); const result = await driveRow(r, process.cwd(), 123);
      console.log(JSON.stringify({result, calls:r.sources().forgeCalls}));`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: { ...process.env, JIG_ASK_DRIVES_SCRIPT: listing },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(JSON.parse(stdout)).toEqual({
      result: { ok: true, value: null },
      calls: 2,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
