import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["abort.txt", 3, "token"],
  ["bad-decision.txt", 2, "token"],
  ["contradictory-abort.txt", 2, "token"],
  ["contradictory-converged-pending.txt", 2, "token"],
  ["contradictory-converged-threads.txt", 2, "token"],
  ["contradictory-converged.txt", 2, "token"],
  ["contradictory-wait.txt", 2, "token"],
  ["contradictory-work.txt", 2, "token"],
  ["converged-hard.txt", 0, "token"],
  ["converged-ordinary.txt", 3, "token"],
  ["empty.txt", 2, "token"],
  ["multiple-records.txt", 2, "token"],
  ["no-round.txt", 2, "token"],
  ["over-reported.txt", 2, "token"],
  ["partial-record.txt", 2, "token"],
  ["work.txt", 3, "token"],
  ["zero-reviewers.txt", 2, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const temp = mkdtempSync(join(tmpdir(), "reflection-test-"));
    env.CHANGE = "PR-482";
    env.INBOX = join(temp, "inbox.md");
    writeFileSync(env.INBOX, "# Reflection inbox\n");
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "reflection-trigger.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
    rmSync(temp, { recursive: true, force: true });
  });
