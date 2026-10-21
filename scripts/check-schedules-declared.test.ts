import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSchedulesDeclared } from "./check-schedules-declared.ts";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "jig-schedules-"));
  temporary.push(path);
  return path;
}
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

test("Jig's scheduled workflows are declared, and an undeclared one fails the check", () => {
  expect(checkSchedulesDeclared(root)).toBe(0);
  const dir = temp();
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, ".config"), { recursive: true });
  writeFileSync(
    join(dir, ".github/workflows/cleanup.yml"),
    'on:\n  schedule:\n    - cron: "0 5 * * 1"\njobs: {}\n',
  );
  // No registry: the check could not read what declares the cadence.
  expect(checkSchedulesDeclared(dir)).toBe(2);
  writeFileSync(
    join(dir, ".config/scheduled-jobs.yaml"),
    "jobs:\n  - id: other\n    cadence: 24h\n",
  );
  expect(checkSchedulesDeclared(dir)).toBe(1);
  writeFileSync(
    join(dir, ".config/scheduled-jobs.yaml"),
    "jobs:\n  - id: cleanup\n    cadence: 7d\n",
  );
  expect(checkSchedulesDeclared(dir)).toBe(0);
});
