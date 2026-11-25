import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMarkerSha } from "../scripts/lib/status/reviewed-sha.ts";

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString().trim();
}

describe("resolveMarkerSha", () => {
  it("resolves an abbreviation as an object id, never as a ref of that name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-marker-"));
    sh(dir, "init", "-q");
    sh(dir, "commit", "-q", "--allow-empty", "-m", "one");
    const first = sh(dir, "rev-parse", "HEAD");
    sh(dir, "commit", "-q", "--allow-empty", "-m", "two");
    const second = sh(dir, "rev-parse", "HEAD");
    const abbrev = first.slice(0, 10);
    // A branch spelled like the abbreviation points at another commit.
    sh(dir, "branch", abbrev, second);
    expect(await resolveMarkerSha(abbrev, dir)).toBe(first);
  });

  it("returns nothing for a name that is not hex or an unknown prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-marker-"));
    sh(dir, "init", "-q");
    sh(dir, "commit", "-q", "--allow-empty", "-m", "one");
    expect(await resolveMarkerSha("main", dir)).toBe("");
    expect(await resolveMarkerSha("deadbeef0", dir)).toBe("");
  });
});
