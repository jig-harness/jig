/** dispatch: each row of the ledger-to-class table, first match wins. */
import { describe, expect, it } from "bun:test";
import { classifyLedger } from "../lib/sources/ledgers.ts";
import { stoppedLedger } from "./fixtures.ts";

const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const WINDOW = 240 * 60_000;

function running(minutesAgo: number) {
  const ledger = stoppedLedger(7, undefined);
  return {
    ...ledger,
    driver: {
      ...ledger.driver,
      state: "running" as const,
      heartbeat: new Date(NOW - minutesAgo * 60_000).toISOString(),
    },
  };
}

const classOf = (
  exit: number | undefined,
  park?: Parameters<typeof classifyLedger>[3],
) => classifyLedger(stoppedLedger(7, exit), NOW, WINDOW, park).class;

describe("classifyLedger", () => {
  it("reads a running driver by its heartbeat against the lease window", () => {
    expect(classifyLedger(running(10), NOW, WINDOW).class).toBe("driven");
    expect(classifyLedger(running(241), NOW, WINDOW).class).toBe("silent");
  });

  it("reads each stopped exit as the table says", () => {
    expect([5, 20].map((e) => classOf(e))).toEqual(["done", "done"]);
    expect([18, 19].map((e) => classOf(e))).toEqual([
      "stopped-by-person",
      "stopped-by-person",
    ]);
    expect(classOf(undefined)).toBe("re-armable");
    expect(classOf(16)).toBe("re-armable");
    expect(classOf(4)).toBe("re-armable");
    expect([11, 13].map((e) => classOf(e))).toEqual(["refused", "refused"]);
    expect([1, 2, 6, 7, 12, 15, 99].map((e) => classOf(e))).toEqual(
      Array(7).fill("needs-person"),
    );
  });

  // A stall and a spent CI-repair budget are re-driven once per head commit;
  // a generic exit 1, a crash, stays a person's, and says when its pull
  // request also conflicts.
  it("re-drives a stall or a spent CI-repair budget once per head, and keeps a crash a person's", () => {
    const head = "c".repeat(40);
    const forge = { head, mergeable: "CONFLICTING" };
    for (const exit of [14, 21]) {
      const placed = classifyLedger(
        stoppedLedger(7, exit),
        NOW,
        WINDOW,
        undefined,
        forge,
      );
      expect(placed.class).toBe("stale");
      expect(placed.stale).toMatchObject({
        change: `head ${head}, stopped ${exit}`,
        mechanicalStop: exit === 14 ? "stall" : "ci-repair",
      });
      // A stall that never measured its leftovers stays bound to its tree.
      if (exit === 14) expect(placed.stale?.tree).toBeDefined();
      else expect(placed.stale?.tree).toBeUndefined();
      expect(
        classifyLedger(stoppedLedger(7, exit), NOW, WINDOW, undefined, {
          head: null,
          mergeable: "MERGEABLE",
        }).class,
      ).toBe("unplaced");
    }
    const crash = classifyLedger(
      stoppedLedger(7, 1),
      NOW,
      WINDOW,
      undefined,
      forge,
    );
    expect(crash.class).toBe("needs-person");
    expect(crash.why).toContain("also conflicts with its base");
    expect(
      classifyLedger(stoppedLedger(7, 1), NOW, WINDOW, undefined, {
        head,
        mergeable: "MERGEABLE",
      }).why,
    ).not.toContain("conflicts");
  });

  it("binds a stall that left work to the tree it stalled in", () => {
    const ledger = stoppedLedger(7, 14);
    ledger.events = [
      {
        at: new Date(NOW).toISOString(),
        round: 3,
        kind: "stop",
        cause: "14",
        leftWork: true,
      },
    ];
    const placed = classifyLedger(ledger, NOW, WINDOW, undefined, {
      head: "c".repeat(40),
      mergeable: "MERGEABLE",
    });
    expect(placed.class).toBe("stale");
    expect(placed.stale?.tree?.actor).toBe(ledger.driver.actor);
    expect(placed.why).toContain("in the tree it stalled in");
    // Work left by an earlier stop is not this stall's.
    ledger.events = [
      {
        at: new Date(NOW).toISOString(),
        round: 2,
        kind: "stop",
        cause: "14",
        leftWork: true,
      },
      { at: new Date(NOW).toISOString(), round: 3, kind: "stop", cause: "1" },
    ];
    expect(
      classifyLedger(ledger, NOW, WINDOW, undefined, {
        head: "c".repeat(40),
        mergeable: "MERGEABLE",
      }).stale?.tree,
    ).toBeUndefined();
  });

  it("binds a stall whose stop never measured its tree, and frees one measured clean", () => {
    const ledger = stoppedLedger(7, 14);
    const forge = { head: "c".repeat(40), mergeable: "MERGEABLE" };
    const stall = (leftWork?: boolean) => ({
      at: new Date(NOW).toISOString(),
      round: 3,
      kind: "stop" as const,
      cause: "14",
      ...(leftWork === undefined ? {} : { leftWork }),
    });
    ledger.events = [stall()];
    const legacy = classifyLedger(ledger, NOW, WINDOW, undefined, forge);
    expect(legacy.stale?.tree?.actor).toBe(ledger.driver.actor);
    expect(legacy.why).toContain("never measured");
    ledger.events = [stall(false)];
    expect(
      classifyLedger(ledger, NOW, WINDOW, undefined, forge).stale?.tree,
    ).toBeUndefined();
  });

  it("holds a globally recorded operator stop while its driver is still running", () => {
    const ledger = running(10);
    ledger.driver.personStop = {
      at: new Date(NOW).toISOString(),
      reason: "maintenance",
    };
    const placed = classifyLedger(ledger, NOW, WINDOW);
    expect(placed.class).toBe("stopped-by-person");
    expect(placed.why).toContain("stop requested by a person");
    expect(placed.why).toContain("driver still recorded running");
  });

  it("re-arms a park only once every parked item is answered", () => {
    expect(classOf(8, { answered: 2, waiting: [] })).toBe("re-armable");
    expect(classOf(8, { answered: 1, waiting: ["thread PRRT_a"] })).toBe(
      "parked",
    );
    expect(classOf(8, { unreadable: "thread PRRT_a" })).toBe("unplaced");
    expect(classOf(8)).toBe("unplaced");
  });

  it("reads a converged ledger beside its pull request's mergeability and head", () => {
    const verified = "a".repeat(40);
    const moved = "b".repeat(40);
    const converged = (
      forge: Parameters<typeof classifyLedger>[4],
      verifiedSha = verified,
    ) =>
      classifyLedger(
        stoppedLedger(7, 0, { verifiedSha }),
        NOW,
        WINDOW,
        undefined,
        forge,
      );

    // Its base merely moved past it: still mergeable at the verified head.
    expect(converged({ head: verified, mergeable: "MERGEABLE" }).class).toBe(
      "done",
    );
    expect(converged({ head: verified, mergeable: "CONFLICTING" })).toEqual({
      class: "stale",
      why: "stopped 0 (converged), and now conflicting with its base: re-drive on any account",
      stale: {
        cause: "conflicting with its base",
        change: `head ${verified}, conflicting`,
      },
    });
    expect(converged({ head: moved, mergeable: "MERGEABLE" }).stale).toEqual({
      cause: "head bbbbbbb past the verified head aaaaaaa",
      change: `head ${moved}, mergeable`,
    });
    expect(
      converged({ head: moved, mergeable: "CONFLICTING" }).stale?.cause,
    ).toBe(
      "conflicting with its base, and head bbbbbbb past the verified head aaaaaaa",
    );
    // A conflict needs no verified head; a moved head does.
    expect(
      converged({ head: verified, mergeable: "CONFLICTING" }, "").class,
    ).toBe("stale");
    expect(
      converged({ head: verified, mergeable: "MERGEABLE" }, "").class,
    ).toBe("unplaced");
  });

  it("cannot place a converged ledger while its pull request's mergeability or head is not known", () => {
    const verified = "a".repeat(40);
    const converged = (forge?: Parameters<typeof classifyLedger>[4]) =>
      classifyLedger(
        stoppedLedger(7, 0, { verifiedSha: verified }),
        NOW,
        WINDOW,
        undefined,
        forge,
      );
    const computing = converged({ head: "b".repeat(40), mergeable: "UNKNOWN" });
    expect(computing.class).toBe("unplaced");
    expect(computing.why).toContain(
      "the forge is still computing whether it conflicts with its base",
    );
    expect(converged({ head: verified, mergeable: null }).class).toBe(
      "unplaced",
    );
    expect(converged({ head: null, mergeable: "CONFLICTING" }).class).toBe(
      "unplaced",
    );
    expect(converged().class).toBe("unplaced");
  });

  describe("a ledger that stopped 9", () => {
    const head = "a".repeat(40);
    const oid = "c".repeat(40);
    const stopped = (forge?: Parameters<typeof classifyLedger>[4]) =>
      classifyLedger(stoppedLedger(7, 9), NOW, WINDOW, undefined, forge);

    it("is stale whatever the forge reports, on the pair of its head and its base branch's head", () => {
      const change = `head ${head}, base ${oid}`;
      expect(
        stopped({ head, mergeable: "CONFLICTING", base: { oid } }),
      ).toEqual({
        class: "stale",
        why: "stopped on a conflict with its base, and still conflicting: re-drive on any account, once for head aaaaaaa and base ccccccc",
        stale: {
          cause: "stopped on a conflict with its base, and still conflicting",
          change,
          conflictStop: true,
        },
      });
      expect(stopped({ head, mergeable: "MERGEABLE", base: { oid } })).toEqual({
        class: "stale",
        why: "stopped on a conflict with its base, which the forge no longer reports: re-drive on any account, once for head aaaaaaa and base ccccccc",
        stale: {
          cause:
            "stopped on a conflict with its base, which the forge no longer reports",
          change,
          conflictStop: true,
        },
      });
    });

    it("is not placed while its mergeability, its head or its base branch's head is not known", () => {
      const base = { oid };
      expect(stopped({ head, mergeable: "UNKNOWN", base }).why).toContain(
        "the forge is still computing whether it conflicts with its base",
      );
      expect(stopped({ head, mergeable: null, base }).class).toBe("unplaced");
      expect(stopped({ head: null, mergeable: "CONFLICTING", base }).why).toBe(
        "stopped 9 (conflicting with its base), and the forge reports no head commit for it, so the change a re-drive would act on cannot be told",
      );
      expect(
        stopped({
          head,
          mergeable: "CONFLICTING",
          base: { unreadable: "gh api exited 1: Not Found" },
        }).why,
      ).toContain(
        "the head of its base branch does not read (gh api exited 1: Not Found)",
      );
      expect(stopped({ head, mergeable: "CONFLICTING" }).class).toBe(
        "unplaced",
      );
      expect(stopped().class).toBe("unplaced");
    });
  });

  describe("a parked ledger whose pull request conflicts", () => {
    const head = "a".repeat(40);
    const oid = "c".repeat(40);
    const waiting = { answered: 0, waiting: ["thread PRRT_a"] };
    const parked = (forge?: Parameters<typeof classifyLedger>[4]) =>
      classifyLedger(stoppedLedger(7, 8), NOW, WINDOW, waiting, forge);

    it("is stale, a conflict to re-drive on the pair of its head and its base branch's head", () => {
      const cause =
        "parked waiting on thread PRRT_a, and conflicting with its base";
      expect(parked({ head, mergeable: "CONFLICTING", base: { oid } })).toEqual(
        {
          class: "stale",
          why: `${cause}: re-drive on any account, once for head aaaaaaa and base ccccccc`,
          stale: {
            cause,
            change: `head ${head}, base ${oid}`,
            conflictStop: true,
          },
        },
      );
    });

    it("stays parked while the forge does not report a conflict", () => {
      expect(parked({ head, mergeable: "MERGEABLE" }).class).toBe("parked");
      expect(parked({ head, mergeable: "UNKNOWN" }).class).toBe("parked");
      expect(parked().class).toBe("parked");
    });

    it("is not placed while the pair a re-drive would act on cannot be told", () => {
      expect(parked({ head, mergeable: "CONFLICTING" }).why).toBe(
        "stopped 8 (parked), waiting on thread PRRT_a, and conflicting with its base, but the head of its base branch does not read (it was not read), so the change a re-drive would act on cannot be told",
      );
      expect(
        parked({ head: null, mergeable: "CONFLICTING", base: { oid } }).class,
      ).toBe("unplaced");
    });

    it("re-arms an answered park whatever its mergeability", () => {
      expect(
        classifyLedger(
          stoppedLedger(7, 8),
          NOW,
          WINDOW,
          { answered: 1, waiting: [] },
          { head, mergeable: "CONFLICTING", base: { oid } },
        ).class,
      ).toBe("re-armable");
    });
  });

  it("cannot place a running driver whose heartbeat does not read", () => {
    const ledger = running(1);
    ledger.driver.heartbeat = "yesterday";
    expect(classifyLedger(ledger, NOW, WINDOW).class).toBe("unplaced");
  });
});
