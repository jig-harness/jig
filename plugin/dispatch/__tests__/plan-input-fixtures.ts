/** Builders the plan and launch-record tests share. */
import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRecord,
  type LaunchClaim,
  type LaunchRecord,
  writeRecord,
} from "../lib/launches.ts";
import { dispatchSection } from "../lib/section.ts";
import type { PlanInput } from "../lib/plan.ts";
import type { DispatchSection } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";

export function section(): DispatchSection {
  const read = dispatchSection({
    issue_tracker: { adapter: "github", github: { repository: SLUG } },
    dispatch: { identity: "factory-bot", followup_command: "/followup" },
  });
  if (!read.ok) throw new Error(read.failure.reason);
  return read.value;
}

/** A plan input with nothing to place, at `nowMs`; `over` replaces fields. */
export function planInput(nowMs: number, over: Partial<PlanInput>): PlanInput {
  return {
    slug: SLUG,
    section: section(),
    pickups: [],
    claimed: [],
    drives: [],
    merged: [],
    outcomes: new Map(),
    sessions: { ok: true, source: "fake", workspaces: [] },
    launches: [],
    idleSince: new Map(),
    nowMs,
    ...over,
  };
}

/**
 * A directory holding one rearm launch record for pull request 7, claimed
 * by `claim`. The directory is registered in `dirs` for the test's cleanup.
 */
export function claimedLaunchRoot(
  dirs: string[],
  id: string,
  claim: LaunchClaim,
  at: { prefix: string; repo: string; repoPath: string; createdAt: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), at.prefix));
  dirs.push(dir);
  const record: LaunchRecord = {
    version: 1,
    id,
    token: "t",
    action: "rearm",
    repo: at.repo,
    repoPath: at.repoPath,
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "generation 1, exit 8, heartbeat x",
    createdAt: at.createdAt,
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
  };
  writeRecord(record, dir);
  expect(claimRecord(id, claim, dir)).toBe(true);
  return dir;
}
