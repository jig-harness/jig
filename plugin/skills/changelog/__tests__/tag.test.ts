import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  type CommitCheck,
  type Gh,
  github,
  type Hosting,
  type RequiredCheck,
} from "../scripts/hosting.ts";
import { ConfigurationError } from "../scripts/errors.ts";
import { runStatus } from "../scripts/status.ts";
import {
  judgeCheck,
  newestTag,
  type PlanSources,
  planTags,
  runTag,
  type TagPlan,
} from "../scripts/tag.ts";
import {
  cleanEnv,
  commit,
  git,
  jigYaml,
  repository,
  temporary,
} from "./scratch.ts";

/** A Keep a Changelog file with a release heading for each of `versions`, newest first. */
const changelog = (...versions: string[]): string =>
  [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    ...versions.flatMap((v) => [
      `## [${v}] - 2026-01-02`,
      "",
      "### Fixed",
      "",
      `- ${v}`,
      "",
    ]),
  ].join("\n");

const config = (extra = ""): string =>
  jigYaml(`  file: CHANGELOG.md\n  version: { tags: true }${extra}`);

/** A repository on `main` whose first commit released 1.2.0. */
function released(extra = ""): string {
  return repository({
    "CHANGELOG.md": changelog("1.2.0"),
    ".config/jig.yaml": config(extra),
  });
}

const head = (root: string, rev = "HEAD"): string =>
  git(root, "rev-parse", rev).trim();

const env = () => ({ JIG_HOME: temporary("jig-home-") });

const passed = (
  name: string,
  extra: Partial<CommitCheck> = {},
): CommitCheck => ({
  name,
  kind: "check-run",
  outcome: "passed",
  conclusion: "success",
  app: 15368,
  ...extra,
});

/** A hosting service that answers from `checks` by commit, requiring `required`. */
function fake(
  checks: Record<string, CommitCheck[]>,
  required: RequiredCheck[] | null = [{ name: "test", apps: [] }],
  reruns: number[] = [],
): Hosting {
  return {
    name: "fake",
    defaultBranch: () => "main",
    lastReleaseRun: () => ({ state: "success", detail: "fine" }),
    requiredChecks: () =>
      required === null
        ? { known: false, detail: "offline" }
        : { known: true, value: required },
    commitChecks: (sha) => ({ known: true, value: checks[sha] ?? [] }),
    rerun: (run) => {
      reruns.push(run);
      return null;
    },
  };
}

/** The plan, origin answering that it holds `tagged`. */
function plan(
  root: string,
  hosting: Hosting,
  tagged: string[] = ["v1.2.0"],
): TagPlan {
  const sources: PlanSources = { hosting, tags: () => new Set(tagged) };
  const result = planTags(root, sources, env());
  if (result === null) throw new Error("not configured");
  return result;
}

