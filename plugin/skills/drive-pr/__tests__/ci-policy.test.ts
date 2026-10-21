import { scopedStateDir } from "./scoped-state-dir.ts";
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  mergeRequiredChecks,
  protectionContexts,
  rulesetContexts,
} from "../scripts/lib/ci-policy.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CI_HOLD = join(import.meta.dir, "..", "scripts", "ci-hold.ts");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const any = (context: string) => ({ context, appId: null });

describe("required checks from branch protection", () => {
  it("reads the contexts classic protection requires", () => {
    expect(
      protectionContexts({
        protection: {
          enabled: true,
          required_status_checks: {
            contexts: ["gate-passed"],
            enforcement_level: "non_admins",
          },
        },
      }),
    ).toEqual([any("gate-passed")]);
  });

  it("keeps the app classic protection pins a check to", () => {
    expect(
      protectionContexts({
        protection: {
          enabled: true,
          required_status_checks: {
            checks: [
              { context: "gates", app_id: 15368 },
              { context: "lint", app_id: null },
              { context: "docs", app_id: -1 },
            ],
            contexts: ["gates", "lint", "docs"],
            enforcement_level: "non_admins",
          },
        },
      }),
    ).toEqual([{ context: "gates", appId: 15368 }, any("lint"), any("docs")]);
  });

  it("reads an unprotected branch as requiring nothing", () => {
    expect(protectionContexts({ name: "main", protected: false })).toEqual([]);
    expect(protectionContexts({ protection: { enabled: false } })).toEqual([]);
    expect(
      protectionContexts({
        protection: {
          enabled: true,
          required_status_checks: {
            checks: [],
            contexts: [],
            enforcement_level: "off",
          },
        },
      }),
    ).toEqual([]);
  });

  it("fails closed on a malformed protection payload", () => {
    expect(protectionContexts(null)).toBeNull();
    expect(protectionContexts({ name: "main" })).toBeNull();
    expect(protectionContexts({ protection: [] })).toBeNull();
    expect(
      protectionContexts({
        protection: {
          enabled: true,
          required_status_checks: { contexts: [""] },
        },
      }),
    ).toBeNull();
  });

  it("reads a requirements object without its check list as malformed, not as requiring nothing", () => {
    for (const required_status_checks of [
      undefined,
      null,
      { contexts: null },
      { enforcement_level: "non_admins" },
    ])
      expect(
        protectionContexts({
          protection: { enabled: true, required_status_checks },
        }),
      ).toBeNull();
    expect(
      protectionContexts({
        protection: {
          enabled: true,
          required_status_checks: { checks: [{ context: "a", app_id: "x" }] },
        },
      }),
    ).toBeNull();
  });

  it("reads the contexts active rulesets require, ignoring other rules", () => {
    expect(rulesetContexts([])).toEqual([]);
    expect(
      rulesetContexts([
        { type: "pull_request", parameters: {} },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "build" },
              { context: "test", integration_id: 15368 },
            ],
          },
        },
      ]),
    ).toEqual([any("build"), { context: "test", appId: 15368 }]);
  });

  it("fails closed on a malformed ruleset payload", () => {
    expect(rulesetContexts({})).toBeNull();
    expect(
      rulesetContexts([{ type: "required_status_checks", parameters: {} }]),
    ).toBeNull();
    expect(
      rulesetContexts([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: 7 }] },
        },
      ]),
    ).toBeNull();
  });

  it("merges both sources, keeping the stricter pin and every distinct pin", () => {
    const merged = mergeRequiredChecks([
      [any("build"), { context: "test", appId: 1 }],
      [{ context: "build", appId: 2 }, any("test")],
    ]);
    expect(merged).toEqual({
      names: ["build", "test"],
      apps: new Map([
        ["build", [2]],
        ["test", [1]],
      ]),
    });
    expect(
      mergeRequiredChecks([
        [{ context: "build", appId: 1 }],
        [{ context: "build", appId: 2 }],
      ]),
    ).toEqual({ names: ["build"], apps: new Map([["build", [1, 2]]]) });
  });
});

