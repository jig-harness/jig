import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = join(import.meta.dir, "../trace.ts");

test("nested and child spans share a trace without capturing command data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-trace-"));
  const file = join(dir, "trace.jsonl");
  const childDir = join(dir, "child");
  mkdirSync(childDir);
  try {
    const script = `import { span } from ${JSON.stringify(modulePath)};
      import { run } from ${JSON.stringify(join(import.meta.dir, "../proc.ts"))};
      await span('drive', {}, async () => {
        await run([process.execPath, '-e', ${JSON.stringify(`import { span } from ${JSON.stringify(modulePath)}; await span('child', {}, async () => {});`)}], { cwd: ${JSON.stringify(childDir)}, stdin: 'private-input' });
        await run([process.execPath, '-e', 'console.log("private-output")']);
      });`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, JIG_TRACE_FILE: "trace.jsonl", TRACEPARENT: "" },
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const content = readFileSync(file, "utf8");
    const rows = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.name).sort()).toEqual([
      "child",
      "drive",
      "run",
      "run",
    ]);
    expect(new Set(rows.map((row) => row.trace_id)).size).toBe(1);
    const drive = rows.find((row) => row.name === "drive");
    const runs = rows.filter((row) => row.name === "run");
    expect(runs.every((row) => row.parent_id === drive.span_id)).toBe(true);
    expect(
      runs.some(
        (row) =>
          row.span_id === rows.find((row) => row.name === "child").parent_id,
      ),
    ).toBe(true);
    expect(content).not.toContain("private-");
    expect(
      rows.every((row) => row.duration_ms >= 0 && row.status === "ok"),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace retention keeps the boundary day and ignores links and unknown names", async () => {
  const { mkdirSync, existsSync, symlinkSync } = await import("node:fs");
  const { reapTraceDays } = await import("../trace.ts");
  const dir = mkdtempSync(join(tmpdir(), "jig-trace-retain-"));
  try {
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-16", "unknown"])
      mkdirSync(join(dir, day));
    symlinkSync(join(dir, "unknown"), join(dir, "2026-09-01"));
    expect(
      reapTraceDays(false, Date.parse("2026-10-16T12:00:00Z"), dir).days,
    ).toEqual(["2026-10-01"]);
    expect(existsSync(join(dir, "2026-10-01"))).toBe(true);
    expect(
      reapTraceDays(true, Date.parse("2026-10-16T12:00:00Z"), dir).failures,
    ).toEqual([]);
    expect(existsSync(join(dir, "2026-10-01"))).toBe(false);
    expect(existsSync(join(dir, "2026-10-02"))).toBe(true);
    expect(existsSync(join(dir, "unknown"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace retention tolerates a day another reaper removed first", async () => {
  const { mkdirSync, existsSync } = await import("node:fs");
  const { reapTraceDays } = await import("../trace.ts");
  const dir = mkdtempSync(join(tmpdir(), "jig-trace-race-"));
  try {
    mkdirSync(join(dir, "2026-10-01"));
    mkdirSync(join(dir, "2026-09-30"));
    const now = Date.parse("2026-10-16T12:00:00Z");
    const vanished = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(
      reapTraceDays(true, now, dir, () => {
        throw vanished;
      }).failures,
    ).toEqual([]);
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(
      reapTraceDays(true, now, dir, () => {
        throw denied;
      }).failures,
    ).toEqual([
      "could not remove trace day 2026-09-30",
      "could not remove trace day 2026-10-01",
    ]);
    // The default remover removes a day that is already gone without failing.
    rmSync(join(dir, "2026-10-01"), { recursive: true });
    const result = reapTraceDays(true, now, dir);
    expect(result.failures).toEqual([]);
    expect(existsSync(join(dir, "2026-09-30"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled spans do not emit files and tracing failures preserve operation results", async () => {
  const childScript = `import { span } from ${JSON.stringify(modulePath)};
    const answer = await span('disabled', {}, () => 42);
    if (answer !== 42) process.exit(2);`;
  const child = Bun.spawn([process.execPath, "-e", childScript], {
    env: { ...process.env, JIG_TRACE: "", JIG_TRACE_FILE: "", TRACEPARENT: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), "jig-trace-error-"));
  try {
    const failed = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { span } from ${JSON.stringify(modulePath)};
      const answer = await span('write-fails', {}, () => 42);
      if (answer !== 42) process.exit(2);
      try { await span('throws', {}, () => { throw new Error('private-error'); }); process.exit(3); }
      catch (error) { if (error.message !== 'private-error') process.exit(4); }`,
      ],
      {
        env: { ...process.env, JIG_TRACE_FILE: dir, TRACEPARENT: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await failed.exited).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed operations record error status without recording their error text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-trace-status-"));
  const file = join(dir, "trace.jsonl");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { span } from ${JSON.stringify(modulePath)};
      try { await span('failed', {}, () => { throw new Error('private-error'); }); } catch {}`,
      ],
      {
        env: { ...process.env, JIG_TRACE_FILE: file, TRACEPARENT: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    const content = readFileSync(file, "utf8");
    expect(JSON.parse(content).status).toBe("error");
    expect(content).not.toContain("private-error");
    const disabled = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { span } from ${JSON.stringify(modulePath)}; await span('disabled', {}, () => 1);`,
      ],
      {
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          JIG_TRACE: "",
          JIG_TRACE_FILE: "",
          TRACEPARENT: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await disabled.exited).toBe(0);
    expect(existsSync(join(dir, ".local", "state", "jig", "traces"))).toBe(
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