describe("the releasing commit", () => {
  test("is the first first-parent commit with the heading, not the merged branch's commit that had it earlier", () => {
    const root = released();
    git(root, "checkout", "-qb", "side");
    commit(
      root,
      { "CHANGELOG.md": changelog("1.3.0", "1.2.0") },
      "release on a branch",
    );
    const onSide = head(root);
    git(root, "checkout", "-q", "main");
    commit(root, { "src/x.ts": "x\n" }, "unrelated");
    git(root, "merge", "-q", "--no-ff", "side", "-m", "merge side");
    const merge = head(root);
    const result = plan(root, fake({ [merge]: [passed("test")] }));
    expect(result.versions).toMatchObject([
      { version: "1.3.0", commit: merge, state: "ready" },
    ]);
    expect(result.versions[0]?.commit).not.toBe(onSide);
  });

  test("a squashed or direct commit releases the version it adds", () => {
    const root = released();
    commit(
      root,
      { "CHANGELOG.md": changelog("1.3.0", "1.2.0") },
      "release (#4)",
    );
    const release = head(root);
    commit(root, { "src/x.ts": "x\n" }, "later");
    const result = plan(root, fake({ [release]: [passed("test")] }));
    expect(result.versions).toMatchObject([
      { tag: "v1.3.0", commit: release, state: "ready" },
    ]);
    expect(result.ready).toEqual([
      { tag: "v1.3.0", commit: release, message: "v1.3.0" },
    ]);
  });

  test("a merge commit whose tree matches the merged branch still releases it", () => {
    const root = released();
    git(root, "checkout", "-qb", "side");
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "side", "-m", "merge side");
    const merge = head(root);
    expect(plan(root, fake({})).versions).toMatchObject([
      { version: "1.3.0", commit: merge },
    ]);
  });

  test("a later commit's success never stands in for the releasing commit's", () => {
    const root = released();
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    const release = head(root);
    commit(root, { "src/x.ts": "x\n" }, "later");
    const result = plan(root, fake({ [head(root)]: [passed("test")] }));
    expect(result.versions).toMatchObject([
      {
        commit: release,
        state: "pending",
        checks: [{ name: "test", verdict: "missing" }],
      },
    ]);
    expect(result.ready).toEqual([]);
  });

  test("headings that arrived together in one commit were released by none", () => {
    const root = repository({
      "CHANGELOG.md": changelog("1.1.0", "1.0.0"),
      ".config/jig.yaml": config(),
    });
    const result = plan(root, fake({}), ["v0.9.0"]);
    expect(result.versions.map((v) => [v.tag, v.state])).toEqual([
      ["v1.0.0", "imported"],
      ["v1.1.0", "imported"],
    ]);
    expect(result.ready).toEqual([]);
  });

  test("a shallow clone is refused", () => {
    const origin = released();
    commit(origin, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    const clone = join(temporary(), "clone");
    git(origin, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    expect(() => plan(clone, fake({}))).toThrow(/shallow clone/);
  });
});

describe("the tags on origin", () => {
  test("a version origin has a tag for is skipped; a tag only in this clone counts for nothing", () => {
    const bare = temporary();
    git(bare, "init", "-q", "--bare");
    const root = released();
    git(root, "remote", "add", "origin", bare);
    git(root, "tag", "-a", "v1.2.0", "-m", "v1.2.0");
    git(root, "push", "-q", "origin", "main", "v1.2.0");
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    git(root, "push", "-q", "origin", "main");
    git(root, "fetch", "-q", "origin");
    git(root, "tag", "v1.3.0");
    const result = planTags(root, { hosting: fake({}) }, env());
    expect(result?.ref).toBe("origin/main");
    expect(result?.versions.map((v) => v.tag)).toEqual(["v1.3.0"]);
  });

  test("only versions newer than origin's newest tag are owed one", () => {
    const root = repository({
      "CHANGELOG.md": changelog("1.1.0"),
      ".config/jig.yaml": config(),
    });
    commit(root, { "CHANGELOG.md": changelog("1.2.0", "1.1.0") }, "1.2.0");
    commit(
      root,
      { "CHANGELOG.md": changelog("1.3.0", "1.2.0", "1.1.0") },
      "1.3.0",
    );
    const release = head(root);
    // 1.1.0 has no tag, but is older than v1.2.0: never tagged behind a person's back.
    const result = plan(root, fake({ [release]: [passed("test")] }), [
      "v1.2.0",
      "v-nightly",
    ]);
    expect(result.newestTag).toBe("v1.2.0");
    expect(result.versions.map((v) => v.tag)).toEqual(["v1.3.0"]);
  });

  test("with no release tag on origin, only the newest release heading is owed one", () => {
    const root = repository({
      "CHANGELOG.md": changelog("1.1.0"),
      ".config/jig.yaml": config(),
    });
    commit(root, { "CHANGELOG.md": changelog("1.2.0", "1.1.0") }, "1.2.0");
    const release = head(root);
    const result = plan(root, fake({ [release]: [passed("test")] }), []);
    expect(result.newestTag).toBeNull();
    expect(result.versions.map((v) => [v.tag, v.state])).toEqual([
      ["v1.2.0", "ready"],
    ]);
  });

  test("the newest tag is the highest version, a pre-release below its release", () => {
    expect(
      newestTag(new Set(["v1.10.0", "v1.9.0", "v2.0.0-rc.1", "vnext"]), "v"),
    ).toBe("2.0.0-rc.1");
    expect(newestTag(new Set(["v2.0.0-rc.1", "v2.0.0"]), "v")).toBe("2.0.0");
    expect(newestTag(new Set(["release-1.0.0"]), "v")).toBeNull();
  });

  test("nothing owed reads no checks and is exit 0", () => {
    const root = released();
    const result = plan(root, fake({}, null));
    expect(result).toMatchObject({
      versions: [],
      ready: [],
      requiredChecks: null,
    });
  });
});

describe("the required checks", () => {
  const releasedNow = (extra = "") => {
    const root = released(extra);
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    return { root, release: head(root) };
  };

  test("check runs and commit statuses are read together", () => {
    const { root, release } = releasedNow();
    const status: CommitCheck = {
      name: "ci/legacy",
      kind: "status",
      outcome: "passed",
      conclusion: "success",
      app: null,
    };
    const required = [
      { name: "test", apps: [] },
      { name: "ci/legacy", apps: [] },
    ];
    expect(
      plan(root, fake({ [release]: [passed("test"), status] }, required))
        .versions[0]?.state,
    ).toBe("ready");
    const failing = plan(
      root,
      fake(
        {
          [release]: [
            passed("test"),
            { ...status, outcome: "failed", conclusion: "error" },
          ],
        },
        required,
      ),
    ).versions[0];
    expect(failing).toMatchObject({
      state: "failed",
      checks: [
        { name: "test", verdict: "passed" },
        { name: "ci/legacy", verdict: "failed" },
      ],
    });
  });

  test("ci.required_checks replaces the branch's rules; [] tags without any", () => {
    const { root, release } = releasedNow("\nci:\n  required_checks: [build]");
    const result = plan(
      root,
      fake({ [release]: [passed("build")] }, [{ name: "test", apps: [] }]),
    );
    expect(result.requiredChecks).toEqual({
      source: "configuration",
      names: ["build"],
    });
    expect(result.versions[0]?.state).toBe("ready");
    const none = releasedNow("\nci:\n  required_checks: []");
    expect(plan(none.root, fake({}, null)).versions[0]).toMatchObject({
      state: "ready",
      detail: expect.stringContaining("[]"),
    });
  });

  test("ci.required_checks is read from the integration branch's own file, no other layer", () => {
    const { root, release } = releasedNow();
    const hosting = fake({ [release]: [] });
    // In the working tree only, and in the environment: neither is the
    // branch's configuration.
    writeFileSync(
      join(root, ".config/jig.yaml"),
      `${config()}\nci:\n  required_checks: []\n`,
    );
    const result = planTags(
      root,
      { hosting, tags: () => new Set(["v1.2.0"]) },
      { ...env(), JIG__CI__REQUIRED_CHECKS: "[]" },
    );
    expect(result?.requiredChecks?.source).toBe("branch rules");
    expect(result?.versions[0]?.state).toBe("pending");
  });

  test("with no required check known, the plan fails closed", () => {
    const { root } = releasedNow();
    expect(() => plan(root, fake({}, []))).toThrow(/no required checks known/);
    expect(() => plan(root, fake({}, null))).toThrow(/cannot read the checks/);
  });

  test("a check pinned to an app is met only by that app's check run", () => {
    const pinned = { name: "test", apps: [5] };
    expect(judgeCheck(pinned, [passed("test", { app: 7 })]).verdict).toBe(
      "missing",
    );
    expect(judgeCheck(pinned, [passed("test", { app: 5 })]).verdict).toBe(
      "passed",
    );
  });

  test("a cancelled check is run again once, then a second cancel fails", () => {
    const { root, release } = releasedNow();
    const cancelled = (attempt: number, completed = true): CommitCheck =>
      passed("test", {
        outcome: "cancelled",
        conclusion: "cancelled",
        run: { id: 42, attempt, completed },
      });
    const asked: number[] = [];
    const first = fake({ [release]: [cancelled(1)] }, undefined, asked);
    expect(plan(root, first).versions[0]).toMatchObject({
      state: "rerun",
      rerun: [42],
    });
    expect(asked).toEqual([]);
    const out = captured(() =>
      runTag(root, { json: true, rerun: true }, env(), {
        hosting: first,
        tags: () => new Set(["v1.2.0"]),
      }),
    );
    expect(out.code).toBe(0);
    expect(asked).toEqual([42]);
    expect(JSON.parse(out.text).reruns).toEqual([{ run: 42, requested: true }]);
    expect(
      plan(root, fake({ [release]: [cancelled(2, false)] })).versions[0]?.state,
    ).toBe("pending");
    const again = fake({ [release]: [cancelled(2)] });
    expect(plan(root, again).versions[0]).toMatchObject({
      state: "failed",
      checks: [{ verdict: "failed", detail: expect.stringContaining("again") }],
    });
    expect(
      captured(() =>
        runTag(root, { json: false, rerun: true }, env(), {
          hosting: again,
          tags: () => new Set(["v1.2.0"]),
        }),
      ).code,
    ).toBe(1);
  });
});

describe("a re-run the hosting service refuses", () => {
  test("fails its version with the reason, keeps the others ready, and is exit 1", () => {
    const root = released();
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "1.3.0");
    const first = head(root);
    commit(
      root,
      { "CHANGELOG.md": changelog("1.4.0", "1.3.0", "1.2.0") },
      "1.4.0",
    );
    const second = head(root);
    const hosting: Hosting = {
      ...fake({
        [first]: [passed("test")],
        [second]: [
          passed("test", {
            outcome: "cancelled",
            conclusion: "cancelled",
            run: { id: 42, attempt: 1, completed: true },
          }),
        ],
      }),
      rerun: () => "the workflow run is older than 30 days",
    };
    const out = captured(() =>
      runTag(root, { json: true, rerun: true }, env(), {
        hosting,
        tags: () => new Set(["v1.2.0"]),
      }),
    );
    expect(out.code).toBe(1);
    const result = JSON.parse(out.text) as TagPlan;
    expect(result.ready).toEqual([
      { tag: "v1.3.0", commit: first, message: "v1.3.0" },
    ]);
    expect(result.versions[1]).toMatchObject({
      tag: "v1.4.0",
      state: "failed",
      detail: expect.stringContaining("older than 30 days"),
    });
    expect(result.reruns).toEqual([
      {
        run: 42,
        requested: false,
        detail: "the workflow run is older than 30 days",
      },
    ]);
  });
});

