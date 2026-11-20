/**
 * drive-pr suite: drive-status.ts reads the pull request over one conditional
 * REST read per evaluation (`lib/status/pr-snapshot.ts`), never `gh pr view`.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import {
  HEAD,
  DORMANT_ARM,
  writeFixture,
  probeIn,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

function lines(dir: string, name: string): string[] {
  const file = join(dir, name);
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

/** The pull document's cache, on for these probes alone. */
function cacheEnv(dir: string): Record<string, string> {
  return { JIG_GH_CACHE: "", JIG_GH_CACHE_DIR: join(dir, "gh-cache") };
}

describe("drive-status.ts reads the pull request conditionally", () => {
  it("two evaluations of an unchanged pull request read it once in full, then once answered 304", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      checkRuns: [DORMANT_ARM],
      pullEtag: '"pull-1"',
    });
    const first = await probeIn(dir, stateDir, HEAD, [], {
      reconcile: false,
      env: cacheEnv(dir),
    });
    const second = await probeIn(dir, stateDir, HEAD, [], {
      reconcile: false,
      env: cacheEnv(dir),
    });

    expect(first.state).toBe("AWAITING_REVIEWER");
    expect(second.state).toBe(first.state);
    expect(second.json.apiHead).toBe(first.json.apiHead);
    expect(second.json.merge).toEqual(first.json.merge);
    expect(lines(dir, "pull-reads")).toEqual(["200 snapshot", "304 snapshot"]);
    expect(lines(dir, "graphql-pull-reads")).toEqual([]);
  });

  it("a terminal verdict's recheck is the same conditional read, answered 304 when nothing moved", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: HEAD,
      pullEtag: '"pull-1"',
    });
    const r = await probeIn(dir, stateDir, HEAD, [], {
      reconcile: false,
      env: cacheEnv(dir),
    });

    expect(r.state).toBe("CONVERGED");
    expect(lines(dir, "pull-reads")).toEqual([
      "200 snapshot",
      "304 still-on-head",
    ]);
    expect(lines(dir, "graphql-pull-reads")).toEqual([]);
  });

  it("resolves a pull request URL or a branch of this repository", async () => {
    for (const pr of [
      "https://github.com/example-org/example-repo/pull/999",
      "feature-branch",
    ]) {
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [DORMANT_ARM],
      });
      const r = await probeIn(dir, stateDir, HEAD, [], {
        reconcile: false,
        pr,
      });

      expectSpawnExit(
        { ...r, stdout: JSON.stringify(r.json) },
        4,
        "drive-status",
      );
      expect(r.state).toBe("AWAITING_REVIEWER");
    }
  });

  it("refuses a URL of another repository or host before reading the pull request", async () => {
    for (const pr of [
      "https://github.com/other-org/example-repo/pull/999",
      "https://github.example.com/example-org/example-repo/pull/999",
    ]) {
      const { dir, stateDir } = writeFixture({ threads: [] });
      const r = await probeIn(dir, stateDir, HEAD, [], {
        reconcile: false,
        pr,
      });

      expectSpawnExit(
        { ...r, stdout: JSON.stringify(r.json) },
        2,
        "drive-status",
      );
      expect(r.stderr).toMatch(/not in this checkout|another forge host/);
      expect(lines(dir, "pull-reads")).toEqual([]);
    }
  });
});
