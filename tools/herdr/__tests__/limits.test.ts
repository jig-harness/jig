import { describe, expect, test } from "bun:test";
import { settleLimitMs } from "../herdr.ts";
import { CLAIM_WAIT_MS, PROMPT_TIMEOUT_MS } from "../kickoff.ts";
import { HOOK_TIMEOUT_MS, PLUGIN_GRACE_MS } from "../lifecycle.ts";
import { openLimitMs, removeLimitMs, toolLimitMs } from "../limits.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../spawn.ts";

describe("the tool's limits", () => {
  test("open fits its longest hook, every settle wait, the claim wait and the send", () => {
    for (const wait of [DEFAULT_WAIT_TIMEOUT_MS, 30 * 60_000])
      expect(openLimitMs(wait)).toBeGreaterThan(
        PLUGIN_GRACE_MS +
          HOOK_TIMEOUT_MS +
          settleLimitMs(wait) +
          CLAIM_WAIT_MS +
          PROMPT_TIMEOUT_MS,
      );
  });
  test("settling allows every wait the agent may need", () => {
    // Four waits of the wait timeout, as a still-working agent is waited for again.
    expect(settleLimitMs(DEFAULT_WAIT_TIMEOUT_MS)).toBeGreaterThan(
      4 * DEFAULT_WAIT_TIMEOUT_MS,
    );
  });
  test("a command line is bounded by its own command and wait timeout", () => {
    expect(toolLimitMs(["open", "--repo", "r"])).toBe(openLimitMs());
    expect(toolLimitMs(["open", "--wait-timeout-ms", "600000"])).toBe(
      openLimitMs(600_000),
    );
    expect(toolLimitMs(["open", "--wait-timeout-ms", "soon"])).toBe(
      openLimitMs(),
    );
    expect(toolLimitMs(["remove", "--repo", "r"])).toBe(removeLimitMs());
    expect(removeLimitMs()).toBeGreaterThan(HOOK_TIMEOUT_MS);
  });
});
