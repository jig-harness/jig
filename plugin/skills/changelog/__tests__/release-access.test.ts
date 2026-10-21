import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  type GhApi,
  type GhResult,
  type Json,
  readBranch,
  type Source,
} from "../scripts/github-rules.ts";
import {
  type AccessOptions,
  type AccessReport,
  evaluateAccess,
  type Requirement,
  runReleaseAccess,
} from "../scripts/release-access.ts";
import {
  cleanEnv,
  jigYaml,
  KEEP_CHANGELOG,
  repository,
  temporary,
  write,
} from "./scratch.ts";

const APP = { id: 123, slug: "release-app" };
const ok = (value: unknown): GhResult => ({
  ok: true,
  stdout: JSON.stringify(value),
  stderr: "",
});
const notFound = (message = "Not Found"): GhResult => ({
  ok: false,
  stdout: "",
  stderr: `gh: ${message} (HTTP 404)`,
});

/** A `gh api` that answers `answers` by its arguments and records every call. */
function fakeGh(
  answers: Record<string, GhResult>,
): GhApi & { calls: string[] } {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    return (
      answers[key] ?? { ok: false, stdout: "", stderr: `unexpected: ${key}` }
    );
  };
  return Object.assign(gh, { calls });
}

const app = (mode: string, id: number = APP.id) => ({
  actor_id: id,
  actor_type: "Integration",
  bypass_mode: mode,
});
const admin = {
  actor_id: 5,
  actor_type: "RepositoryRole",
  bypass_mode: "always",
};
const rule = (type: string, ruleset: number, extra: Json = {}): Json => ({
  type,
  ruleset_id: ruleset,
  ...extra,
});
const ruleset = (id: number, bypass: Json[] | undefined, extra: Json = {}) => ({
  id,
  name: `set ${id}`,
  enforcement: "active",
  ...(bypass ? { bypass_actors: bypass } : {}),
  ...extra,
});
/** The two rulesets setup creates for `direct` mode: rules the App bypasses, history it does not. */
const twoRulesets = (): Source => ({
  classic: null,
  rules: [
    rule("pull_request", 7),
    rule("required_status_checks", 7, {
      parameters: { required_status_checks: [{ context: "gates" }] },
    }),
    rule("non_fast_forward", 8),
    rule("deletion", 8),
  ],
  rulesets: [ruleset(7, [app("always"), admin]), ruleset(8, [admin])],
});

function judge(
  integration: Source,
  mode: "direct" | "pull-request" = "direct",
  releaseBranch: Source | null = null,
): AccessReport {
  return evaluateAccess({
    mode,
    repo: "example/repo",
    identity: APP,
    integrationBranch: "main",
    releaseBranch: "changelog-release",
    protection: { integration, releaseBranch },
  });
}
const requirement = (report: AccessReport, id: Requirement["id"]) => {
  const found = report.requirements.find((r) => r.id === id);
  if (!found) throw new Error(`no requirement ${id}`);
  return found;
};