/**
 * A repository without a hold label. Its pull request targets `release`,
 * whose protection requires `gate-passed` through classic protection and
 * `lint` through a ruleset; the repository's own base branch, `main`, would
 * require something else. The fake `gh` refuses label edits and timeline
 * reads: neither may happen without a hold.
 */
const STACKED_ON_MAIN = JSON.stringify([
  {
    number: 998,
    url: "https://github.com/acme/widgets/pull/998",
    headRefName: "release",
    baseRefName: "main",
    isCrossRepository: false,
  },
]);

function noHoldRepo(opts: {
  overlay: string;
  runs: object[];
  labels?: string;
  statuses?: object[];
  /**
   * `fail`: the protection read is refused; `none`: nothing is protected;
   * `pinned`: classic protection pins `gate-passed` to app 15368;
   * `two-pins`: a ruleset also pins `gate-passed`, to app 99;
   * `pinned-pair`: as `pinned`, and a ruleset pins `lint` to app 15368 too.
   */
  protection?: "fail" | "none" | "pinned" | "two-pins" | "pinned-pair";
  /** The bot account behind each status, by context, for the status list. */
  creators?: Record<string, string>;
  /** Raw status-list records; unset, derived from `creators` and `statuses`. */
  statusList?: object[];
  /** `fail`: the pull request's base branch cannot be read. */
  base?: "fail";
  /**
   * The open pull requests, as `gh pr list` returns them; `fail`: the list
   * cannot be read. Unset, none. Under `STACKED_ON_MAIN`, `main`'s
   * protection answers and requires `trunk-gate`.
   */
  pulls?: string;
  /** Raw `--slurp`ed timeline pages; unset, a timeline read is refused. */
  timeline?: string;
}): {
  env: Record<string, string | undefined>;
  log: string;
  stateDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-policy-"));
  roots.push(root);
  const bin = join(root, "bin");
  const stateDir = scopedStateDir(join(root, "state"));
  Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
  const overlay = join(root, "overlay.yaml");
  writeFileSync(overlay, opts.overlay);
  const log = join(root, "gh.log");
  const checkRuns = JSON.stringify([{ check_runs: opts.runs }]);
  const statuses = JSON.stringify([{ statuses: opts.statuses ?? [] }]);
  const branch =
    opts.protection === "fail"
      ? `echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1`
      : opts.protection === "none"
        ? `printf '%s\\n' '{"name":"release","protected":false}'`
        : opts.protection === "pinned" ||
            opts.protection === "two-pins" ||
            opts.protection === "pinned-pair"
          ? `printf '%s\\n' '{"name":"release","protection":{"enabled":true,"required_status_checks":{"checks":[{"context":"gate-passed","app_id":15368}],"contexts":["gate-passed"],"enforcement_level":"non_admins"}}}'`
          : `printf '%s\\n' '{"name":"release","protection":{"enabled":true,"required_status_checks":{"contexts":["gate-passed"]}}}'`;
  const rules =
    opts.protection === "none"
      ? `printf '%s\\n' '[[]]'`
      : opts.protection === "two-pins"
        ? `printf '%s\\n' '[[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"lint"},{"context":"gate-passed","integration_id":99}]}}]]'`
        : opts.protection === "pinned-pair"
          ? `printf '%s\\n' '[[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"lint","integration_id":15368}]}}]]'`
          : `printf '%s\\n' '[[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"lint"}]}}]]'`;
  const statusList = JSON.stringify([
    opts.statusList ??
      Object.entries(opts.creators ?? {}).map(([context, login], index) => ({
        id: index + 1,
        context,
        state:
          (
            opts.statuses?.find(
              (status) => (status as { context?: string }).context === context,
            ) as { state?: string } | undefined
          )?.state ?? "success",
        creator: { login, type: "Bot" },
      })),
  ]);
  const stacked = opts.pulls === STACKED_ON_MAIN;
  const gh = join(bin, "gh");
  writeFakeProgram(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  "pr view 999 --json state,headRefOid,labels")
    printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":${opts.labels ?? "[]"}}' ;;
  "pr view 999 --json baseRefName -q .baseRefName")
    ${opts.base === "fail" ? "echo 'gh: HTTP 502' >&2; exit 1" : "printf '%s\\n' release"} ;;
  "api --paginate --slurp repos/{owner}/{repo}/issues/999/timeline?per_page=100")
    ${opts.timeline === undefined ? 'echo "no timeline read without a hold" >&2; exit 2' : `printf '%s\\n' '${opts.timeline}'`} ;;
  "api repos/{owner}/{repo}/branches/release")
    ${branch} ;;
  "api --paginate --slurp repos/{owner}/{repo}/rules/branches/release?per_page=100")
    ${rules} ;;
  "pr list --state open --limit 1000 --json number,url,headRefName,baseRefName,isCrossRepository")
    ${opts.pulls === "fail" ? "echo 'gh: HTTP 502' >&2; exit 1" : `printf '%s\\n' '${opts.pulls ?? "[]"}'`} ;;
  "api repos/{owner}/{repo}/branches/main")
    ${stacked ? `printf '%s\\n' '{"name":"main","protection":{"enabled":true,"required_status_checks":{"contexts":["trunk-gate"]}}}'` : `echo "the repository's base branch is not this pull request's base" >&2; exit 2`} ;;
  "api --paginate --slurp repos/{owner}/{repo}/rules/branches/main?per_page=100")
    ${stacked ? `printf '%s\\n' '[[]]'` : `echo "the repository's base branch is not this pull request's base" >&2; exit 2`} ;;
  "api --paginate --slurp repos/{owner}/{repo}/commits/${HEAD}/check-runs?per_page=100")
    printf '%s\\n' '${checkRuns}' ;;
  "api --paginate --slurp repos/{owner}/{repo}/commits/${HEAD}/status?per_page=100")
    printf '%s\\n' '${statuses}' ;;
  "api --paginate --slurp repos/{owner}/{repo}/commits/${HEAD}/statuses?per_page=100")
    printf '%s\\n' '${statusList}' ;;
  "api apps/github-actions -q .id") printf '%s\\n' 15368 ;;
  "api apps/impostor -q .id") printf '%s\\n' 99 ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
  );
  return {
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      JIG_OVERLAY: overlay,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
      DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
    },
    log,
    stateDir,
  };
}

