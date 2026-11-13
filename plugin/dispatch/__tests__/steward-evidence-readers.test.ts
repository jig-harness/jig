import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { numberKeys } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { failed, ok } from "../../shared/outcome.ts";
import { treeEvidence, evidenceCommand } from "../lib/steward-evidence-git.ts";
import type { RunResult } from "../../shared/proc.ts";
import {
  linkedPullRequests,
  pullRequestChecks,
  type EvidenceJson,
} from "../lib/steward-evidence-forge.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { RepoObservation } from "../lib/tick-observe.ts";

const observation = {
  opened: { repo: { slug: "example/repo", path: "/repo" } },
  join: {
    keys: numberKeys("example/repo"),
    branchPattern: "{key_lower}-{slug}",
  },
  tracked: { issueRepository: "example/repo" },
  sessions: {
    ok: true,
    workspaces: [{ path: "/pickup", branch: "topic", prs: [8] }],
  },
} as unknown as RepoObservation;

describe("steward evidence readers", () => {
  test("failed commands retain bounded stderr and process failure metadata as untrusted data", async () => {
    const result: RunResult = {
      code: 7,
      stdout: "",
      stderr: "",
      stderrTail: `${"x".repeat(4000)}\npermission denied`,
      timedOut: false,
      spawnFailed: false,
      bufferExceeded: true,
    };
    const read = await evidenceCommand(
      ["gh", "api"],
      "/repo",
      () => null,
      undefined,
      async () => result,
    );
    expect(read).toMatchObject({
      ok: false,
      failure: {
        code: "unreadable",
        cause: {
          untrusted: true,
          code: 7,
          timedOut: false,
          spawnFailed: false,
          bufferExceeded: true,
          stderrTail: expect.stringContaining("permission denied"),
        },
      },
    });
    if (!read.ok)
      expect(JSON.stringify(read.failure.cause).length).toBeLessThan(2300);
  });

  test("a thrown command error remains the failure's cause", async () => {
    const error = new Error("spawn refused");
    const read = await evidenceCommand(
      ["git", "status"],
      "/repo",
      () => null,
      undefined,
      async () => {
        throw error;
      },
    );
    expect(read).toMatchObject({
      ok: false,
      failure: { code: "unreadable", cause: error },
    });
  });

  test("git reports dirty files, operation and commits relative to the local upstream", async () => {
    const path = mkdtempSync(join(tmpdir(), "steward-tree-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", path, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(result, 0);
      return result.stdout.toString().trim();
    };
    try {
      git("init", "--initial-branch=main");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      );
      const initial = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", initial);
      git("config", "remote.origin.url", "https://example.test/repo.git");
      git(
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
      );
      git("branch", "--set-upstream-to=origin/main", "main");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "ahead",
      );
      const head = git("rev-parse", "HEAD");
      writeFileSync(join(path, "dirty.txt"), "data");
      writeFileSync(join(path, ".git", "MERGE_HEAD"), initial);
      const read = await treeEvidence(path, () => null);
      expect(read).toMatchObject({
        ok: true,
        value: {
          branch: "main",
          head,
          operation: "merge",
          uncommitted: ["?? dirty.txt"],
          unpushed: {
            ok: true,
            value: {
              commits: [head],
              against: "origin/main",
              truncated: false,
            },
          },
        },
      });
      git("config", "--unset", "branch.main.remote");
      expect(await treeEvidence(path, () => null)).toMatchObject({
        ok: true,
        value: {
          unpushed: {
            ok: false,
            failure: {
              cause: {
                code: "unreadable",
                cause: { stderrTail: expect.stringContaining("no upstream") },
              },
            },
          },
        },
      });
      expect(await treeEvidence(path, () => 0)).toMatchObject({ ok: false });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("open and merged links exclude closed PRs, code-only references and wrong item numbers", async () => {
    const pr = (number: number, state: string, body: string) => ({
      number,
      state,
      body,
      url: `https://example.test/pull/${number}`,
      headRefName: "topic",
      createdAt: "2026-01-03",
      closingIssuesReferences: [],
    });
    const records = [
      {
        record: {
          id: "launch",
          repo: "example/repo",
          item: "#7",
          action: "pickup",
          createdAt: "2026-01-01",
          workspace: { path: "/pickup" },
        },
        next: { address: "drive@example/repo#8" },
      },
    ] as unknown as ReadRecord[];
    const rows = [
      pr(8, "OPEN", "Closes #7"),
      pr(9, "MERGED", "Related to #7"),
      pr(10, "CLOSED", "Closes #7"),
      pr(11, "OPEN", "`Closes #7`"),
      pr(12, "OPEN", "Closes #70"),
      pr(13, "OPEN", "Related to other/repo#7"),
      pr(14, "OPEN", "<!-- Implements #7 -->"),
    ];
    const readJson: EvidenceJson = async (args) =>
      args[1] === "view" ? ok(rows[0]) : ok(rows);
    const read = await linkedPullRequests(
      "#7",
      observation,
      records,
      () => null,
      readJson,
    );
    expect(read).toMatchObject({
      ok: true,
      value: [
        {
          number: 8,
          state: "OPEN",
          launch: "launch",
          launchProvenance: "inferred",
        },
        {
          number: 9,
          state: "MERGED",
          launch: null,
          launchProvenance: "unknown",
        },
      ],
    });
    expect(
      await linkedPullRequests(
        "#7",
        observation,
        records,
        () => null,
        async () => ok(Array(50).fill({})),
      ),
    ).toMatchObject({ ok: false });
  });

  test("failing checks carry earlier head attempts and base conclusions, pinned to the PR's commits", async () => {
    const calls: string[][] = [];
    const readJson: EvidenceJson = async (args) => {
      calls.push(args);
      if (args[0] === "pr")
        return ok({ headRefOid: "head-sha", baseRefOid: "base-sha" });
      if (args[1]?.includes("statuses")) return ok([]);
      if (args[1]?.includes("base-sha"))
        return ok({
          check_runs: [
            { name: "test", conclusion: "success", completed_at: "2026-01-02" },
          ],
        });
      return ok({
        check_runs: [
          { name: "test", conclusion: "failure", completed_at: "2026-01-03" },
          { name: "test", conclusion: "success", completed_at: "2026-01-01" },
          { name: "lint", conclusion: "success", completed_at: "2026-01-03" },
        ],
      });
    };
    const read = await pullRequestChecks(8, observation, () => null, readJson);
    expect(read).toMatchObject({
      ok: true,
      value: {
        pr: 8,
        head: "head-sha",
        base: "base-sha",
        failing: [
          {
            name: "test",
            head: [{ conclusion: "failure" }, { conclusion: "success" }],
            base: [{ conclusion: "success" }],
          },
        ],
      },
    });
    expect(calls).toHaveLength(5);
    expect(
      await pullRequestChecks(
        8,
        observation,
        () => null,
        async () => failed("unreadable", "offline"),
      ),
    ).toMatchObject({ ok: false });
  });

  test("a new pending attempt supersedes an older failure even before it has a completion time", async () => {
    const readJson: EvidenceJson = async (args) => {
      if (args[0] === "pr")
        return ok({ headRefOid: "head-sha", baseRefOid: "base-sha" });
      if (args[1]?.includes("statuses")) return ok([]);
      if (args[1]?.includes("base-sha")) return ok({ check_runs: [] });
      return ok({
        check_runs: [
          {
            id: 2,
            name: "test",
            conclusion: null,
            started_at: "2026-01-03",
            completed_at: null,
          },
          {
            id: 1,
            name: "test",
            conclusion: "failure",
            started_at: "2026-01-01",
            completed_at: "2026-01-02",
          },
        ],
      });
    };
    expect(
      await pullRequestChecks(8, observation, () => null, readJson),
    ).toMatchObject({ ok: true, value: { failing: [] } });
  });

  test("a same-named status cannot hide a failing check from another source", async () => {
    const readJson: EvidenceJson = async (args) => {
      if (args[0] === "pr")
        return ok({ headRefOid: "head-sha", baseRefOid: "base-sha" });
      if (args[1]?.includes("statuses"))
        return ok([
          {
            id: 99,
            context: "test",
            state: "success",
            created_at: "2026-01-03",
          },
        ]);
      return ok({
        check_runs: [
          {
            id: 1,
            name: "test",
            conclusion: "failure",
            started_at: "2026-01-01",
            completed_at: "2026-01-02",
            app: { slug: "ci" },
          },
        ],
      });
    };
    expect(
      await pullRequestChecks(8, observation, () => null, readJson),
    ).toMatchObject({ ok: true, value: { failing: [{ name: "test" }] } });
  });
});