describe("reading a branch's rules", () => {
  test("reads every page of rules, each ruleset behind them, and a withheld ruleset as unknown", () => {
    const gh = fakeGh({
      "--paginate --slurp repos/example/repo/rules/branches/main?per_page=100":
        ok([
          [rule("pull_request", 7), rule("required_status_checks", 7)],
          [rule("non_fast_forward", 8)],
          [rule("deletion", 9, { ruleset_source_type: "Organization" })],
        ]),
      "repos/example/repo/rulesets/7": ok(ruleset(7, [app("always")])),
      "repos/example/repo/rulesets/8": ok(ruleset(8, undefined)),
      "repos/example/repo/rulesets/9": notFound(),
      "repos/example/repo/branches/main/protection": notFound(
        "Branch not protected",
      ),
    });
    const source = readBranch(gh, "example/repo", "main");
    expect(source.classic).toBeNull();
    expect(source.rules.map((r) => r.type)).toEqual([
      "pull_request",
      "required_status_checks",
      "non_fast_forward",
      "deletion",
    ]);
    const report = judge(source);
    expect(
      report.rulesets.map((r) => [r.id, r.bypass?.length ?? null, r.source]),
    ).toEqual([
      ["7", 1, null],
      ["8", null, null],
      ["9", null, "Organization"],
    ]);
    expect(gh.calls).toContain("repos/example/repo/rulesets/9");
  });

  test("a protected branch whose classic protection cannot be read fails the read, or is unknown when asked", () => {
    const answers = {
      "--paginate --slurp repos/example/repo/rules/branches/main?per_page=100":
        ok([[]]),
      "repos/example/repo/branches/main/protection": notFound(),
      "repos/example/repo/branches/main": ok({ protected: true }),
    };
    expect(() => readBranch(fakeGh(answers), "example/repo", "main")).toThrow(
      "cannot read the classic protection",
    );
    expect(
      readBranch(fakeGh(answers), "example/repo", "main", {
        classicUnreadable: "unknown",
      }).classicUnknown,
    ).toBe("unreadable");
  });

  test("a branch that does not exist yet has its rules read and its classic protection unknown", () => {
    const gh = fakeGh({
      "--paginate --slurp repos/example/repo/rules/branches/changelog-release?per_page=100":
        ok([[rule("non_fast_forward", 4)]]),
      "repos/example/repo/rulesets/4": ok(ruleset(4, [])),
      "repos/example/repo/branches/changelog-release/protection":
        notFound("Branch not found"),
      "repos/example/repo/branches/changelog-release": notFound(),
    });
    const source = readBranch(gh, "example/repo", "changelog-release", {
      classicUnreadable: "unknown",
    });
    expect(source.classicUnknown).toBe("missing");
    expect(source.rules).toHaveLength(1);
  });
});

test("a rules answer that does not read as pages of rules fails the read, never narrows it", () => {
  const rulesKey =
    "--paginate --slurp repos/example/repo/rules/branches/main?per_page=100";
  const answers = (pages: unknown) => ({
    [rulesKey]: ok(pages),
    "repos/example/repo/rulesets/7": ok(ruleset(7, [])),
    "repos/example/repo/branches/main/protection": notFound(
      "Branch not protected",
    ),
  });
  for (const pages of [
    { rules: [] },
    [{ type: "deletion", ruleset_id: 7 }],
    [[rule("pull_request", 7), "update"]],
    [[{ type: "pull_request" }]],
  ])
    expect(() =>
      readBranch(fakeGh(answers(pages)), "example/repo", "main"),
    ).toThrow();
  const gh = fakeGh({
    ...answers([[rule("pull_request", 7)]]),
    "repos/example/repo/rulesets/7": ok(["not", "a", "ruleset"]),
  });
  expect(() => readBranch(gh, "example/repo", "main")).toThrow(
    "ruleset 7 of example/repo did not read as one",
  );
});