function run(
  env: Record<string, string | undefined>,
  args: string[],
  cwd?: string,
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    scriptArgv(CI_HOLD, ...args, "999", "--expect-head", HEAD),
    {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const DERIVED = "repository:\n  base_branch: main\n";

function checkRun(
  name: string,
  conclusion: string | null,
  id: number,
  app = "github-actions",
  appId = 15368,
): object {
  return {
    id,
    name,
    head_sha: HEAD,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    started_at: "2026-09-10T10:01:00Z",
    app: { id: appId, slug: app },
  };
}

function seedHold(
  env: Record<string, string | undefined>,
  phase: "held" | "released",
  eventId: string,
): void {
  const seeded = Bun.spawnSync(
    scriptArgv(
      join(import.meta.dir, "..", "scripts", "drive-state.ts"),
      "set-ci-hold",
      "999",
      "--set",
      phase,
      "--event-id",
      eventId,
      "--head",
      HEAD,
      "--actor-name",
      "drive-user",
      "--created-at",
      "2026-09-10T10:00:00Z",
      "--check-run-watermark",
      "42",
    ),
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expect(seeded.exitCode).toBe(0);
}

describe("ci-hold.ts without a hold label", () => {
  it("never acquires, releases or rolls back a label", () => {
    const repo = noHoldRepo({ overlay: DERIVED, runs: [] });
    for (const command of ["ensure", "release", "rollback"]) {
      const result = run(repo.env, [command]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("disabled\n");
    }
  });

  it("does not need branch protection to push", () => {
    const repo = noHoldRepo({ overlay: DERIVED, runs: [], protection: "fail" });
    for (const command of ["ensure", "release", "rollback"])
      expect(run(repo.env, [command]).stdout).toBe("disabled\n");
  });

  it("certifies a head once every check the pull request's base requires completed on it", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "success", 2),
      ],
    });
    const result = run(repo.env, ["final-ready", "--require-success"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("waits while a required check from either protection source is missing or running", () => {
    for (const runs of [
      [checkRun("gate-passed", "success", 1)],
      [checkRun("gate-passed", "success", 1), checkRun("lint", null, 2)],
    ]) {
      const repo = noHoldRepo({ overlay: DERIVED, runs });
      expect(run(repo.env, ["final-ready"]).code).toBe(4);
    }
  });

  it("counts a required check a workflow condition skipped as passing, as branch protection does", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "skipped", 2),
      ],
    });
    expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(0);
  });

  it("ignores a label that happens to share the name another repository holds with", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "success", 2),
      ],
      labels: '[{"name":"ci:hold"}]',
    });
    expect(run(repo.env, ["final-ready"]).code).toBe(0);
  });

  it("uses configured required checks without reading branch protection", async () => {
    const repo = noHoldRepo({
      overlay: `${DERIVED}ci:\n  required_checks: [gate-passed]\n`,
      runs: [checkRun("gate-passed", "failure", 1)],
    });
    expect(run(repo.env, ["final-ready"]).code).toBe(0);
    expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(4);
    expect(await Bun.file(repo.log).text()).not.toContain("branches/");
  });

  it("names the refused protection read and the field that avoids it", () => {
    const repo = noHoldRepo({ overlay: DERIVED, runs: [], protection: "fail" });
    const result = run(repo.env, ["final-ready"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 403");
    expect(result.stderr).toContain("ci.required_checks");
  });
});

