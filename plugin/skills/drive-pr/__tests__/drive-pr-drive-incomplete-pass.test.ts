import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { SCRIPTS, tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";
import { runDrive } from "./drive-loop-harness.ts";
import { trackedTree } from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();
const work = { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] };

describe("a successful pass that left held fixes uncommitted", () => {
  it("disables background tasks in the spawned pass even when inherited as off", async () => {
    const r = await runDrive(
      work,
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        ': pass for 999; echo "background=$CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" >&2',
      ],
      undefined,
      { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(r.stderr).toContain("background=1");
  }, 120_000);

  for (const current of [true, false]) {
    it(current
      ? "stops with WORKTREE_UNCLEAN and names the unfinished held fixes"
      : "does not attribute an older round's hold to this pass", async () => {
      const tree = trackedTree(`incomplete-pass-${current}`);
      const script = join(tmpRoot, `incomplete-pass-${current}-999.ts`);
      const module = (name: string) =>
        JSON.stringify(
          pathToFileURL(join(SCRIPTS, "lib/state", `${name}.ts`)).href,
        );
      writeFileSync(
        script,
        [
          `import { openStore } from ${module("store")};`,
          `import { resolveActor } from ${module("actor")};`,
          'import { writeFileSync } from "node:fs";',
          'const store = await openStore("999");',
          "const actor = await resolveActor();",
          `await store.update(s => ({ ...s, held: [{ key: "PRRT_a", kind: "thread", outcome: "accepted", commentUrl: "https://github.com/example/project/pull/999#discussion_r1", actor, round: ${current ? "s.rounds" : "Math.max(0, s.rounds - 1)"} }] }));`,
          'writeFileSync("unfinished.txt", "promised fix");',
        ].join("\n"),
      );
      const r = await runDrive(
        work,
        ["--no-head-sync", "--max-rounds", "1", "--", process.execPath, script],
        tree,
      );
      expectSpawnExit({ ...r, stdout: null }, current ? 12 : 6);
      if (current) {
        expect(r.stderr).toContain("WORKTREE_UNCLEAN");
        expect(r.stderr).toContain(
          "pass exited 0 before committing held fixes",
        );
        expect(r.stderr).toContain("PRRT_a");
        expect(r.stderr).toContain("unfinished.txt");
        expect(r.stderr).not.toContain("changed NOTHING");
      }
    }, 120_000);
  }
});
