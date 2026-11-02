import { describe, expect, it } from "bun:test";
import {
  type CheckRunLite,
  completedHoldPrecondition,
  reportsConflict,
} from "../scripts/lib/ci-hold.ts";

const answer = (stdout: string, code = 0) => ({ code, stdout });

describe("reportsConflict", () => {
  it("reads only GitHub's CONFLICTING verdict as a conflict", () => {
    expect(reportsConflict(answer('{"mergeable":"CONFLICTING"}\n'))).toBe(true);
    for (const verdict of ["MERGEABLE", "UNKNOWN", "conflicting"])
      expect(
        reportsConflict(answer(JSON.stringify({ mergeable: verdict }))),
      ).toBe(false);
  });

  it("fails closed on a call that failed or an answer it cannot read", () => {
    expect(reportsConflict(answer('{"mergeable":"CONFLICTING"}', 1))).toBe(
      false,
    );
    for (const stdout of ["", "not json", "null", "[]", '{"mergeable":null}'])
      expect(reportsConflict(answer(stdout))).toBe(false);
  });
});

describe("a release certificate retained across a conflict-resolving push", () => {
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const REQUIRED = ["tests", "Schema gate"];
  const unlabel = {
    id: "LE_2",
    event: "unlabeled" as const,
    actor: "drive-user",
    createdAt: "2026-09-10T10:00:00Z",
  };
  const run = (
    id: number,
    name: string,
    headSha: string,
    startedAt: string,
    status = "completed",
  ): CheckRunLite => ({
    id,
    name,
    headSha,
    status,
    conclusion: status === "completed" ? "success" : null,
    startedAt,
    appId: null,
  });
  // The released certificate names OLD and its unlabel; NEW is the pushed head.
  const onNew = (runs: CheckRunLite[]) =>
    completedHoldPrecondition(runs, REQUIRED, NEW, unlabel, 0, true);

  it("blocks the new head until its own required checks complete after the unlabel", () => {
    const oldRuns = REQUIRED.map((name, i) =>
      run(i + 1, name, OLD, "2026-09-10T10:01:00Z"),
    );
    expect(onNew([])).toBe(false);
    expect(onNew(oldRuns)).toBe(false);
    const pending = REQUIRED.map((name, i) =>
      run(i + 10, name, NEW, "2026-09-10T10:05:00Z", "in_progress"),
    );
    expect(onNew([...oldRuns, ...pending])).toBe(false);
    const stale = REQUIRED.map((name, i) =>
      run(i + 20, name, NEW, "2026-09-10T09:00:00Z"),
    );
    expect(onNew(stale)).toBe(false);
    const fresh = REQUIRED.map((name, i) =>
      run(i + 30, name, NEW, "2026-09-10T10:05:00Z"),
    );
    expect(onNew([...oldRuns, ...fresh])).toBe(true);
  });
});