describe("required checks judged as branch protection judges them", () => {
  it("fails closed when the pull request's base branch cannot be read", async () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("gate-passed", "success", 1)],
      base: "fail",
    });
    const result = run(repo.env, ["final-ready"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "cannot read the base branch of pull request #999",
    );
    expect(await Bun.file(repo.log).text()).not.toContain("branches/main");
  });

  it("holds a stacked layer to its base's checks and those of the branch its stack lands on", async () => {
    const runs = [
      checkRun("gate-passed", "success", 1),
      checkRun("lint", "success", 2),
    ];
    const without = noHoldRepo({
      overlay: DERIVED,
      runs,
      pulls: STACKED_ON_MAIN,
    });
    expect(run(without.env, ["final-ready", "--require-success"]).code).toBe(4);
    const log = await Bun.file(without.log).text();
    expect(log).toContain("branches/main");
    expect(log).toContain("branches/release");
    const withoutBase = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("lint", "success", 2),
        checkRun("trunk-gate", "success", 3),
      ],
      pulls: STACKED_ON_MAIN,
    });
    expect(
      run(withoutBase.env, ["final-ready", "--require-success"]).code,
    ).toBe(4);
    const withBoth = noHoldRepo({
      overlay: DERIVED,
      runs: [...runs, checkRun("trunk-gate", "success", 3)],
      pulls: STACKED_ON_MAIN,
    });
    expect(run(withBoth.env, ["final-ready", "--require-success"]).code).toBe(
      0,
    );
  });

  it("fails closed when the integration branch a stack walk stops at is unknown", async () => {
    const repo = noHoldRepo({
      overlay: "ci: {}\n",
      runs: [checkRun("gate-passed", "success", 1)],
      pulls: STACKED_ON_MAIN,
    });
    const clone = mkdtempSync(join(tmpdir(), "drive-pr-ci-policy-clone-"));
    roots.push(clone);
    Bun.spawnSync(["git", "init", "-q", clone]);
    const result = run(repo.env, ["final-ready"], clone);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("integration branch is unknown");
    expect(await Bun.file(repo.log).text()).not.toContain("branches/");
  });

  it("fails closed when the open pull requests that would show a stack cannot be read", async () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("gate-passed", "success", 1)],
      pulls: "fail",
    });
    const result = run(repo.env, ["final-ready"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is a stack layer");
    expect(await Bun.file(repo.log).text()).not.toContain("branches/");
  });

  it("counts a neutral required check as passing", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "neutral", 1),
        checkRun("lint", "success", 2),
      ],
    });
    expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(0);
  });

  it("lets a required context be met by a legacy commit status", () => {
    const passing = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("gate-passed", "success", 1)],
      statuses: [{ context: "lint", state: "success" }],
    });
    expect(run(passing.env, ["final-ready", "--require-success"]).code).toBe(0);
    for (const state of ["pending", "failure"]) {
      const repo = noHoldRepo({
        overlay: DERIVED,
        runs: [checkRun("gate-passed", "success", 1)],
        statuses: [{ context: "lint", state }],
      });
      expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(4);
    }
  });

  it("counts a pinned check only when the pinned app publishes it", () => {
    const otherApp = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1, "impostor", 99),
        checkRun("lint", "success", 2),
      ],
      protection: "pinned",
    });
    expect(run(otherApp.env, ["final-ready"]).code).toBe(4);
    const pinnedApp = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "success", 2),
      ],
      protection: "pinned",
    });
    expect(run(pinnedApp.env, ["final-ready", "--require-success"]).code).toBe(
      0,
    );
  });

  it("lets a pinned context be met by a commit status only its pinned app published", () => {
    const repoWith = (creator: string) =>
      noHoldRepo({
        overlay: DERIVED,
        runs: [checkRun("lint", "success", 2)],
        statuses: [{ context: "gate-passed", state: "success" }],
        creators: { "gate-passed": creator },
        protection: "pinned",
      });
    const pinnedApp = repoWith("github-actions[bot]");
    expect(run(pinnedApp.env, ["final-ready", "--require-success"]).code).toBe(
      0,
    );
    const otherApp = repoWith("impostor[bot]");
    expect(run(otherApp.env, ["final-ready", "--require-success"]).code).toBe(
      4,
    );
  });

  it("judges a pinned context on its own app's newest status, not another publisher's state", () => {
    const record = (id: number, state: string, login: string) => ({
      id,
      context: "gate-passed",
      state,
      creator: { login, type: "Bot" },
    });
    const repoWith = (statusList: object[]) =>
      noHoldRepo({
        overlay: DERIVED,
        runs: [checkRun("lint", "success", 2)],
        statuses: [{ context: "gate-passed", state: "success" }],
        statusList,
        protection: "pinned",
      });
    const pendingFromPin = repoWith([
      record(1, "success", "impostor[bot]"),
      record(2, "pending", "github-actions[bot]"),
    ]);
    expect(
      run(pendingFromPin.env, ["final-ready", "--require-success"]).code,
    ).toBe(4);
    const passedFromPin = repoWith([
      record(1, "success", "github-actions[bot]"),
      record(2, "pending", "impostor[bot]"),
    ]);
    expect(
      run(passedFromPin.env, ["final-ready", "--require-success"]).code,
    ).toBe(0);
  });

  it("meets a context pinned to two apps with a passing status from each", () => {
    const record = (id: number, login: string) => ({
      id,
      context: "gate-passed",
      state: "success",
      creator: { login, type: "Bot" },
    });
    const repoWith = (statusList: object[]) =>
      noHoldRepo({
        overlay: DERIVED,
        runs: [checkRun("lint", "success", 2)],
        statuses: [{ context: "gate-passed", state: "success" }],
        statusList,
        protection: "two-pins",
      });
    const both = repoWith([
      record(1, "github-actions[bot]"),
      record(2, "impostor[bot]"),
    ]);
    expect(run(both.env, ["final-ready", "--require-success"]).code).toBe(0);
    const one = repoWith([record(2, "impostor[bot]")]);
    expect(run(one.env, ["final-ready", "--require-success"]).code).toBe(4);
  });

  it("looks up a publisher's app once per read, even when the lookup fails", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("ci", "success", 2)],
      statuses: [
        { context: "lint", state: "success" },
        { context: "gate-passed", state: "success" },
      ],
      creators: { lint: "flaky[bot]", "gate-passed": "flaky[bot]" },
      protection: "pinned-pair",
    });
    expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(4);
    const lookups = readFileSync(repo.log, "utf8")
      .split("\n")
      .filter((line) => line === "api apps/flaky -q .id");
    expect(lookups).toHaveLength(1);
  });

  it("matches a status context to a required check regardless of case", () => {
    const unpinned = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("gate-passed", "success", 1)],
      statuses: [{ context: "LINT", state: "success" }],
    });
    expect(run(unpinned.env, ["final-ready", "--require-success"]).code).toBe(
      0,
    );
    const pinned = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("lint", "success", 2)],
      statuses: [{ context: "Gate-Passed", state: "success" }],
      creators: { "Gate-Passed": "github-actions[bot]" },
      protection: "pinned",
    });
    expect(run(pinned.env, ["final-ready", "--require-success"]).code).toBe(0);
  });

  it("needs a passing run from every app a check is pinned to", () => {
    const oneApp = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "success", 2),
      ],
      protection: "two-pins",
    });
    expect(run(oneApp.env, ["final-ready", "--require-success"]).code).toBe(4);
    const bothApps = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("gate-passed", "success", 3, "impostor", 99),
        checkRun("lint", "success", 2),
      ],
      protection: "two-pins",
    });
    expect(run(bothApps.env, ["final-ready", "--require-success"]).code).toBe(
      0,
    );
  });
});

