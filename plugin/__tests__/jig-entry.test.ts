import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";

const entry = resolve(import.meta.dir, "../jig.ts");

test("a dispatch usage error exits 2 and says why", () => {
  const result = Bun.spawnSync(["bun", entry, "dispatch", "--bogus"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("Unknown argument: --bogus");
});