/** What `fn` printed to standard output, and the status it returned. */
function captured(fn: () => number): { code: number; text: string } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { code: fn(), text: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("versions are tagged oldest first", () => {
  /** A repository whose last two commits released 1.1.0 and 1.2.0, origin tagged v1.0.0. */
  const two = () => {
    const root = repository({
      "CHANGELOG.md": changelog("1.0.0"),
      ".config/jig.yaml": config(),
    });
    commit(root, { "CHANGELOG.md": changelog("1.1.0", "1.0.0") }, "1.1.0");
    const older = head(root);
    commit(
      root,
      { "CHANGELOG.md": changelog("1.2.0", "1.1.0", "1.0.0") },
      "1.2.0",
    );
    return { root, older, newer: head(root) };
  };
  const cancelled = passed("test", {
    outcome: "cancelled",
    conclusion: "cancelled",
    run: { id: 42, attempt: 1, completed: true },
  });
  const pending = passed("test", { outcome: "pending", conclusion: "queued" });

  test("an older version to be run again holds a newer passing one back", () => {
    const { root, older, newer } = two();
    const result = plan(
      root,
      fake({ [older]: [cancelled], [newer]: [passed("test")] }),
      ["v1.0.0"],
    );
    expect(result.ready).toEqual([]);
    expect(result.versions.map((v) => [v.tag, v.state])).toEqual([
      ["v1.1.0", "rerun"],
      ["v1.2.0", "pending"],
    ]);
    expect(result.versions[1]?.detail).toContain("waits for v1.1.0");
  });

  test("an older version still waiting for its checks holds a newer passing one back", () => {
    const { root, older, newer } = two();
    const result = plan(
      root,
      fake({ [older]: [pending], [newer]: [passed("test")] }),
      ["v1.0.0"],
    );
    expect(result.ready).toEqual([]);
    expect(result.versions[1]).toMatchObject({
      state: "pending",
      detail: expect.stringContaining("waits for v1.1.0"),
    });
  });

  test("an older failed version does not hold a newer passing one back", () => {
    const { root, older, newer } = two();
    const failed = passed("test", { outcome: "failed", conclusion: "failure" });
    const result = plan(
      root,
      fake({ [older]: [failed], [newer]: [passed("test")] }),
      ["v1.0.0"],
    );
    expect(result.ready).toEqual([
      { tag: "v1.2.0", commit: newer, message: "v1.2.0" },
    ]);
  });

  test("an older version whose re-run is refused fails and stops holding the newer one back", () => {
    const { root, older, newer } = two();
    const hosting: Hosting = {
      ...fake({ [older]: [cancelled], [newer]: [passed("test")] }),
      rerun: () => "the workflow run is older than 30 days",
    };
    const out = captured(() =>
      runTag(root, { json: true, rerun: true }, env(), {
        hosting,
        tags: () => new Set(["v1.0.0"]),
      }),
    );
    expect(out.code).toBe(1);
    const result = JSON.parse(out.text) as TagPlan;
    expect(result.versions.map((v) => [v.tag, v.state])).toEqual([
      ["v1.1.0", "failed"],
      ["v1.2.0", "ready"],
    ]);
    expect(result.versions[1]?.detail).toBe("every required check passed");
    expect(result.ready).toEqual([
      { tag: "v1.2.0", commit: newer, message: "v1.2.0" },
    ]);
  });
});

describe("GitHub's answers", () => {
  const replies =
    (answers: Record<string, unknown>): Gh =>
    (args) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      // The longest key that matches: `/rules/branches/main` before `/branches/main`.
      const key = Object.keys(answers)
        .filter((k) => path.includes(k))
        .sort((a, b) => b.length - a.length)[0];
      return key === undefined ? null : JSON.stringify(answers[key]);
    };

  test("a commit's check runs, their workflow runs and its statuses are combined, newest first", () => {
    const gh = replies({
      "/check-runs": [
        {
          check_runs: [
            {
              id: 1,
              name: "test",
              status: "completed",
              conclusion: "cancelled",
              app: { id: 15368 },
              check_suite: { id: 9 },
            },
            {
              id: 3,
              name: "test",
              status: "completed",
              conclusion: "success",
              app: { id: 15368 },
              check_suite: { id: 9 },
            },
            {
              id: 2,
              name: "lint",
              status: "in_progress",
              conclusion: null,
              app: { id: 15368 },
              check_suite: { id: 9 },
            },
          ],
        },
      ],
      "/actions/runs": [
        {
          workflow_runs: [
            { id: 42, check_suite_id: 9, run_attempt: 2, status: "completed" },
          ],
        },
      ],
      "/status": [
        {
          statuses: [
            { context: "ci/legacy", state: "failure" },
            { context: "ci/legacy", state: "success" },
          ],
        },
      ],
    });
    const answer = github("/x", gh).commitChecks("abc");
    expect(answer).toMatchObject({
      known: true,
      value: [
        {
          name: "test",
          outcome: "passed",
          app: 15368,
          run: { id: 42, attempt: 2, completed: true },
        },
        { name: "lint", outcome: "pending" },
        { name: "ci/legacy", kind: "status", outcome: "failed" },
      ],
    });
  });

  test("a skipped check run passes only when its workflow run succeeded", () => {
    const skipped = (id: number, name: string, suite?: number) => ({
      id,
      name,
      status: "completed",
      conclusion: "skipped",
      app: { id: 15368 },
      ...(suite === undefined ? {} : { check_suite: { id: suite } }),
    });
    const gh = replies({
      "/check-runs": [
        {
          check_runs: [
            skipped(1, "gates", 9),
            skipped(2, "lint", 10),
            skipped(3, "external"),
            skipped(4, "build", 11),
            skipped(5, "docs", 12),
          ],
        },
      ],
      "/actions/runs": [
        {
          workflow_runs: [
            {
              id: 42,
              check_suite_id: 9,
              status: "completed",
              conclusion: "cancelled",
            },
            {
              id: 43,
              check_suite_id: 10,
              status: "completed",
              conclusion: "success",
            },
            {
              id: 44,
              check_suite_id: 11,
              status: "completed",
              conclusion: "failure",
            },
            {
              id: 45,
              check_suite_id: 12,
              status: "in_progress",
              conclusion: null,
            },
          ],
        },
      ],
      "/status": [{ statuses: [] }],
    });
    const answer = github("/x", gh).commitChecks("abc");
    if (!answer.known) throw new Error(answer.detail);
    expect(answer.value.map((c) => [c.name, c.outcome])).toEqual([
      ["gates", "cancelled"],
      ["lint", "passed"],
      ["external", "passed"],
      ["build", "failed"],
      ["docs", "pending"],
    ]);
    // A job that runs only on pull requests, skipped in the run that released
    // the commit and in a later run that failed: the release run is enough.
    // And a result that did work answers before a newer skip.
    const later = replies({
      "/check-runs": [
        {
          check_runs: [
            skipped(1, "check", 20),
            skipped(2, "check", 21),
            { ...skipped(3, "test", 20), conclusion: "success" },
            skipped(4, "test", 21),
          ],
        },
      ],
      "/actions/runs": [
        {
          workflow_runs: [
            {
              id: 50,
              check_suite_id: 20,
              status: "completed",
              conclusion: "success",
            },
            {
              id: 51,
              check_suite_id: 21,
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      ],
      "/status": [{ statuses: [] }],
    });
    const both = github("/x", later).commitChecks("abc");
    if (!both.known) throw new Error(both.detail);
    expect(
      both.value.map((c) => [c.name, c.outcome, c.conclusion, c.run?.id]),
    ).toEqual([
      ["check", "passed", "skipped", 50],
      ["test", "passed", "success", 50],
    ]);
    // A skip in a cancelled run is run again once, like the cancellation it is.
    const [gates] = answer.value;
    if (!gates) throw new Error("no gates check");
    expect(judgeCheck({ name: "gates", apps: [] }, [gates])).toMatchObject({
      verdict: "rerun",
      run: 42,
    });
  });

  test("the branch's required checks combine classic protection and rulesets", () => {
    const gh = replies({
      "/branches/main": {
        protected: true,
        protection: {
          enabled: true,
          required_status_checks: {
            enforcement_level: "everyone",
            contexts: ["test"],
          },
        },
      },
      "/rules/branches/main": [
        [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "build", integration_id: 5 }],
            },
          },
        ],
      ],
    });
    expect(github("/x", gh).requiredChecks("main")).toEqual({
      known: true,
      value: [
        { name: "test", apps: [] },
        { name: "build", apps: [5] },
      ],
    });
  });

  test("without gh every answer is unknown, and a re-run is refused with a reason", () => {
    const hosting = github("/x", () => null);
    expect(hosting.requiredChecks("main").known).toBe(false);
    expect(hosting.commitChecks("abc").known).toBe(false);
    expect(hosting.rerun(42)).toContain("42");
  });
});

