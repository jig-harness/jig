/**
 * The structural-churn brake's reads around a round: the blob ids
 * `readRoundBlobs` takes from `git cat-file --batch-check`, which are
 * best-effort but never silent when the read fails, and the gate the brake
 * ends when the round's evidence did not land.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRoundBlobs } from "../scripts/lib/status/round-blobs.ts";
import { runChurnBrake } from "../scripts/lib/status/churn-brake.ts";

const repo = mkdtempSync(join(tmpdir(), "round-blobs-"));
const notRepo = mkdtempSync(join(tmpdir(), "round-blobs-none-"));
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(notRepo, { recursive: true, force: true });
});

/** `git` in the scratch repository, with no inherited git variables. */
function git(...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd: repo, env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

git("init", "-q");
writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
writeFileSync(join(repo, "b c.ts"), "export const b = 2;\n");
git("add", ".");
git("commit", "-q", "-m", "seed");
const head = git("rev-parse", "HEAD");

describe("readRoundBlobs", () => {
  it("reads each present path's blob and leaves a missing path out", async () => {
    const blobs = await readRoundBlobs(
      head,
      ["a.ts", "gone.ts", "b c.ts"],
      30,
      repo,
    );
    expect(blobs).toEqual({
      "a.ts": git("rev-parse", `${head}:a.ts`),
      "b c.ts": git("rev-parse", `${head}:b c.ts`),
    });
  });

  it("returns no blobs and says why on stderr when git fails", async () => {
    const said: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      expect(await readRoundBlobs(head, ["a.ts"], 30, notRepo)).toEqual({});
    } finally {
      spy.mockRestore();
    }
    const text = said.join("");
    expect(text).toContain("structural-churn brake");
    expect(text).toMatch(/git cat-file exited \d+/);
  });
});

describe("runChurnBrake", () => {
  it("ends the gate INDETERMINATE when the round's evidence did not land", async () => {
    const report = {
      state: "ROUND_READY",
      reason: "",
      parkedItemKeys: null,
      actionableParkKeys: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      apiHead: head,
      baseRefName: "main",
    };
    const ctx = {
      pr: "999",
      driveStateScript: join(notRepo, "absent.ts"),
      helperTimeoutSec: 5,
    };
    expect(await runChurnBrake(ctx, report, false)).toBe(1);
    expect(report.state).toBe("INDETERMINATE");
    expect(report.reason).toContain("could not be recorded");
  });
});