describe("hold label configuration changes", () => {
  it("refuses a recorded hold that belongs to a label the configuration no longer names", () => {
    const repo = noHoldRepo({
      overlay: `${DERIVED}ci:\n  hold_label: ci:pause\n  required_checks: [gate-passed]\n`,
      runs: [],
      timeline: JSON.stringify([
        [
          {
            event: "labeled",
            node_id: "LE_owned",
            label: { name: "ci:hold" },
            actor: { login: "drive-user" },
            created_at: "2026-09-10T10:00:00Z",
          },
        ],
      ]),
    });
    seedHold(repo.env, "held", "LE_owned");
    for (const command of ["ensure", "release", "final-ready"]) {
      const result = run(repo.env, [command]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("is not a 'ci:pause' transition");
    }
  });

  it("refuses to recover an interrupted first acquisition recorded under another label", () => {
    const repoWith = (label: string | undefined) => {
      const repo = noHoldRepo({
        overlay: `${DERIVED}ci:\n  hold_label: ci:pause\n  required_checks: [gate-passed]\n`,
        runs: [],
        timeline: JSON.stringify([[]]),
      });
      seedHold(repo.env, "held", "LE_seed");
      const file = join(repo.stateDir, "drive-pr-999.json");
      const state = JSON.parse(readFileSync(file, "utf8"));
      state.ciHold = {
        phase: "acquiring",
        previousEventId: null,
        ...(label === undefined ? {} : { label }),
        head: HEAD,
        actor: "drive-user",
        createdAt: "2026-09-10T10:00:00Z",
        checkRunWatermark: 42,
      };
      writeFileSync(file, JSON.stringify(state));
      return repo;
    };
    // A record without a label predates ci.hold_label: it added ci:hold.
    for (const label of ["ci:hold", undefined]) {
      const repo = repoWith(label);
      for (const command of ["ensure", "release", "final-ready"]) {
        const result = run(repo.env, [command]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("adds 'ci:hold', not 'ci:pause'");
      }
    }
    const result = run(repoWith("ci:pause").env, ["final-ready"]);
    expect(result.stderr).not.toContain("not 'ci:pause'");
  });

  it("refuses to reset inconclusive state when no hold label is configured", () => {
    const repo = noHoldRepo({ overlay: DERIVED, runs: [] });
    const file = join(repo.stateDir, "drive-pr-999.json");
    writeFileSync(file, '{"pr":999');
    const reset = Bun.spawnSync(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "drive-state.ts"),
        "reset",
        "999",
      ),
      { env: repo.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(reset.exitCode).toBe(9);
    expect(reset.stderr.toString()).toContain("does not confirm the absence");
    expect(existsSync(file)).toBe(true);
  });
});

describe("a base branch that requires no checks", () => {
  // The reviewer's checks are set apart only where the repository names one.
  const REVIEWED = `${DERIVED}review:\n  reviewer_app: reviewer\n`;

  it("waits until some CI other than the reviewer's has registered", () => {
    for (const runs of [
      [],
      [checkRun("AI review", "success", 1, "reviewer")],
    ]) {
      const repo = noHoldRepo({ overlay: REVIEWED, runs, protection: "none" });
      expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(4);
    }
    const withCi = noHoldRepo({
      overlay: REVIEWED,
      runs: [checkRun("build", "success", 1)],
      protection: "none",
    });
    expect(run(withCi.env, ["final-ready", "--require-success"]).code).toBe(0);
    const reviewerStatusOnly = noHoldRepo({
      overlay: REVIEWED,
      runs: [checkRun("AI review", "success", 1, "reviewer")],
      statuses: [{ context: "AI review", state: "success" }],
      protection: "none",
    });
    expect(
      run(reviewerStatusOnly.env, ["final-ready", "--require-success"]).code,
    ).toBe(4);
    const withStatus = noHoldRepo({
      overlay: REVIEWED,
      runs: [],
      statuses: [{ context: "ci/legacy", state: "success" }],
      protection: "none",
    });
    expect(run(withStatus.env, ["final-ready", "--require-success"]).code).toBe(
      0,
    );
  });

  it("counts a reviewer-shaped check as CI where the repository names no reviewer", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("AI review", "success", 1, "reviewer")],
      protection: "none",
    });
    expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(0);
  });

  it("certifies on the overall verdict alone when the repository says none are required", () => {
    const repo = noHoldRepo({
      overlay: `${DERIVED}ci:\n  required_checks: []\n`,
      runs: [],
    });
    expect(run(repo.env, ["final-ready", "--require-success"]).code).toBe(0);
  });
});

