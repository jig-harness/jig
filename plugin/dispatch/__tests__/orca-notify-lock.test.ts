import { describe, expect, test } from "bun:test";
import { orcaNotify } from "../lib/runtime/orca-notify.ts";
import { NOTICES_NAME } from "../lib/runtime/port.ts";

describe("notify on Orca", () => {
  test("writes nothing, and says so, when another writer holds the card's comment lock", async () => {
    const asked: string[] = [];
    const receipt = await orcaNotify(
      { id: "w1", path: "/ws/app/feat-x" },
      "[jig dispatch: k]\nPR #4 parked",
      1000,
      async (workspace) => {
        asked.push(workspace);
        return null;
      },
    );
    expect(asked).toEqual(["/ws/app/feat-x"]);
    expect(receipt.ok).toBe(false);
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(receipt.detail).toContain("lock");
  });

  test("takes the lock within the runtime deadline and no longer than it", async () => {
    let waited = -1;
    await orcaNotify(
      { id: "w1", path: "/ws/app/feat-x" },
      "[jig dispatch: k]\nPR #4 parked",
      1000,
      async (_workspace, _body, options) => {
        waited = options?.waitMs ?? -1;
        return null;
      },
    );
    expect(waited).toBe(1000);
  });

  test("a lock that throws is a lost-nothing receipt, not a throw", async () => {
    const receipt = await orcaNotify(
      { id: "w1", path: "/ws/app/feat-x" },
      "[jig dispatch: k]\nPR #4 parked",
      1000,
      async () => {
        throw new Error("EACCES");
      },
    );
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(receipt.detail).toContain("EACCES");
  });
});

describe("the launch mark on Orca", () => {
  test("is written under the card's comment lock, and not at all without it", async () => {
    const { markComment } = await import("../lib/runtime/orca-comment.ts");
    const asked: string[] = [];
    const why = await markComment(
      "/ws/app/feat-x",
      NOTICES_NAME,
      1000,
      async (workspace) => {
        asked.push(workspace);
        return null;
      },
    );
    expect(asked).toEqual(["/ws/app/feat-x"]);
    expect(why).toContain("another writer");
  });
});
