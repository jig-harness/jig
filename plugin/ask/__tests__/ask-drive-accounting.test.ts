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

it("accounting failure preserves forge dispatch and reports unavailable accounting", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-accounting-error-"));
  try {
    const code = `import { traceGhRunner } from ${JSON.stringify(join(import.meta.dir, "../../shared/trace.ts"))};
      const gh = traceGhRunner(async () => ({code: 7, timedOut: false}), () => 1, {});
      console.log(JSON.stringify(await gh(["api"])));`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: { ...process.env, JIG_FORGE_CALL_COUNT_FILE: root },
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

it("keeps a listing and marks its count incomplete when its accounting path disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-accounting-missing-"));
  try {
    const listing = join(root, "listing.ts");
    writeFileSync(
      listing,
      `import { rmSync } from "node:fs";
      import { dirname } from "node:path";
      import { traceGhRunner } from ${JSON.stringify(join(import.meta.dir, "../../shared/trace.ts"))};
      rmSync(dirname(process.env.JIG_FORGE_CALL_COUNT_FILE), {recursive:true, force:true});
      const gh = traceGhRunner(async () => ({code:0, timedOut:false}), () => 1, {});
      await gh(["api"]);
      console.log(JSON.stringify({rows:[]}));`,
    );
    const code = `import { driveRow } from ${JSON.stringify(join(import.meta.dir, "../lib/local.ts"))};
      import { reading } from ${JSON.stringify(join(import.meta.dir, "../lib/reading.ts"))};
      const r = reading(); console.log(JSON.stringify({result:await driveRow(r, process.cwd(), 123), sources:r.sources()}));`;
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
});
