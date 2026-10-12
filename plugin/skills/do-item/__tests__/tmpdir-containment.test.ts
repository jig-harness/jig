/**
 * Containment probe: the repository's root `bunfig.toml` preloads the
 * temp-dir scope (`lib/test-tmpdir-bun-preload.ts`) for every `bun test` run
 * from the repository root, this suite included. Bun resolves `bunfig.toml`
 * from the working directory only, so a run from inside this directory gets
 * no preload; this probe fails loudly instead of letting scratch directories
 * leak into the system temp dir. `JIG_TEST_TMPDIR_SYSTEM` is published
 * by the preload itself (see `lib/test-tmpdir.ts`).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCOPED_ROOT = process.env.JIG_TEST_TMPDIR;
const SYSTEM_TMPDIR = process.env.JIG_TEST_TMPDIR_SYSTEM;

describe("temp-dir containment (root preload)", () => {
  it("the root preload is applied to this suite", () => {
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