describe("direct mode", () => {
  test("the setup's two rulesets: the App passes every rule, force pushes and deletion stay blocked for it", () => {
    const report = judge(twoRulesets());
    expect(report.requirements.map((r) => [r.id, r.status])).toEqual([
      ["push", "pass"],
      ["force-push-blocked", "pass"],
      ["deletion-blocked", "pass"],
    ]);
    expect(report.status).toBe("pass");
  });

  test("a ruleset combined with classic protection: classic required checks stop the App, classic blocks force pushes", () => {
    const source: Source = {
      classic: {
        required_status_checks: { contexts: ["gates"], strict: false },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: true },
      },
      rules: [rule("pull_request", 7)],
      rulesets: [ruleset(7, [app("always")])],
    };
    const report = judge(source);
    const push = requirement(report, "push");
    expect(push.status).toBe("fail");
    expect(push.reasons.join("\n")).toContain("bypasses it always");
    expect(push.reasons.join("\n")).toContain(
      "classic branch protection of main stops the App: required status checks",
    );
    expect(requirement(report, "force-push-blocked").status).toBe("pass");
    expect(requirement(report, "deletion-blocked").status).toBe("fail");
  });

  test("a bypass list GitHub withheld is unknown, never a pass or a fail", () => {
    const source = twoRulesets();
    source.rulesets = [ruleset(7, undefined), ruleset(8, undefined)];
    const report = judge(source);
    expect(requirement(report, "push").status).toBe("unknown");
    expect(requirement(report, "push").reasons[0]).toContain("withheld");
    expect(requirement(report, "force-push-blocked").status).toBe("unknown");
    expect(report.status).toBe("unknown");
  });

  test("a bypass only for pull requests does not let the App push", () => {
    const source = twoRulesets();
    source.rulesets = [ruleset(7, [app("pull_request")]), ruleset(8, [])];
    const push = requirement(judge(source), "push");
    expect(push.status).toBe("fail");
    expect(push.reasons[0]).toContain("set its bypass mode to always");
  });

  test("another App's bypass, or a role's, does not let this App push", () => {
    const source = twoRulesets();
    source.rulesets = [ruleset(7, [app("always", 999), admin]), ruleset(8, [])];
    expect(requirement(judge(source), "push").status).toBe("fail");
  });

  test("a force-push rule in the ruleset the App bypasses does not bind it", () => {
    const source: Source = {
      classic: null,
      rules: [
        rule("pull_request", 7),
        rule("non_fast_forward", 7),
        rule("deletion", 7),
      ],
      rulesets: [ruleset(7, [app("always")])],
    };
    const report = judge(source);
    expect(requirement(report, "push").status).toBe("pass");
    const force = requirement(report, "force-push-blocked");
    expect(force.status).toBe("fail");
    expect(force.reasons.join("\n")).toContain("does not bind the App");
    expect(requirement(report, "deletion-blocked").status).toBe("fail");
    expect(report.status).toBe("fail");
  });

  test("a pull_request-mode bypass of the force-push and deletion rules still binds the App", () => {
    const source: Source = {
      classic: null,
      rules: [
        rule("pull_request", 7),
        rule("non_fast_forward", 8),
        rule("deletion", 8),
      ],
      rulesets: [
        ruleset(7, [app("always")]),
        ruleset(8, [app("pull_request")]),
      ],
    };
    const report = judge(source);
    expect(requirement(report, "push").status).toBe("pass");
    const force = requirement(report, "force-push-blocked");
    expect(force.status).toBe("pass");
    expect(force.reasons.join("\n")).toContain("does not cover a direct push");
    expect(requirement(report, "deletion-blocked").status).toBe("pass");
  });

  test("a ruleset in evaluate mode neither stops the App nor blocks force pushes", () => {
    const source = twoRulesets();
    source.rulesets = [
      ruleset(7, [], { enforcement: "evaluate" }),
      ruleset(8, [], { enforcement: "evaluate" }),
    ];
    const report = judge(source);
    expect(requirement(report, "push").status).toBe("pass");
    expect(requirement(report, "force-push-blocked").status).toBe("fail");
  });

  test("an organization ruleset is listed apart and named as one", () => {
    const source = twoRulesets();
    source.rules.push(
      rule("required_signatures", 30, { ruleset_source_type: "Organization" }),
    );
    source.rulesets.push(
      ruleset(30, [], { name: "org wide", source_type: "Organization" }),
    );
    const report = judge(source);
    expect(report.organizationRulesets).toEqual([
      { id: "30", name: "org wide" },
    ]);
    const push = requirement(report, "push");
    expect(push.status).toBe("fail");
    expect(push.reasons.join("\n")).toContain(
      "organization ruleset 30 (org wide) has required_signatures",
    );
    expect(push.reasons.join("\n")).toContain("only an organization owner");
  });

  test("a classic signed-commits or lock setting of the wrong type is an error, not a lifted blocker", () => {
    for (const setting of ["required_signatures", "lock_branch"]) {
      const source = twoRulesets();
      source.classic = {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        [setting]: { enabled: "true" },
      };
      expect(() => judge(source)).toThrow(`${setting}.enabled must be boolean`);
    }
  });

  test("classic protection the reader cannot see is unknown", () => {
    const source = twoRulesets();
    source.classicUnknown = "unreadable";
    expect(requirement(judge(source), "push").status).toBe("unknown");
  });
});

