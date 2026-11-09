import { describe, expect, it } from "bun:test";
import {
  diagnoseCiHold,
  type CiHoldEvidence,
} from "../scripts/lib/ci-hold-diagnosis.ts";

const good: CiHoldEvidence = {
  driver: "dead",
  driverReason: "local recorded process has exited",
  head: "a".repeat(40),
  label: "ci:hold",
  held: true,
  review: "converged",
  worktree: "/tmp/drive",
  worktreeSafe: true,
  ownership: true,
  transitionId: "LE_42",
  parked: 0,
  pr: "123",
  releaseScript: "/plugin/ci-hold.ts",
};

describe("stranded CI hold diagnosis", () => {
  it("offers the direct guarded release for a stopped, reviewed current head", () => {
    const diagnosis = diagnoseCiHold(good);
    expect(diagnosis.recovery).toContain("release 123 --expect-head");
    expect(diagnosis.recovery).toContain("--expect-transition LE_42");
    expect(diagnosis.reason).toContain("start full CI");
    expect(diagnosis.driver).toBe("dead");
  });
  for (const [name, overrides, reason] of [
    ["live driver", { driver: "alive" }, "driver"],
    ["unknown driver", { driver: "unknown" }, "liveness"],
    ["moved head", { review: "pending" }, "review"],
    ["failed read", { held: null }, "label"],
    ["human decision", { parked: 1 }, "decision"],
    ["unknown owner", { ownership: false }, "ownership"],
    ["missing transition", { transitionId: null }, "transition"],
    ["dirty worktree", { worktreeSafe: false }, "worktree"],
  ] as const) {
    it(`withholds release for ${name}`, () => {
      const diagnosis = diagnoseCiHold({ ...good, ...overrides });
      expect(diagnosis.recovery).toBeNull();
      expect(diagnosis.reason).toContain(reason);
    });
  }
});

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { writeState } from "./state-rows.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { listStateOnlyRows } from "../scripts/drives.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

it("includes a lock-less recorded CI hold without a quota park or human decisions", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-hold-doctor-"));
  roots.push(root);
  const stateDir = scopedStateDir(root);
  writeState(stateDir, "123", {
    ...freshState(123),
    ciHold: {
      phase: "held",
      eventId: "42",
      addedAtHead: good.head,
      actor: "operator",
      createdAt: "2026-11-06T12:00:00.000Z",
      checkRunWatermark: 1,
    },
  });
  const rows = listStateOnlyRows(stateDir, []);
  expect(rows.map((row) => row.key)).toEqual(["123"]);
  expect(rows[0]?.state).toBe("empty");
  writeState(stateDir, "123", {
    ...freshState(123),
    ciHold: {
      phase: "released",
      eventId: "43",
      head: good.head,
      actor: "operator",
      createdAt: "2026-11-06T12:01:00.000Z",
      checkRunWatermark: 1,
      source: "drive",
    },
  });
  expect(listStateOnlyRows(stateDir, [])).toEqual([]);
});
