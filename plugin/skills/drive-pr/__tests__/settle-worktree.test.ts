import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  makeScratchRepo,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn } from "./drive-loop-harness.ts";

useDrivePrSuite();

describe("exit-12 worktree settlement", () => {
  for (const clean of [true, false]) {
    it(`runs one settlement pass on a converged head, then ${clean ? "certifies the clean tree" : "keeps exit 12 for leftovers"}`, async () => {
      const tree = makeScratchRepo("scratch-settle-worktree");
      const leftover = join(tree.dir, "leftover.txt");
      writeFileSync(leftover, "unshipped work\n");
      const { dir, stateDir } = writeFixture(
        { threads: [], reviewedSha: tree.head, head: tree.head },
        tree.dir,
      );
      const proof = join(dir, "settlement-proof");
      const pass = [
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.SETTLE_PROOF, process.env.DRIVE_PR_PASS_NOTICE + '\\n');",
        ...(clean ? ["fs.unlinkSync('leftover.txt');"] : []),
      ].join("\n");
      const result = await runDriveIn(
        dir,
        stateDir,
        [
          "--no-head-sync",
          "--settle-worktree",
          "--",
          process.execPath,
          "-e",
          pass,
          "/jig:drive-pr 999",
        ],
        tree.dir,
        { env: { SETTLE_PROOF: proof } },
      );
      expectSpawnExit({ ...result, stdout: "" }, clean ? 0 : 12);
      expect(existsSync(leftover)).toBe(!clean);
      const notice = readFileSync(proof, "utf8");
      expect(notice.match(/WORKTREE_UNCLEAN/g)).toHaveLength(1);
      expect(notice).toContain("commit");
      expect(notice).toContain("discard");
    }, 30000);
  }
});
