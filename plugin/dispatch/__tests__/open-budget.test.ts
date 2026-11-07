import { expect, it, spyOn } from "bun:test";
import * as accounts from "../lib/accounts.ts";
import {
  openWithinBudget,
  openedFor,
  type ApplyState,
} from "../lib/actions/launch.ts";
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

it("preserves the receipt reserve when the open leaves too little time to recheck identity", async () => {
  const s = state();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const identity = spyOn(accounts, "checkIdentity").mockResolvedValue({
    ok: true,
  });
  try {
    s.startedAt = now - 6 * 3_600_000 + 3100;
    s.table = [];
    s.records = [];
    s.runtime.openWorkspace = async () => {
      now += 2000;
      return {
        ok: true,
        detail: "opened",
        workspace: { id: "1", path: "/tmp/ws" },
      };
    };
    const result = await openedFor(
      s,
      { target: "PR #7", stage: "rearm" } as Parameters<typeof openedFor>[1],
      {
        account: { name: "test" },
        wall: null,
        wallUnrecorded: false,
      } as Parameters<typeof openedFor>[2],
      openWithinBudget(s, repo, launch),
    );
    expect(result).toHaveProperty("outcome.outcome", "waits");
    expect(result).toHaveProperty(
      "outcome.detail",
      expect.stringContaining("receipt"),
    );
    expect(identity).not.toHaveBeenCalled();
    expect(s.opened).toBe(1);
  } finally {
    identity.mockRestore();
    clock.mockRestore();
  }
});

async function opened(s: ApplyState): Promise<unknown> {
  s.table = [];
  s.records = [];
  return openedFor(
    s,
    { target: "PR #7", stage: "rearm" } as Parameters<typeof openedFor>[1],
    {
      account: { name: "test" },
      wall: null,
      wallUnrecorded: false,
    } as Parameters<typeof openedFor>[2],
    openWithinBudget(s, repo, launch),
  );
}

it("counts the kill grace when admitting an identity check after an open", async () => {
  const s = state();
  const now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const identity = spyOn(accounts, "checkIdentity").mockResolvedValue({
    ok: true,
  });
  try {
    // 2.5s are left: the 1s check fits, its 2s kill grace does not.
    s.startedAt = now - 6 * 3_600_000 + 3500;
    const result = await opened(s);
    expect(result).toHaveProperty("outcome.outcome", "waits");
    expect(identity).not.toHaveBeenCalled();
  } finally {
    identity.mockRestore();
    clock.mockRestore();
  }
});

it("admits the launch after a successful identity check against its own timeout", async () => {
  const s = state();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const identity = spyOn(accounts, "checkIdentity").mockImplementation(
    async () => {
      now += 1000;
      return { ok: true };
    },
  );
  try {
    // 3.5s are left for the check; 2.5s remain after it, short of the launch's 1s plus the 2s kill grace.
    s.startedAt = now - 6 * 3_600_000 + 4500;
    const result = await opened(s);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty("outcome.outcome", "waits");
    expect(result).toHaveProperty(
      "outcome.detail",
      expect.stringContaining("launch"),
    );
  } finally {
    identity.mockRestore();
    clock.mockRestore();
  }
});
