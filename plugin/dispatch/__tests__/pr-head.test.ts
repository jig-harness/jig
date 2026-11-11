import { describe, expect, it } from "bun:test";
import { openBranch } from "../../shared/orca-workspace/open.ts";
import type { OpenPort } from "../../shared/orca-workspace/port.ts";
import type { Context, RunResult } from "../../shared/orca-workspace/runner.ts";
import { ok } from "../../shared/outcome.ts";
import { resolvePullRequestHead } from "../lib/runtime/orca-pr-head.ts";

const SHA = "a".repeat(40);
const META = {
  state: "OPEN",
  headRefName: "feature",
  headRefOid: SHA,
  isCrossRepository: false,
  headRepositoryOwner: { login: "example-org" },
  headRepository: { name: "example-repo" },
  url: "https://github.com/example-org/example-repo/pull/7",
};
const answer = (stdout = "", status = 0): RunResult => ({
  stdout,
  status,
  stderr: "",
});
function context(
  overrides: Record<string, RunResult> = {},
): Context & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    stateDir: "/state",
    log() {
      /* The fixture does not display progress. */
    },
    sleep() {
      /* The fixture has no retry delay. */
    },
    run(argv) {
      const cmd = argv.join(" ");
      calls.push(cmd);
      if (overrides[cmd]) return overrides[cmd];
      if (argv[0] === "gh") return answer(JSON.stringify(META));
      if (argv.includes("get-url"))
        return answer("git@github.com:example-org/example-repo.git\n");
      if (argv[0] === "git" && argv[1] === "config") return answer("", 1);
      if (argv[0] === "ssh" && argv[1] === "-G")
        return answer("hostname github.com\n");
      if (argv.includes("ls-remote"))
        return answer(`${SHA}\trefs/heads/feature\n`);
      if (argv[0] === "test") return answer("", 1);
      if (argv.includes("check-ref-format")) return answer();
      if (argv.includes("list"))
        return answer(
          "worktree /repo\0branch refs/heads/main\0\0worktree /tree\0branch refs/heads/feature\0\0",
        );
      if (argv.includes("--absolute-git-dir"))
        return answer("/repo/.git/worktrees/tree\n");
      if (argv.includes("--git-common-dir")) return answer("/repo/.git\n");
      if (argv.includes("fetch")) return answer();
      if (argv.includes("rev-parse")) return answer(SHA);
      if (argv.includes("branch")) return answer();
      throw new Error(`unexpected fixture call: ${cmd}`);
    },
  };
}

describe("PR workspace head proof", () => {
  it("accepts a same-repository remote head at its reported SHA", async () => {
    expect(
      await resolvePullRequestHead(context(), "/repo", 7, "feature"),
    ).toEqual(ok(SHA));
  });
  it("uses the PR URL's forge host when verifying an Enterprise SSH origin", async () => {
    const ctx = context({
      "git -C /repo remote get-url --all origin": answer(
        "git@ghe.example:example-org/example-repo.git\n",
      ),
      "git -C /repo remote get-url --push --all origin": answer(
        "git@ghe.example:example-org/example-repo.git\n",
      ),
    });
    const run = ctx.run;
    ctx.run = (argv, options) => {
      if (argv[0] === "gh")
        return answer(
          JSON.stringify({
            ...META,
            url: "https://ghe.example/example-org/example-repo/pull/7",
          }),
        );
      if (argv[0] === "ssh") {
        ctx.calls.push(argv.join(" "));
        return answer("hostname ghe.example\n");
      }
      return run(argv, options);
    };
    expect(await resolvePullRequestHead(ctx, "/repo", 7, "feature")).toEqual(
      ok(SHA),
    );
    expect(ctx.calls).toContain("git config --get core.sshCommand");
    expect(ctx.calls).toContain("ssh -G -- git@ghe.example");
  });
  for (const meta of [
    { ...META, isCrossRepository: true },
    { ...META, headRepository: null },
    { ...META, headRefOid: "" },
    { ...META, headRefName: "renamed" },
    { ...META, state: "CLOSED" },
  ])
    it(`refuses an unproven head ${JSON.stringify(meta)}`, async () => {
      const ctx = context();
      const run = ctx.run;
      ctx.run = (argv, opts) =>
        argv[0] === "gh" ? answer(JSON.stringify(meta)) : run(argv, opts);
      expect(
        (await resolvePullRequestHead(ctx, "/repo", 7, "feature")).ok,
      ).toBe(false);
      expect(ctx.calls).toEqual([]);
    });
  for (const remote of [
    answer("", 2),
    answer(`${"b".repeat(40)}\trefs/heads/feature\n`),
    answer(`${SHA}\trefs/heads/other\n`),
  ])
    it("refuses an absent or moved origin branch", async () => {
      expect(
        (
          await resolvePullRequestHead(
            context({
              "git -C /repo ls-remote --exit-code origin refs/heads/feature":
                remote,
            }),
            "/repo",
            7,
            "feature",
          )
        ).ok,
      ).toBe(false);
    });
  it("refuses a different push repository even when the fetch URL matches", async () => {
    expect(
      (
        await resolvePullRequestHead(
          context({
            "git -C /repo remote get-url --push --all origin": answer(
              "git@github.com:other/repo.git",
            ),
          }),
          "/repo",
          7,
          "feature",
        )
      ).ok,
    ).toBe(false);
  });
  it("preserves authentication failures in its refusal", async () => {
    const result = await resolvePullRequestHead(
      context({
        "git -C /repo ls-remote --exit-code origin refs/heads/feature": {
          status: 128,
          stdout: "",
          stderr: "Authentication failed",
        },
      }),
      "/repo",
      7,
      "feature",
    );
    expect(result).toMatchObject({
      ok: false,
      failure: {
        reason: expect.stringContaining("exit 128): Authentication failed"),
      },
    });
  });
  it("refuses a stale same-named checkout before running its create hook", () => {
    const ctx = context({
      "git -C /tree rev-parse HEAD": answer("b".repeat(40)),
    });
    let hookRan = false;
    const port: OpenPort = {
      host: ctx,
      where: "",
      runHook() {
        hookRan = true;
      },
      orcaCall: () =>
        ok({
          ok: true,
          result: {
            worktrees: [{ id: "tree", path: "/tree", branch: "feature" }],
          },
        }) as never,
    };
    expect(() =>
      openBranch(port, {
        repo: { id: "repo", path: "/repo" },
        branch: "feature",
        expectedHead: SHA,
      }),
    ).toThrow("does not match the pull request head");
    expect(hookRan).toBe(false);
    expect(ctx.calls.some((c) => c.includes("test -x"))).toBe(false);
  });
});
