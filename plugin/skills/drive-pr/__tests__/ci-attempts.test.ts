import { describe, expect, it } from "bun:test";
import {
  attemptState,
  chargeRepair,
  repairSelection,
  retryFailedChecks,
  type RetryForge,
} from "../scripts/lib/driver/ci-attempts.ts";
import { rerunFailedOnceSetting } from "../scripts/lib/driver/ci-attempts-config.ts";

const record = async (detail: string) => {
  expect(detail).toContain("run 41");
};
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const failing = (names = ["tests"]) => ({
  checkRunNames: names,
  statusNames: [],
  runs: [{ id: 41, createdAt: "2026-11-08T10:00:00Z", jobNames: names }],
});
const forgeOf = (allowed = true) => {
  const calls: number[] = [];
  const forge: RetryForge = {
    observe: async () => ({ attempt: 2, completed: true }),
    rerunnable: async (_pr, runs) => (allowed ? runs.map((r) => r.id) : []),
    retry: async (_pr, _head, id) => {
      calls.push(id);
      return { ok: true, detail: "accepted" };
    },
  };
  return { forge, calls };
};

describe("failed-check attempts", () => {
  it("retries once without charging repair, then leaves the same failure to repair", async () => {
    const state = attemptState();
    const { forge, calls } = forgeOf();
    const events: string[] = [];
    expect(
      await retryFailedChecks("9", HEAD, failing(), state, forge, async (s) => {
        events.push(s);
      }),
    ).toBe(true);
    expect(repairSelection(HEAD, failing(), state, 2).used).toBe(0);
    expect(
      await retryFailedChecks("9", HEAD, failing(), state, forge, record),
    ).toBe(false);
    chargeRepair(HEAD, failing(), state);
    expect(repairSelection(HEAD, failing(), state, 2).used).toBe(1);
    expect(calls).toEqual([41]);
    expect(events.join(" ")).toContain("41");
    expect(events.join(" ")).toContain("tests");
  });

  it("gives another check and another head their own repair budget", () => {
    const state = attemptState();
    chargeRepair(HEAD, failing(), state);
    expect(repairSelection(HEAD, failing(), state, 1).names).toEqual([]);
    expect(repairSelection(HEAD, failing(["lint"]), state, 1).names).toEqual([
      "lint",
    ]);
    expect(repairSelection(NEXT, failing(), state, 1).names).toEqual(["tests"]);
    chargeRepair(NEXT, failing(), state);
    expect(repairSelection(HEAD, failing(), state, 1).names).toEqual([]);
  });

  it("targets only checks whose budget remains", () => {
    const state = attemptState();
    chargeRepair(HEAD, failing(), state);
    const selected = repairSelection(
      HEAD,
      failing(["tests", "lint"]),
      state,
      1,
    );
    expect(selected.names).toEqual(["lint"]);
    expect(selected.failing.checkRunNames).toEqual(["lint"]);
  });

  it("does not repeat an old check when a fresh check shares its workflow", async () => {
    const state = attemptState();
    const { forge, calls } = forgeOf();
    await retryFailedChecks("9", HEAD, failing(), state, forge, record);
    expect(
      await retryFailedChecks(
        "9",
        HEAD,
        failing(["tests", "lint"]),
        state,
        forge,
        record,
      ),
    ).toBe(false);
    expect(calls).toEqual([41]);
  });

  it("never retries held runs or absent workflow provenance", async () => {
    const state = attemptState();
    const { forge, calls } = forgeOf(false);
    expect(
      await retryFailedChecks("9", HEAD, failing(), state, forge, record),
    ).toBe(false);
    expect(
      await retryFailedChecks(
        "9",
        HEAD,
        { ...failing(), runs: [] },
        state,
        forge,
        record,
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("treats malformed workflow job names as missing provenance", async () => {
    const state = attemptState();
    const { forge, calls } = forgeOf();
    const malformed = {
      ...failing(),
      runs: [{ id: 41, createdAt: "2026-11-08T10:00:00Z", jobNames: "tests" }],
    };
    expect(
      await retryFailedChecks("9", HEAD, malformed, state, forge, record),
    ).toBe(false);
    expect(repairSelection(HEAD, malformed, state, 1).failing.runs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not repeat a refused request", async () => {
    const state = attemptState();
    const { forge, calls } = forgeOf();
    forge.retry = async (_pr, _head, id) => {
      calls.push(id);
      return { ok: false, detail: "refused" };
    };
    expect(
      await retryFailedChecks("9", HEAD, failing(), state, forge, record),
    ).toBe(false);
    expect(
      await retryFailedChecks("9", HEAD, failing(), state, forge, record),
    ).toBe(false);
    expect(calls).toEqual([41]);
  });

  it("defaults retries on and provides an independent off switch", () => {
    expect(rerunFailedOnceSetting({})).toEqual({ ok: true, value: true });
    expect(
      rerunFailedOnceSetting({ ci: { rerun_failed_once: false } }),
    ).toEqual({ ok: true, value: false });
    expect(
      rerunFailedOnceSetting({ ci: { rerun_failed_once: "false" } }).ok,
    ).toBe(false);
  });
});
