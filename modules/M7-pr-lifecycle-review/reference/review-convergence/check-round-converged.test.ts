import { test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad-reviewer-line.txt", 2, "token"],
  ["bad-reviewer-state.txt", 2, "token"],
  ["bad-state.txt", 2, "token"],
  ["converged.txt", 0, "token"],
  ["double-counted-bot.txt", 3, "token"],
  ["duplicate-reviewer.txt", 2, "token"],
  ["empty-then-dup-open_threads.txt", 2, "token"],
  ["empty-then-dup-pr_state.txt", 2, "token"],
  ["empty-then-dup-round.txt", 2, "token"],
  ["empty-value.txt", 2, "token"],
  ["leading-zero.txt", 2, "token"],
  ["missing-key.txt", 2, "token"],
  ["no-reviewers.txt", 2, "token"],
  ["non-numeric.txt", 2, "token"],
  ["pr-closed.txt", 4, "token"],
  ["pr-merged.txt", 4, "token"],
  ["reviewer-pending.txt", 3, "token"],
  ["round-zero.txt", 2, "token"],
  ["threads-open.txt", 1, "token"],
  ["unknown-key.txt", 2, "token"],
  ["work-before-wait.txt", 1, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-round-converged.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expectSpawnExit(run, code);
  });
