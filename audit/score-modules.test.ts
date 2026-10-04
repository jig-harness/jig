import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const scratch = mkdtempSync(join(tmpdir(), "groundwork-score-")),
  gate = join(import.meta.dir, "score-modules.ts");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const run = (args: string[]) =>
  Bun.spawnSync([process.execPath, gate, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
test("all module coverage and numeric checklist order", () => {
  expect(run(["--check"]).exitCode).toBe(0);
  const out = run([]).stdout.toString();
  expect(out.indexOf("## M2 ")).toBeLessThan(out.indexOf("## M10 "));
  expect(out).toContain("| Criterion | Level | Requires | Score | Evidence |");
});
test("absent and empty criteria fail coverage", () => {
  expect(run(["--check", scratch]).exitCode).toBe(1);
  mkdirSync(join(scratch, "M0-empty"));
  writeFileSync(
    join(scratch, "M0-empty/maturity.yaml"),
    "module: M0\nname: empty\ncriteria: []\n",
  );
  const proc = run(["--check", scratch]);
  expect(proc.exitCode).toBe(1);
  expect(proc.stdout.toString()).toContain("EMPTY: M0");
});
test("missing directory is a usage error", () =>
  expect(run([join(scratch, "missing")]).exitCode).toBe(2));