describe("CI policy configuration errors", () => {
  it("refuses a hold label without configured required checks", () => {
    for (const ci of [
      "ci:\n  hold_label: ci:hold\n",
      "ci:\n  hold_label: ci:hold\n  required_checks: []\n",
    ]) {
      const repo = noHoldRepo({ overlay: `${DERIVED}${ci}`, runs: [] });
      const result = run(repo.env, ["ensure"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ci.hold_label needs ci.required_checks");
    }
  });

  it("refuses malformed required checks", () => {
    const repo = noHoldRepo({
      overlay: `${DERIVED}ci:\n  required_checks: [tests, tests]\n`,
      runs: [],
    });
    const result = run(repo.env, ["final-ready"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ci.required_checks must be a list");
  });

  it("refuses to drop a hold an earlier drive still owns", () => {
    const repo = noHoldRepo({ overlay: DERIVED, runs: [] });
    const seeded = Bun.spawnSync(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "drive-state.ts"),
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_owned",
        "--head",
        HEAD,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T10:00:00Z",
        "--check-run-watermark",
        "42",
      ),
      { env: repo.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(seeded.exitCode).toBe(0);
    for (const command of ["release", "final-ready"]) {
      const result = run(repo.env, [command]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ci.hold_label is not configured");
      expect(result.stderr).toContain("so that the drive can release it");
      expect(result.stderr).not.toContain("reset");
    }
  });
});

describe("drive-state.ts set-verified without a hold label", () => {
  function verify(env: Record<string, string | undefined>): number {
    return Bun.spawnSync(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "drive-state.ts"),
        "set-verified",
        "999",
        "--sha",
        HEAD,
      ),
      { env, stdout: "pipe", stderr: "pipe" },
    ).exitCode;
  }

  it("records a head whose required checks passed, a condition-skipped one included", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "skipped", 2),
      ],
    });
    expect(verify(repo.env)).toBe(0);
  });

  it("treats a released hold an earlier drive recorded as settled history", () => {
    const repo = noHoldRepo({
      overlay: DERIVED,
      runs: [
        checkRun("gate-passed", "success", 1),
        checkRun("lint", "success", 2),
      ],
    });
    seedHold(repo.env, "released", "LE_released");
    expect(verify(repo.env)).toBe(0);
  });

  it("refuses a head missing a required check, or one with no CI at all", () => {
    const missing = noHoldRepo({
      overlay: DERIVED,
      runs: [checkRun("gate-passed", "success", 1)],
    });
    expect(verify(missing.env)).toBe(4);
    const empty = noHoldRepo({
      overlay: DERIVED,
      runs: [],
      protection: "none",
    });
    expect(verify(empty.env)).toBe(4);
  });
});

describe("ruleset pages", () => {
  it("reads every page a paginated read returns", () => {
    const rule = (context: string) => ({
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context }] },
    });
    expect(rulesetContexts([[rule("a")], [rule("b")]])).toEqual([
      any("a"),
      any("b"),
    ]);
  });
});