describe("pull-request mode", () => {
  const unprotectedRelease = (): Source => ({
    classic: null,
    rules: [],
    rulesets: [],
  });

  test("asks no bypass on the integration branch, and needs the release branch free to force-push", () => {
    const main: Source = {
      classic: null,
      rules: [
        rule("pull_request", 7),
        rule("non_fast_forward", 7),
        rule("deletion", 7),
      ],
      rulesets: [ruleset(7, [admin])],
    };
    const report = judge(main, "pull-request", unprotectedRelease());
    expect(report.requirements.map((r) => [r.id, r.status])).toEqual([
      ["release-branch", "pass"],
      ["force-push-blocked", "pass"],
      ["deletion-blocked", "pass"],
    ]);
    expect(report.releaseBranch).toBe("changelog-release");
  });

  test("a force-push rule on the release branch stops the regeneration, unless the App bypasses it", () => {
    const release: Source = {
      classic: null,
      rules: [rule("non_fast_forward", 4), rule("deletion", 4)],
      rulesets: [ruleset(4, [])],
    };
    const blocked = requirement(
      judge(twoRulesets(), "pull-request", release),
      "release-branch",
    );
    expect(blocked.status).toBe("fail");
    expect(blocked.reasons[0]).toContain(
      "ruleset 4 (set 4) has non_fast_forward",
    );
    release.rulesets = [ruleset(4, [app("always")])];
    expect(
      requirement(
        judge(twoRulesets(), "pull-request", release),
        "release-branch",
      ).status,
    ).toBe("pass");
  });

  test("classic protection on the release branch blocks its force push", () => {
    const release: Source = {
      classic: { allow_force_pushes: { enabled: false } },
      rules: [],
      rulesets: [],
    };
    const result = requirement(
      judge(twoRulesets(), "pull-request", release),
      "release-branch",
    );
    expect(result.status).toBe("fail");
    expect(result.reasons[0]).toContain("force pushes not allowed");
  });

  test("a release branch that does not exist yet has unknown classic protection", () => {
    const release = unprotectedRelease();
    release.classicUnknown = "missing";
    const result = requirement(
      judge(twoRulesets(), "pull-request", release),
      "release-branch",
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons[0]).toContain("does not exist yet");
  });
});

/** A repository that turned the skill on, in `mode`, with `main` its integration branch. */
const configured = (mode = "direct") =>
  repository({
    "CHANGELOG.md": KEEP_CHANGELOG,
    "package.json": `{"version": "1.2.0"}\n`,
    "changes/README.md": "x\n",
    ".config/jig.yaml": `repository:\n  base_branch: main\n${jigYaml(
      `  file: CHANGELOG.md\n  release:\n    push: ${mode}`,
    )}`,
  });

const options = (extra: Partial<AccessOptions> = {}): AccessOptions => ({
  appSlug: null,
  appId: null,
  repo: "example/repo",
  input: null,
  json: true,
  ...extra,
});

/** Run `runReleaseAccess` with `gh`; its exit status and the report it printed. */
function capture(
  root: string,
  opts: AccessOptions,
  gh: GhApi,
): { code: number; report: Json } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    const code = runReleaseAccess(
      root,
      opts,
      { JIG_HOME: temporary() },
      gh,
      null,
    );
    return { code, report: JSON.parse(lines.at(-1) ?? "{}") };
  } finally {
    console.log = log;
  }
}

/** The answers of a live read of `branch` holding `pages` of rules and `rulesets`. */
const liveBranch = (
  branch: string,
  pages: Json[][],
  rulesets: Json[],
  classic: GhResult = notFound("Branch not protected"),
): Record<string, GhResult> => ({
  [`--paginate --slurp repos/example/repo/rules/branches/${branch}?per_page=100`]:
    ok(pages),
  ...Object.fromEntries(
    rulesets.map((r) => [`repos/example/repo/rulesets/${String(r.id)}`, ok(r)]),
  ),
  [`repos/example/repo/branches/${branch}/protection`]: classic,
});

