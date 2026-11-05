/**
 * drive-pr suite: a drive armed in a terminal tab hands the tab Orca opened
 * to the run-tab recorder (`lib/arm.ts`, `shared/orca-tabs.ts`), so the drive
 * can close it when it ends; a tab Orca refused is never recorded.
 */

import { describe, expect, it } from "bun:test";
import type { OrcaRunner } from "../../../shared/orca.ts";
import { type ArmRequest, armInTab, type TabDeps } from "../scripts/lib/arm.ts";

const REQUEST: ArmRequest = { pr: "42", tree: "/work/tree", forward: [] };
const CREATED = {
  terminal: { handle: "term_1", tabId: "tab-1", processId: 4242 },
};

function orca(ok: boolean): OrcaRunner {
  return async () => ({
    code: ok ? 0 : 1,
    stdout: JSON.stringify(
      ok
        ? { ok: true, result: CREATED }
        : { ok: false, error: { code: "selector_not_found" } },
    ),
    stderr: "",
  });
}

/** Deps on a fake clock, with no drive ever listed, recording what the recorder was handed. */
function deps(runner: OrcaRunner): TabDeps & { recorded: unknown[] } {
  let clock = 1_000_000;
  const recorded: unknown[] = [];
  return {
    recorded,
    orca: runner,
    liveDrive: async () => null,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    confirmMs: 1_000,
    pollMs: 1_000,
    runTab: async (result, command, request) => {
      recorded.push({ result, command, pr: request.pr });
    },
  };
}

describe("recording the drive's tab", () => {
  it("hands the tab Orca opened, the command and the PR to the recorder", async () => {
    const d = deps(orca(true));
    await armInTab("/opt/orca/bin/orca", REQUEST, "bun x", d);
    expect(d.recorded).toEqual([
      { result: CREATED, command: "/opt/orca/bin/orca", pr: "42" },
    ]);
  });

  it("records nothing when Orca refuses the tab", async () => {
    const d = deps(orca(false));
    const outcome = await armInTab("/opt/orca/bin/orca", REQUEST, "bun x", d);
    expect(outcome.status).toBe("failed");
    expect(d.recorded).toEqual([]);
  });
});
