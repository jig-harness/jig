/**
 * review-failure-mailbox-scan.test.ts — a failed review pass whose
 * usage-limit scan was cut short and whose mailbox checkpoint then ends the
 * drive: the stop is the mailbox's, so the cut-short note must not colour
 * its closing report.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFailedReviewPass } from "../scripts/lib/driver/review-failure.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";
import { driverRuntime } from "../scripts/lib/driver/runtime.ts";
import type { QuotaSnapshot } from "../scripts/lib/quota/index.ts";

const ENV_KEYS = [
  "DRIVE_PR_CLAUDE_PROJECTS_DIR",
  "DRIVE_PR_CODEX_SESSIONS_DIR",
  "DRIVE_PR_QUOTA_MAX_SCAN_MS",
  "DRIVE_PR_WORKTREE",
] as const;

let root: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "drive-pr-review-failure-"));
  // One project entry makes the Claude walk visit an entry, which is where
  // the zero-millisecond budget cuts it short; the Codex root is an empty
  // directory so the host's own sessions never decide the outcome.
  mkdirSync(join(root, "claude", "project"), { recursive: true });
  mkdirSync(join(root, "codex"), { recursive: true });
  process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.DRIVE_PR_CODEX_SESSIONS_DIR = join(root, "codex");
  process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
  // The failure report probes the tree the pass left; point it at an empty
  // scratch directory so the host's checkout never decides the outcome.
  mkdirSync(join(root, "tree"), { recursive: true });
  process.env.DRIVE_PR_WORKTREE = join(root, "tree");
  driverRuntime.quotaScanTruncated = [];
});

afterEach(() => {
  driverRuntime.quotaScanTruncated = [];
  rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function failedPass(
  checkpoint: DriveRoundContext["mailboxCheckpoint"],
): Promise<number | "continue"> {
  const context = { mailboxCheckpoint: checkpoint } as DriveRoundContext;
  const snapshot: QuotaSnapshot = {
    files: new Set(),
    truncatedByVendor: new Map([["claude", true]]),
  };
  return await handleFailedReviewPass(
    { code: 1, timedOut: false } as never,
    5400,
    3,
    null,
    context,
    Temporal.Now.instant(),
    new Set(),
    null,
    snapshot,
    { kind: "failed", exit: 1 },
  );
}

test("an unreadable mailbox at the failure report clears the cut-short scan note", async () => {
  const realError = console.error;
  console.error = () => undefined;
  try {
    expect(await failedPass(async () => 1)).toBe(1);
  } finally {
    console.error = realError;
  }
  expect(driverRuntime.quotaScanTruncated).toEqual([]);
});

test("a clear mailbox keeps the cut-short scan note for the failure report", async () => {
  const realError = console.error;
  console.error = () => undefined;
  try {
    await failedPass(async () => "clear");
  } finally {
    console.error = realError;
  }
  expect(driverRuntime.quotaScanTruncated).toContain("claude");
});
