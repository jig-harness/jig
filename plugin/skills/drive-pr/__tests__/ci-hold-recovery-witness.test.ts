import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDriverRecord,
  removeDriverRecord,
  writeDriverRecord,
} from "../scripts/lib/ledger-stop.ts";
import { unconcludedGitOpMarker, gitIdentityEnv } from "../scripts/lib/proc.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { writeState } from "./state-rows.ts";

it("keeps a termination witness after ledger settlement until the CI hold is released", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-hold-witness-"));
  try {
    const dir = scopedStateDir(root);
    const state = freshState(123);
    state.ciHold = {
      phase: "held",
      eventId: "42",
      actor: "operator",
      addedAtHead: "a".repeat(40),
      createdAt: "2026-11-06T12:00:00Z",
      checkRunWatermark: 1,
    };
    writeState(dir, "123", state);
    const record = {
      worktree: root,
      started: "2026-11-06T12:00:00Z",
      pid: 12345,
      host: "test-host",
      released: true as const,
    };
    writeDriverRecord(dir, "123", record);
    removeDriverRecord(dir, "123", record.started);
    expect(readDriverRecord(dir, "123")).toEqual(record);
    state.ciHold = {
      phase: "released",
      eventId: "43",
      head: "a".repeat(40),
      actor: "operator",
      createdAt: record.started,
      checkRunWatermark: 1,
      source: "drive",
    };
    writeState(dir, "123", state);
    removeDriverRecord(dir, "123", record.started);
    expect(readDriverRecord(dir, "123")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains Git's diagnostic when the worktree is no longer a repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-hold-git-failure-"));
  try {
    const result = await unconcludedGitOpMarker(5, {
      cwd: root,
      env: gitIdentityEnv(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("git rev-parse --git-dir exited 128:");
      expect(result.reason).toContain("not a git repository");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const state of [{}, { ...freshState(123), ciHold: "held" }, "{"]) {
  it(`retains a termination witness for unreadable saved state ${JSON.stringify(state)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "ci-hold-invalid-witness-"));
    try {
      const dir = scopedStateDir(root);
      const record = {
        worktree: root,
        started: "2026-11-06T12:00:00Z",
        pid: 12345,
        host: "test-host",
        released: true as const,
      };
      writeState(dir, "123", state);
      writeDriverRecord(dir, "123", record);
      removeDriverRecord(dir, "123", record.started);
      expect(readDriverRecord(dir, "123")).toEqual(record);
      writeState(dir, "123", freshState(123));
      removeDriverRecord(dir, "123", record.started);
      expect(readDriverRecord(dir, "123")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
