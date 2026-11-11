/** The claim settings a repository's `do_item` section sets. */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimSettingsFromDefaultBranch,
  claimSettingsOf,
} from "../scripts/lib/claim-settings.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/** A clone whose default branch holds `committed` as `.config/jig.yaml`. */
function clone(committed: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-claim-settings-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".config"));
  writeFileSync(join(dir, ".config", "jig.yaml"), committed);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    dir,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  return dir;
}

describe("claimSettingsOf", () => {
  it("keeps today's claim when nothing is set", () => {
    for (const overlay of [null, {}, { do_item: {} }, { do_item: null }])
      expect(claimSettingsOf(overlay)).toEqual({
        claimFrom: null,
        claimMarker: false,
      });
  });

  it("reads claim_from and claim_marker", () => {
    expect(
      claimSettingsOf({
        do_item: { claim_from: ["todo", "backlog"], claim_marker: true },
      }),
    ).toEqual({ claimFrom: ["todo", "backlog"], claimMarker: true });
  });

  it("refuses a claim_from the claim cannot use", () => {
    for (const value of [
      [],
      "todo",
      ["ready"],
      ["todo", "todo"],
      ["in_progress"],
      ["todo", "pr_open"],
    ])
      expect(() => claimSettingsOf({ do_item: { claim_from: value } })).toThrow(
        "do_item.claim_from",
      );
  });

  it("refuses a claim_marker that is not true or false", () => {
    expect(() => claimSettingsOf({ do_item: { claim_marker: "yes" } })).toThrow(
      "do_item.claim_marker",
    );
  });
});

describe("claimSettingsFromDefaultBranch", () => {
  it("keeps the restriction the default branch sets, whatever the working tree sets", async () => {
    const dir = clone("do_item:\n  claim_from: [todo]\n");
    const out = await claimSettingsFromDefaultBranch(dir, {
      do_item: { claim_from: ["backlog"], claim_marker: true },
    });
    expect(out).toEqual({
      ok: true,
      value: { claimFrom: ["todo"], claimMarker: false },
    });
  });

  it("never drops a restriction when the other field is unset or unusable", async () => {
    const unset = clone("do_item:\n  claim_from: [todo]\n");
    expect(await claimSettingsFromDefaultBranch(unset, null)).toEqual({
      ok: true,
      value: { claimFrom: ["todo"], claimMarker: false },
    });
    const bad = clone("do_item:\n  claim_from: [todo]\n  claim_marker: 3\n");
    await expect(claimSettingsFromDefaultBranch(bad, null)).rejects.toThrow(
      "do_item.claim_marker",
    );
  });

  it("refuses a working tree that sets either field when the default branch cannot be read", async () => {
    const dir = clone("do_item: [unclosed\n");
    for (const section of [{ claim_from: ["todo"] }, { claim_marker: true }]) {
      const out = await claimSettingsFromDefaultBranch(dir, {
        do_item: section,
      });
      expect(out.ok).toBe(false);
    }
    expect(await claimSettingsFromDefaultBranch(dir, null)).toEqual({
      ok: true,
      value: { claimFrom: null, claimMarker: false },
    });
  });
});
