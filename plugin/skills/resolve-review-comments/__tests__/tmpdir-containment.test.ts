/**
 * TASK — containment probe for this directory's own `bunfig.toml`.
 *
 * See .claude/skills/drive-pr/__tests__/tmpdir-containment.test.ts for the
 * full reasoning — same gap (Bun resolves `bunfig.toml` from cwd only, with
 * no directory walk-up), same fix (this directory's own `bunfig.toml`), same
 * probe. This is the `rrc-scripts-*` leak's route.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCOPED_ROOT = process.env.GROUNDWORK_TEST_TMPDIR;
const SYSTEM_TMPDIR = process.env.GROUNDWORK_TEST_TMPDIR_SYSTEM;

describe("temp-dir containment (this directory)", () => {
  it("the preload is applied when bun test runs with cwd here", () => {
    expect(SCOPED_ROOT).toBeString();
    expect(SYSTEM_TMPDIR).toBeString();
    expect(tmpdir()).toBe(SCOPED_ROOT as string);
    expect(SCOPED_ROOT).not.toBe(SYSTEM_TMPDIR);
  });

  it("scratch created here nests under the scoped root, not the system temp dir", () => {
    const probe = mkdtempSync(join(tmpdir(), "containment-probe-"));
    try {
      expect(probe.startsWith(SCOPED_ROOT as string)).toBe(true);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });
});