describe("status", () => {
  test("a failed releasing commit is reported with its checks, and is exit 1", () => {
    const root = released();
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    const release = head(root);
    const hosting = fake({
      [release]: [passed("test", { outcome: "failed", conclusion: "failure" })],
    });
    const out = captured(() =>
      runStatus(root, false, env(), hosting, () => new Set(["v1.2.0"])),
    );
    expect(out.code).toBe(1);
    expect(out.text).toContain(`v1.3.0: failed`);
    expect(out.text).toContain(`releasing commit ${release}, failing: test`);
    const json = captured(() =>
      runStatus(root, true, env(), hosting, () => new Set(["v1.2.0"])),
    );
    expect(JSON.parse(json.text).tags).toEqual({
      known: true,
      untagged: [
        {
          version: "1.3.0",
          tag: "v1.3.0",
          state: "failed",
          detail: "failed: test",
          commit: release,
          failing: ["test"],
        },
      ],
    });
  });

  test("a version waiting for its checks is reported and is exit 0; without a host the picture is unknown", () => {
    const root = released();
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    const pending = captured(() =>
      runStatus(root, false, env(), fake({}), () => new Set(["v1.2.0"])),
    );
    expect(pending.code).toBe(0);
    expect(pending.text).toContain("v1.3.0: pending");
    const unknown = captured(() => runStatus(root, true, env(), null));
    expect(JSON.parse(unknown.text).tags.known).toBe(false);
  });

  test("a configuration tag.ts refuses is an invalid configuration, not an unknown picture", () => {
    const root = released("\nci:\n  required_checks: [test, test]");
    commit(root, { "CHANGELOG.md": changelog("1.3.0", "1.2.0") }, "release");
    const status = () =>
      runStatus(root, false, env(), fake({}), () => new Set(["v1.2.0"]));
    expect(status).toThrow(ConfigurationError);
    expect(status).toThrow("ci.required_checks must be a list of distinct");
  });
});

describe("the command line", () => {
  const script = join(import.meta.dir, "..", "scripts", "tag.ts");
  const run = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: cleanEnv({ JIG_HOME: temporary("jig-home-") }),
    });
    return {
      exitCode: result.status,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  };

  test("a repository that did not turn the skill on is told so, exit 0", () => {
    const root = repository({ "CHANGELOG.md": changelog("1.2.0") });
    const result = run(root);
    expectSpawnExit(result, 0, "not configured");
    expect(result.stdout).toContain("(plugin ");
    expect(result.stdout).toContain("not configured");
  });

  test("an unknown option is a usage error, exit 2", () => {
    expectSpawnExit(run(released(), "--bogus"), 2, "usage");
  });

  test("a shallow clone is exit 2", () => {
    const origin = released();
    const clone = join(temporary(), "clone");
    git(origin, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    git(
      clone,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    const result = run(clone, "--json");
    expectSpawnExit(result, 2, "shallow");
    expect(result.stderr).toContain("shallow clone");
  });
});
