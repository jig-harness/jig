/**
 * A gate run through the pass's runner: a gate stopped before it finished is
 * unchecked, whatever its captured output already reported.
 */
import { describe, expect, test } from "bun:test";
import { readFrontmatterOutput, runGate } from "../scripts/lib/gates.ts";
import { temporary } from "./helpers.ts";

describe("a gate stopped for its output", () => {
  test("is failed, not a scan with findings", async () => {
    const result = await runGate(
      {
        name: "frontmatter",
        script: "../__tests__/fixtures/gates/noisy-gate.ts",
        args: [],
        env: {},
        read: readFrontmatterOutput,
      },
      temporary(),
      64 * 1024,
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("output buffer");
  });
});