describe("the command, against an injected gh", () => {
  test("resolves the App's slug to its id and reads the integration branch", () => {
    const gh = fakeGh({
      "apps/release-app": ok({ id: 123, slug: "release-app" }),
      ...liveBranch(
        "main",
        [
          [rule("pull_request", 7), rule("non_fast_forward", 8)],
          [rule("deletion", 8)],
        ],
        [ruleset(7, [app("always")]), ruleset(8, [admin])],
      ),
    });
    const { code, report } = capture(
      configured(),
      options({ appSlug: "release-app" }),
      gh,
    );
    expect(code).toBe(0);
    expect(report).toMatchObject({
      mode: "direct",
      identity: { id: 123, slug: "release-app" },
      integrationBranch: "main",
      status: "pass",
    });
  });

  test("in pull-request mode reads the release branch's rules too, and a withheld list exits 3", () => {
    const gh = fakeGh({
      ...liveBranch(
        "main",
        [[rule("non_fast_forward", 8), rule("deletion", 8)]],
        [ruleset(8, undefined)],
      ),
      ...liveBranch("changelog-release", [[]], []),
    });
    const { code, report } = capture(
      configured("pull-request"),
      options({ appId: "123" }),
      gh,
    );
    expect(gh.calls).toContain(
      "--paginate --slurp repos/example/repo/rules/branches/changelog-release?per_page=100",
    );
    expect(code).toBe(3);
    expect(report.status).toBe("unknown");
  });

  test("a requirement that fails exits 1", () => {
    const gh = fakeGh(
      liveBranch("main", [[rule("pull_request", 7)]], [ruleset(7, [])]),
    );
    expect(capture(configured(), options({ appId: "123" }), gh).code).toBe(1);
  });
});

const script = join(import.meta.dir, "..", "scripts", "release-access.ts");
function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: cleanEnv({ JIG_HOME: temporary("jig-home-") }),
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("the command line, offline", () => {
  const document = (root: string, value: Json): string => {
    write(root, "access.json", JSON.stringify(value));
    return join(root, "access.json");
  };

  test("reports every requirement, banner first, and exits 0 when all hold", () => {
    const root = configured();
    const input = document(root, { ...twoRulesets(), app: APP });
    const result = run(root, ["--input", input]);
    expectSpawnExit(result, 0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^jig changelog release-access \(plugin /);
    expect(result.stdout).toContain("PASS     push:");
    expect(result.stdout).toContain("3 of 3 requirements hold");
  });

  test("the offline release branch, and its unknown classic protection, exit 3", () => {
    const root = configured("pull-request");
    const input = document(root, {
      ...twoRulesets(),
      release_branch: { classic: "missing", rules: [] },
    });
    const result = run(root, ["--input", input, "--app-id", "123", "--json"]);
    expectSpawnExit(result, 3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "pull-request",
      requirements: [{ id: "release-branch", status: "unknown" }, {}, {}],
    });
  });

  test("pull-request mode without the release branch's reading is an error, not a pass", () => {
    const root = configured("pull-request");
    const input = document(root, twoRulesets() as unknown as Json);
    const result = run(root, ["--input", input, "--app-id", "123"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("pull-request mode needs release_branch");
  });

  test("a release branch reading of null is an error, not an unprotected branch", () => {
    const root = configured("pull-request");
    const input = document(root, {
      ...twoRulesets(),
      release_branch: null,
    } as unknown as Json);
    const result = run(root, ["--input", input, "--app-id", "123"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("release_branch must be an object");
  });

  test("a failing requirement exits 1", () => {
    const root = configured();
    const input = document(root, { rules: [], rulesets: [] });
    const result = run(root, ["--input", input, "--app-id", "123"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("FAIL     force-push-blocked");
  });

  test("without an identity, or with an unknown option, it is a usage error", () => {
    const root = configured();
    const input = document(root, twoRulesets() as unknown as Json);
    const missing = run(root, ["--input", input]);
    expectSpawnExit(missing, 2);
    expect(missing.stderr).toContain("--app <slug> or --app-id <id>");
    expectSpawnExit(run(root, ["--nope"]), 2);
    const slugOnly = run(root, ["--input", input, "--app", "release-app"]);
    expectSpawnExit(slugOnly, 2);
    expect(slugOnly.stderr).toContain("--app-id or the document's app.id");
  });

  test("a malformed document is an error, not a pass", () => {
    const root = configured();
    const input = document(root, { rules: [{ type: "deletion" }] });
    const result = run(root, ["--input", input, "--app-id", "123"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("ruleset_id");
  });

  test("a repository that did not turn the skill on is told so, exit 0", () => {
    const root = repository({ "README.md": "x\n" });
    const result = run(root, []);
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("not configured");
  });
});
