/**
 * drive-pr suite: the bound on a converged round's re-gates when its final
 * status re-read disagrees with the round gate (`lib/driver/final-regate.ts`),
 * and the view that re-read is made with.
 */

import { describe, expect, it, spyOn } from "bun:test";

import { checkFinalCiStatus } from "../scripts/lib/driver/convergence-ci.ts";
import {
  finalReadAgrees,
  finalReadArgs,
  finalReadDisagrees,
  statusViewFlags,
} from "../scripts/lib/driver/final-regate.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

function context(limit: number, extra: Partial<DriveRoundContext> = {}) {
  return {
    pr: "999",
    passes: 0,
    inheritedHead: "",
    statusView: [],
    finalRegates: 0,
    finalRegateKey: "",
    finalRegateLimit: limit,
    ...extra,
  } as unknown as DriveRoundContext;
}

const ROUND_READY = {
  state: "ROUND_READY",
  reason: "1 unresolved thread(s)",
  head: { api: HEAD },
};

/** Run `body` with the console's error stream captured. */
async function quietly<T>(body: () => T | Promise<T>): Promise<T> {
  const spy = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

describe("the final re-read's view", () => {
  it("keeps the flags that shape the judgement and drops the polling ones", () => {
    expect(
      statusViewFlags([
        "--timeout",
        "600",
        "--bots-only",
        "--interval",
        "15",
        "--no-head-sync",
      ]),
    ).toEqual(["--bots-only", "--no-head-sync"]);
  });

  it("reads once, uncounted, through the view and the inherited head", () => {
    expect(
      finalReadArgs(
        context(3, {
          statusView: ["--bots-only"],
          inheritedHead: MOVED,
        }),
      ),
    ).toEqual([
      "999",
      "--json",
      "--once",
      "--no-count",
      "--bots-only",
      "--inherited-head",
      MOVED,
    ]);
    expect(finalReadArgs(context(3))).toEqual([
      "999",
      "--json",
      "--once",
      "--no-count",
    ]);
  });
});

describe("the bound on final re-read disagreements", () => {
  it("re-gates up to the limit on one head and stops on the next", async () => {
    const c = context(2);
    const outcomes = await quietly(() =>
      [1, 2, 3].map(() => finalReadDisagrees(c, HEAD, ROUND_READY, 0)),
    );
    expect(outcomes).toEqual(["continue", "continue", 1]);
  });

  it("stops on the first disagreement at a limit of 0", async () => {
    const c = context(0);
    expect(
      await quietly(() => finalReadDisagrees(c, HEAD, ROUND_READY, 0)),
    ).toBe(1);
  });

  it("names the re-read's state and reason, and the knob, when it stops", async () => {
    const c = context(0);
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      finalReadDisagrees(c, HEAD, ROUND_READY, 0);
    } finally {
      spy.mockRestore();
    }
    const log = lines.join("\n");
    expect(log).toContain(
      "the re-read saw ROUND_READY (exit 0): 1 unresolved thread(s)",
    );
    expect(log).toContain("DRIVE_PR_FINAL_REGATE_LIMIT=0");
  });

  it("starts again on a new head", async () => {
    const c = context(1);
    const outcomes = await quietly(() => [
      finalReadDisagrees(c, HEAD, ROUND_READY, 0),
      finalReadDisagrees(c, MOVED, ROUND_READY, 0),
      finalReadDisagrees(c, MOVED, ROUND_READY, 0),
    ]);
    expect(outcomes).toEqual(["continue", "continue", 1]);
  });

  it("starts again after a pass ran", async () => {
    const c = context(1);
    const outcomes = await quietly(() => {
      const first = finalReadDisagrees(c, HEAD, ROUND_READY, 0);
      c.passes += 1;
      return [first, finalReadDisagrees(c, HEAD, ROUND_READY, 0)];
    });
    expect(outcomes).toEqual(["continue", "continue"]);
  });

  it("starts again once a re-read agrees", async () => {
    const c = context(1);
    const outcomes = await quietly(() => {
      const first = finalReadDisagrees(c, HEAD, ROUND_READY, 0);
      finalReadAgrees(c);
      return [first, finalReadDisagrees(c, HEAD, ROUND_READY, 0)];
    });
    expect(outcomes).toEqual(["continue", "continue"]);
  });
});

describe("checkFinalCiStatus on a re-read that disagrees", () => {
  const check = (
    c: DriveRoundContext,
    status: Record<string, unknown>,
    code: number,
  ) =>
    checkFinalCiStatus(
      status,
      HEAD,
      { code } as Parameters<typeof checkFinalCiStatus>[2],
      "green",
      { code: 0 } as Parameters<typeof checkFinalCiStatus>[4],
      c,
      {} as Parameters<typeof checkFinalCiStatus>[6],
    );

  it("re-gates a moved head without counting it", async () => {
    const c = context(0);
    const moved = { ...ROUND_READY, head: { api: MOVED } };
    expect(await quietly(() => check(c, moved, 0))).toBe("continue");
    expect(await quietly(() => check(c, moved, 0))).toBe("continue");
    expect(c.finalRegates).toBe(0);
  });

  it("counts a re-read whose head did not read", async () => {
    const c = context(0);
    expect(await quietly(() => check(c, {}, 1))).toBe(1);
  });

  it("re-gates a new finding on the reviewed head, then clears the streak once a re-read agrees", async () => {
    const c = context(1);
    expect(await quietly(() => check(c, ROUND_READY, 0))).toBe("continue");
    expect(c.finalRegates).toBe(1);
    const agreed = await quietly(() =>
      check(c, { state: "CONVERGED", head: { api: HEAD } }, 3),
    );
    expect(typeof agreed).toBe("object");
    expect(c.finalRegates).toBe(0);
  });
});
