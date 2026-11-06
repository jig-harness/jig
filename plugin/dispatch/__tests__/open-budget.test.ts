import { expect, it } from "bun:test";
import { openWithinBudget, type ApplyState } from "../lib/actions/launch.ts";
import type { MachineConfig } from "../lib/machine-config.ts";
import type { RepoTarget } from "../lib/types.ts";

const repo = {
  slug: "example-org/example-repo",
  path: "/tmp/repo",
} as RepoTarget;
const dispatched = { name: "test", mark: "test" };
const launch = { pr: 7, head: "feature/7", dispatched };
const notice = { notices: "jig-dispatch-notices", dispatched };

function state(): ApplyState {
  return {
    machine: {
      opensPerTick: 4,
      workspaceTimeoutMs: 1000,
      runtimeTimeoutMs: 1000,
      repositories: [{ stages: ["notify"] }],
    } as MachineConfig,
    runtime: {
      openWorkspace: async () => ({
        ok: true,
        detail: "opened",
        workspace: { id: "1", path: "/tmp/ws" },
      }),
    },
  } as unknown as ApplyState;
}

it("retains the same launch allowance whether the reserved notice opens first or last", async () => {
  for (const first of [true, false]) {
    const s = state();
    if (first)
      expect(await openWithinBudget(s, repo, notice)).toHaveProperty(
        "workspace",
      );
    for (let i = 0; i < 3; i++)
      expect(await openWithinBudget(s, repo, launch)).toHaveProperty(
        "workspace",
      );
    expect(await openWithinBudget(s, repo, launch)).toHaveProperty("waits");
    if (!first)
      expect(await openWithinBudget(s, repo, notice)).toHaveProperty(
        "workspace",
      );
    expect(s.opened).toBe(4);
  }
});

it("charges failed opens to the budget too", async () => {
  const s = state();
  s.runtime.openWorkspace = async () => ({ ok: false, detail: "failed" });
  for (let i = 0; i < 3; i++)
    expect(await openWithinBudget(s, repo, launch)).toHaveProperty("refused");
  expect(await openWithinBudget(s, repo, launch)).toHaveProperty("waits");
});

it("reserves the repository lookup, workspace timeout and receipt before opening", async () => {
  const s = state();
  s.startedAt = Date.now() - 6 * 3_600_000 + 2500;
  expect(await openWithinBudget(s, repo, launch)).toEqual({
    waits: expect.stringContaining("workspace_timeout"),
  });
  expect(s.opened).toBeUndefined();
});
