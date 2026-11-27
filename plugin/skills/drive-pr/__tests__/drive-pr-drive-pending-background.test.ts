/**
 * drive-pr suite: a pass that exits 0 with a task it started still running in
 * the background is restarted, within the drive's pass restart budget,
 * rather than stopped over the fixes it never shipped.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { SCRIPTS, tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";
import { pollUntil, runDrive } from "./drive-loop-harness.ts";
import { trackedTree } from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();
const work = { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] };
const NOTICE = "RESTARTED AFTER A PASS LEFT A BACKGROUND TASK";

/**
 * A pass script that counts its runs in `<name>-count`. A run up to `leave`
 * (with `work`) holds a fix of the current round and leaves it uncommitted,
 * and starts a `sleep` in the background (in a session of its own when
 * `ownSession`, as an agent's shell is), writing its pid to
 * `<name>-pid-<run>`, then exits 0. A
 * later run reports whether it was given the restart notice and leaves a
 * clean tree.
 */
function passScript(
  name: string,
  leave: number,
  ownSession: boolean,
  work = true,
): string {
  const script = join(tmpRoot, `${name}-999.ts`);
  const module = (m: string) =>
    JSON.stringify(pathToFileURL(join(SCRIPTS, "lib/state", `${m}.ts`)).href);
  const base = JSON.stringify(join(tmpRoot, name));
  writeFileSync(
    script,
    [
      `import { openStore } from ${module("store")};`,
      `import { resolveActor } from ${module("actor")};`,
      'import { spawn } from "node:child_process";',
      'import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
      `const base = ${base};`,
      'const counter = base + "-count";',
      'const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;',
      "writeFileSync(counter, String(count));",
      `if ((process.env.DRIVE_PR_PASS_NOTICE ?? "").startsWith(${JSON.stringify(NOTICE)})) console.error("pass for 999: RESTART_" + "NOTICE_" + count);`,
      `if (count <= ${leave}) {`,
      ...(work
        ? [
            '  const store = await openStore("999");',
            "  const actor = await resolveActor();",
            '  await store.update(s => ({ ...s, held: [{ key: "PRRT_a", kind: "thread", outcome: "accepted", commentUrl: "https://github.com/example/project/pull/999#discussion_r1", actor, round: s.rounds }] }));',
            '  writeFileSync("unfinished.txt", "promised fix");',
          ]
        : []),
      '  const pidFile = base + "-pid-" + count;',
      `  spawn("sh", ["-c", 'echo $$ > "$0"; exec sleep 60', pidFile], { detached: ${ownSession}, stdio: "ignore" }).unref();`,
      "  const until = Date.now() + 10_000;",
      "  while (!existsSync(pidFile) && Date.now() < until) await Bun.sleep(20);",
      "} else {",
      '  rmSync("unfinished.txt", { force: true });',
      "}",
    ].join("\n"),
  );
  return script;
}

/** Whether the background `sleep` of run `run` is gone. */
async function backgroundGone(name: string, run: number): Promise<boolean> {
  const file = join(tmpRoot, `${name}-pid-${run}`);
  expect(existsSync(file)).toBe(true);
  const pid = Number(readFileSync(file, "utf8").trim());
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  return (
    (await pollUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 200)) === true
  );
}

describe("a successful pass that left a background task running", () => {
  // The session of its own is found by the token in its environment, which
  // only `/proc` shows; elsewhere the pass's process group alone answers.
  for (const ownSession of process.platform === "linux"
    ? [true, false]
    : [false])
    it(`is restarted once rather than stopped over its unshipped fix${ownSession ? " (the task in a session of its own)" : ""}`, async () => {
      const name = `pending-bg-once-${String(ownSession)}`;
      const script = passScript(name, 1, ownSession);
      const r = await runDrive(
        work,
        ["--no-head-sync", "--max-rounds", "2", "--", process.execPath, script],
        trackedTree(name),
      );
      expectSpawnExit({ ...r, stdout: null }, 6);
      expect(r.stderr).toContain("still running in the background");
      expect(r.stderr).toContain("Stopped them.");
      expect(r.stderr).toContain("pass restart 1 of 2");
      expect(r.stderr).toContain("unfinished.txt");
      expect(r.stderr).toContain("RESTART_NOTICE_2");
      expect(r.stderr).not.toContain("WORKTREE_UNCLEAN");
      expect(await backgroundGone(name, 1)).toBe(true);
    }, 120_000);

  it("restarts only within drive.pass_deadline_retries, then stops as before", async () => {
    const name = "pending-bg-budget";
    const script = passScript(name, 2, false);
    const r = await runDrive(
      work,
      ["--no-head-sync", "--max-rounds", "3", "--", process.execPath, script],
      trackedTree(name),
      { env: { JIG__DRIVE__PASS_DEADLINE_RETRIES: "1" } },
    );
    // The second pass leaves a task as well, past the budget: its task is
    // still stopped, and the drive stops over the unshipped fix.
    expectSpawnExit({ ...r, stdout: null }, 12);
    expect(r.stderr).toContain("pass restart 1 of 1");
    expect(r.stderr).toContain("restart budget is spent (1");
    expect(r.stderr.match(/still running in the background/g)?.length).toBe(2);
    expect(r.stderr).toContain("WORKTREE_UNCLEAN");
    expect(r.stderr).toContain("RESTART_NOTICE_2");
    expect(r.stderr).not.toContain("RESTART_NOTICE_3");
    expect(await backgroundGone(name, 1)).toBe(true);
    expect(await backgroundGone(name, 2)).toBe(true);
  }, 120_000);

  it("is restarted even when it left no work in the tree, since the stopped task may have been validation", async () => {
    const name = "pending-bg-no-work";
    const script = passScript(name, 1, false, false);
    const r = await runDrive(
      work,
      ["--no-head-sync", "--max-rounds", "2", "--", process.execPath, script],
      trackedTree(name),
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(r.stderr).toContain("still running in the background");
    expect(r.stderr).toContain("Stopped them.");
    expect(r.stderr).toContain("pass restart 1 of 2");
    expect(r.stderr).toContain("RESTART_NOTICE_2");
    expect(await backgroundGone(name, 1)).toBe(true);
  }, 120_000);
});
