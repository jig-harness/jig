import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POSITION_KIND,
  readPosition,
  writePosition,
} from "../scripts/lib/sweep-position.ts";

const scratch = mkdtempSync(join(tmpdir(), "sweep-position-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the sweep's read position file", () => {
  it("starts from the oldest issue when there is no file yet", () => {
    expect(readPosition(join(scratch, "absent.json"))).toEqual({
      after: null,
      warning: null,
    });
  });

  it("reads back the cursor it wrote, and the start from the oldest", () => {
    const path = join(scratch, "nested", "position.json");
    writePosition(path, "2026-01-01T00:00:00Z|#3");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      kind: POSITION_KIND,
      version: 1,
      after: "2026-01-01T00:00:00Z|#3",
    });
    expect(readPosition(path)).toEqual({
      after: "2026-01-01T00:00:00Z|#3",
      warning: null,
    });
    writePosition(path, null);
    expect(readPosition(path)).toEqual({ after: null, warning: null });
  });

  for (const [what, text] of [
    ["text that is not JSON", "{"],
    ["a record of another kind", '{"kind":"other","version":1,"after":null}'],
    [
      "a cursor that is not a string",
      `{"kind":"${POSITION_KIND}","version":1,"after":3}`,
    ],
  ] as const)
    it(`starts from the oldest issue, with a warning, on ${what}`, () => {
      const path = join(scratch, `bad-${what.length}.json`);
      writeFileSync(path, text);
      const read = readPosition(path);
      expect(read.after).toBeNull();
      expect(read.warning).toContain("starting from the oldest issue");
    });
});
