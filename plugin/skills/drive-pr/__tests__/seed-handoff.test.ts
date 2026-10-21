import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hold,
  park,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

for (const [name, seed] of [
  ["park", park],
  ["hold", hold],
] as const) {
  test(`${name} seeds keep handoff output out of the shared checkout`, async () => {
    const { stateDir } = writeFixture({}, scratchClean.dir);
    const key = `seed-${name}`;
    await seed(stateDir, key, "finding");
    const handoff = join(stateDir, "handoff", "pr-drive-999.md");
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, "utf8")).toContain(key);
    expect(
      existsSync(join(scratchClean.dir, ".context", "pr-drive-999.md")),
    ).toBe(false);
  });
}
