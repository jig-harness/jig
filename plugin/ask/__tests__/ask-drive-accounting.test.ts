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
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        JIG_ASK_DRIVES_SCRIPT: listing,
      },
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

it("accounting failure preserves forge dispatch and reports unavailable accounting", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-accounting-error-"));
  try {
    const code = `import { traceGhRunner } from ${JSON.stringify(join(import.meta.dir, "../../shared/trace.ts"))};
      const gh = traceGhRunner(async () => ({code: 7, timedOut: false}), () => 1, {});
      console.log(JSON.stringify(await gh(["api"])));`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        JIG_FORGE_CALL_COUNT_FILE: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(JSON.parse(stdout)).toEqual({ code: 7, timedOut: false });
    expect(stderr).toContain("forge call accounting unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["pipe", "ignore", "inherit"] as const)(
  "keeps a listing and marks its count incomplete across nested %s stderr",
  async (stderrMode) => {
    const root = mkdtempSync(join(tmpdir(), "ask-accounting-missing-"));
    try {
      const listing = join(root, "listing.ts");
      writeFileSync(
        listing,
        `import { run, tsArgv } from ${JSON.stringify(join(import.meta.dir, "../../skills/drive-pr/scripts/lib/proc.ts"))};
      const helper = ${JSON.stringify(join(root, "middle.ts"))};
      const result = await run(tsArgv(helper, []), {stderr: ${JSON.stringify(stderrMode)}, timeoutSec: 10});
      if (result.code !== 0 || (${JSON.stringify(stderrMode)} !== "pipe" && result.stderr !== "")) process.exit(3);
      console.log(JSON.stringify({rows:[]}));`,
      );
      writeFileSync(
        join(root, "middle.ts"),
        `import { run, tsArgv } from ${JSON.stringify(join(import.meta.dir, "../../shared/proc.ts"))};
        const result = await run(tsArgv(${JSON.stringify(join(root, "helper.ts"))}, []), {stderr: ${JSON.stringify(stderrMode)}, timeoutSec: 10});
        process.exit(result.code);`,
      );
      writeFileSync(
        join(root, "helper.ts"),
        `import { rmSync } from "node:fs";
      import { dirname } from "node:path";
      import { traceGhRunner } from ${JSON.stringify(join(import.meta.dir, "../../shared/trace.ts"))};
      rmSync(dirname(process.env.JIG_FORGE_CALL_COUNT_FILE), {recursive:true, force:true});
      const gh = traceGhRunner(async () => ({code:0, timedOut:false}), () => 1, {});
      await gh(["api"]);
      console.error("unrelated diagnostic");`,
      );
      const code = `import { driveRow } from ${JSON.stringify(join(import.meta.dir, "../lib/local.ts"))};
      import { reading } from ${JSON.stringify(join(import.meta.dir, "../lib/reading.ts"))};
      const r = reading(); console.log(JSON.stringify({result:await driveRow(r, process.cwd(), 123), sources:r.sources()}));`;
      const child = Bun.spawn([process.execPath, "-e", code], {
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          JIG_ASK_DRIVES_SCRIPT: listing,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expectSpawnExit({ stdout, stderr, exitCode }, 0);
      expect(stderr).not.toContain("unrelated diagnostic");
      const answer = JSON.parse(stdout);
      expect(answer.result).toEqual({ ok: true, value: null });
      expect(answer.sources.records).toContainEqual({
        record: "drive forge call accounting",
        read: false,
        detail: "forge call count is incomplete: accounting unavailable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const runner of [
  "../../shared/proc.ts",
  "../../skills/drive-pr/scripts/lib/proc.ts",
]) {
  it.each([0, 7])(
    `preserves ignored output with accounting in ${runner} (exit %i)`,
    async (code) => {
      const root = mkdtempSync(join(tmpdir(), "ask-accounting-ignore-"));
      try {
        const script = `import { run } from ${JSON.stringify(join(import.meta.dir, runner))};
        const result = await run([process.execPath, "-e", 'process.stderr.write("x".repeat(65 * 1024 * 1024)); process.exitCode = ${code}'], {stderr:"ignore", timeoutSec:10});
        console.log(JSON.stringify(result));`;
        const child = Bun.spawn([process.execPath, "-e", script], {
          env: {
            ...process.env,
            JIG_FORGE_CALL_COUNT_FILE: join(root, "count"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expectSpawnExit({ stdout, stderr, exitCode }, 0);
        expect(JSON.parse(stdout)).toMatchObject({
          code,
          stderr: "",
          stderrTail: "",
          timedOut: false,
          bufferExceeded: false,
        });
        expect(stderr).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
