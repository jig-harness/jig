import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  durationSeconds,
  parseArgs,
  parsePolicy,
} from "./check-supply-chain-lockstep.ts";

const gate = join(import.meta.dir, "check-supply-chain-lockstep.ts");
const fixtures = join(import.meta.dir, "fixtures");
const agree = (name: string) => join(fixtures, "agree", name);
const drift = (name: string) => join(fixtures, "drift", name);
const unreadable = (name: string) => join(fixtures, "unreadable", name);
const policy = agree("policy.yaml");

const scratch = mkdtempSync(join(tmpdir(), "jig-supply-chain-lockstep-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
function dir(): string {
  const path = join(scratch, `case-${dirs++}`);
  mkdirSync(path);
  return path;
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GITHUB_ACTIONS: "false", ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

const everyReader = [
  "--bunfig",
  agree("bunfig.toml"),
  "--package-json",
  agree("package.json"),
  "--npmrc",
  agree(".npmrc"),
  "--pnpm-workspace",
  agree("pnpm-workspace.yaml"),
  "--renovate",
  agree("renovate.json5"),
  "--dependabot",
  agree("dependabot.yml"),
];

describe("every file states the policy", () => {
  test("the agreeing fixtures pass and the scope line counts them", () => {
    const result = run(["--policy", policy, ...everyReader]);
    expectSpawnExit(result, 0);
    expect(result.out).toContain("OK — 6 file(s)");
    expect(result.out).toContain("cooldown 3 days, 2 exemptions, 2 packages");
    expect(result.out).toContain("Checks those values only");
  });

  test("an empty exemption and allow list agree with files that set none", () => {
    const empty = (name: string) => join(fixtures, "agree-empty-lists", name);
    const result = run([
      "--policy",
      empty("policy.yaml"),
      "--bunfig",
      empty("bunfig.toml"),
      "--package-json",
      empty("package.json"),
      "--renovate",
      empty("renovate.json5"),
      "--dependabot",
      empty("dependabot.yml"),
    ]);
    expectSpawnExit(result, 0);
    expect(result.out).toContain("guard rule is not required");
  });

  test("a pnpm workspace file alone must carry the cooldown", () => {
    const root = dir();
    const workspace = join(root, "pnpm-workspace.yaml");
    writeFileSync(
      workspace,
      "onlyBuiltDependencies: [esbuild, sharp]\nminimumReleaseAge: 4320\nminimumReleaseAgeExclude: [typescript, '@types/bun']\n",
    );
    expectSpawnExit(
      run(["--policy", policy, "--pnpm-workspace", workspace]),
      0,
    );
    writeFileSync(workspace, "onlyBuiltDependencies: [esbuild, sharp]\n");
    const alone = run(["--policy", policy, "--pnpm-workspace", workspace]);
    expectSpawnExit(alone, 1);
    expect(alone.err).toContain("minimumReleaseAge is nothing");
    // An .npmrc carrying the cooldown does not stand in for the workspace
    // file: pnpm reads its settings from pnpm-workspace.yaml.
    const withNpmrc = run([
      "--policy",
      policy,
      "--pnpm-workspace",
      workspace,
      "--npmrc",
      agree(".npmrc"),
    ]);
    expectSpawnExit(withNpmrc, 1);
    expect(withNpmrc.err).toContain("minimumReleaseAge is nothing");
  });

  test("an .npmrc passes with the values npm reads as the policy's", () => {
    const npmrc = join(dir(), ".npmrc");
    writeFileSync(
      npmrc,
      [
        "minimum-release-age='4320'",
        "minimum-release-age-exclude[]=typescript",
        "minimum-release-age-exclude=@types/bun",
        "dangerously-allow-all-builds=false",
        "dangerouslyAllowAllBuilds='false'",
        "dangerously-allow-all-builds.note=kept",
        "//registry.npmjs.org/:always-auth=true",
        "",
      ].join("\n"),
    );
    const result = run([
      "--policy",
      policy,
      "--npmrc",
      npmrc,
      "--pnpm-workspace",
      agree("pnpm-workspace.yaml"),
    ]);
    expectSpawnExit(result, 0);
  });

  test("an empty policy rejects a cooldown exemption chosen by another selector", () => {
    const empty = (name: string) => join(fixtures, "agree-empty-lists", name);
    const result = run([
      "--policy",
      empty("policy.yaml"),
      "--renovate",
      drift("renovate-exempt-by-manager.json5"),
    ]);
    expectSpawnExit(result, 1);
    expect(result.err).toContain(
      "without naming packages in matchPackageNames",
    );
    expect(result.err).toContain("the policy exempts no package");
  });
});

describe("a file that does not state the policy is a finding", () => {
  const cases: [string, string, string, string][] = [
    ["--bunfig", "bunfig-short.toml", "minimumReleaseAge is 86400", "259200"],
    [
      "--bunfig",
      "bunfig-no-install.toml",
      "minimumReleaseAge is nothing",
      "259200",
    ],
    [
      "--bunfig",
      "bunfig-extra-exempt.toml",
      "lists left-pad, which the policy's cooldown.exempt does not",
      "remove it",
    ],
    [
      "--package-json",
      "package-extra-trust.json",
      "trustedDependencies lists left-pad, which the policy's install-scripts.allow does not",
      "remove it, or add it to install-scripts.allow",
    ],
    [
      "--npmrc",
      "npmrc-missing-exempt",
      "does not list @types/bun",
      "add it to",
    ],
    [
      "--npmrc",
      "npmrc-pattern",
      "names a pattern, not an exact package name: @types/*",
      "name each package",
    ],
    [
      "--package-json",
      "package-no-trust.json",
      "trustedDependencies is not set",
      '"trustedDependencies": ["esbuild", "sharp"]',
    ],
    [
      "--package-json",
      "package-null-trust.json",
      "trustedDependencies is null",
      '"trustedDependencies": ["esbuild", "sharp"]',
    ],
    [
      "--pnpm-workspace",
      "pnpm-workspace-allow-all.yaml",
      "dangerouslyAllowAllBuilds is true",
      "remove dangerouslyAllowAllBuilds",
    ],
    [
      "--pnpm-workspace",
      "pnpm-workspace-allow-builds.yaml",
      "allowBuilds is",
      "remove allowBuilds",
    ],
    [
      "--pnpm-workspace",
      "pnpm-workspace-only-built-file.yaml",
      'onlyBuiltDependenciesFile is "build-allowlist.json"',
      "remove onlyBuiltDependenciesFile",
    ],
    [
      "--npmrc",
      "npmrc-build-grant",
      'only-built-dependencies is set (["core-js"])',
      "remove every only-built-dependencies line",
    ],
    [
      "--npmrc",
      "npmrc-bare-grant",
      "dangerously-allow-all-builds is set (true)",
      "remove every dangerously-allow-all-builds line",
    ],
    [
      "--npmrc",
      "npmrc-quoted-grant",
      "dangerously-allow-all-builds is set (true)",
      "remove every dangerously-allow-all-builds line",
    ],
    [
      "--npmrc",
      "npmrc-single-quoted-grant",
      "dangerously-allow-all-builds is set (true)",
      "remove every dangerously-allow-all-builds line",
    ],
    [
      "--npmrc",
      "npmrc-escaped-grant",
      "dangerously-allow-all-builds is set (true)",
      "remove every dangerously-allow-all-builds line",
    ],
    [
      "--npmrc",
      "npmrc-camel-grant",
      "dangerouslyAllowAllBuilds is set (true)",
      "remove every dangerouslyAllowAllBuilds line",
    ],
    [
      "--npmrc",
      "npmrc-list-false-grant",
      "dangerously-allow-all-builds is set ([false])",
      "remove every dangerously-allow-all-builds line",
    ],
    [
      "--npmrc",
      "npmrc-bracketed-false-grant",
      "dangerously-allow-all-builds is set ([false])",
      "remove every dangerously-allow-all-builds line",
    ],
    [
      "--npmrc",
      "npmrc-exempt-scalar-after",
      "lists left-pad, which the policy's cooldown.exempt does not",
      "remove it",
    ],
    [
      "--npmrc",
      "npmrc-exempt-scalar-before",
      "lists left-pad, which the policy's cooldown.exempt does not",
      "remove it",
    ],
    [
      "--npmrc",
      "npmrc-exempt-scalar",
      'minimum-release-age-exclude is not a list of package names: "typescript"',
      "list the policy's cooldown.exempt packages there",
    ],
    [
      "--npmrc",
      "npmrc-age-two-spellings",
      "minimum-release-age is set under 2 spellings (minimum-release-age, minimumReleaseAge)",
      "keep only minimum-release-age",
    ],
    [
      "--pnpm-workspace",
      "pnpm-workspace-missing-allow.yaml",
      "onlyBuiltDependencies does not list sharp",
      "add it to",
    ],
    [
      "--renovate",
      "renovate-short.json5",
      'minimumReleaseAge is "2 days"',
      'set minimumReleaseAge: "3 days"',
    ],
    [
      "--renovate",
      "renovate-two-zero-rules.json5",
      "2 packageRules set minimumReleaseAge to 0",
      "keep one rule",
    ],
    [
      "--renovate",
      "renovate-guard-not-last.json5",
      "is followed by 1 rule",
      "move it to the end",
    ],
    [
      "--renovate",
      "renovate-no-guard.json5",
      "0 packageRules set automerge: false",
      "as the last packageRule",
    ],
    [
      "--renovate",
      "renovate-exempt-by-manager.json5",
      "without naming packages in matchPackageNames",
      "select by matchPackageNames [typescript, @types/bun] alone",
    ],
    [
      "--renovate",
      "renovate-exempt-narrowed.json5",
      "(the cooldown exemption) also selects by matchUpdateTypes",
      "remove matchUpdateTypes",
    ],
    [
      "--renovate",
      "renovate-guard-narrowed.json5",
      "also selects by matchUpdateTypes, so updates it does not select can still be auto-merged",
      "remove matchUpdateTypes",
    ],
    [
      "--renovate",
      "renovate-lenient-filter.json5",
      'internalChecksFilter is "none"',
      'set internalChecksFilter: "strict" explicitly',
    ],
    [
      "--renovate",
      "renovate-rule-shortens.json5",
      'shortens the cooldown to "1 day" for ["left-pad"]',
      "remove the rule",
    ],
    [
      "--dependabot",
      "dependabot-short.yml",
      "cooldown.default-days is 1",
      "default-days: 3",
    ],
    [
      "--dependabot",
      "dependabot-include.yml",
      "cooldown.include limits the cooldown",
      "remove include",
    ],
    [
      "--dependabot",
      "dependabot-no-npm.yml",
      "no updates entry has package-ecosystem npm or bun",
      "add one",
    ],
  ];
  for (const [option, file, problem, remedy] of cases)
    test(`${file}`, () => {
      // An .npmrc is read only beside the workspace file it backs up.
      const companion =
        option === "--npmrc"
          ? ["--pnpm-workspace", agree("pnpm-workspace.yaml")]
          : [];
      const result = run([
        "--policy",
        policy,
        option,
        drift(file),
        ...companion,
      ]);
      expectSpawnExit(result, 1);
      expect(result.err).toContain(`${file}: [supply-chain-lockstep] `);
      expect(result.err).toContain(problem);
      expect(result.err).toContain(`\n  fix: `);
      expect(result.err).toContain(remedy);
      expect(result.err).toMatch(/\d+ findings? across /);
    });

  test("every file is read, so one run lists every drifting file", () => {
    const result = run([
      "--policy",
      policy,
      "--bunfig",
      drift("bunfig-short.toml"),
      "--renovate",
      drift("renovate-short.json5"),
      "--package-json",
      agree("package.json"),
    ]);
    expectSpawnExit(result, 1);
    expect(result.err).toContain("bunfig-short.toml:");
    expect(result.err).toContain("renovate-short.json5:");
    expect(result.err).toContain("2 findings across");
  });

  test("a file that cannot be read neither hides another's findings nor wins the exit", () => {
    const result = run([
      "--policy",
      policy,
      "--bunfig",
      drift("bunfig-short.toml"),
      "--renovate",
      join(fixtures, "none.json5"),
      "--dependabot",
      drift("dependabot-short.yml"),
    ]);
    expectSpawnExit(result, 1);
    expect(result.err).toContain("bunfig-short.toml:");
    expect(result.err).toContain("could not check: cannot read --renovate");
    // Dependabot is checked after Renovate, so its finding shows the run
    // continued past the unreadable file.
    expect(result.err).toContain("dependabot-short.yml:");
  });

  test("a changed policy value turns every reader red", () => {
    const root = dir();
    const changed = join(root, "policy.yaml");
    writeFileSync(
      changed,
      "cooldown:\n  days: 4\n  exempt: [typescript, '@types/bun']\ninstall-scripts:\n  allow: [esbuild, sharp]\n",
    );
    const result = run(["--policy", changed, ...everyReader]);
    expectSpawnExit(result, 1);
    for (const file of [
      "bunfig.toml",
      ".npmrc",
      "pnpm-workspace.yaml",
      "renovate.json5",
      "dependabot.yml",
    ])
      expect(result.err).toContain(`${file}: [supply-chain-lockstep]`);
    // package.json carries no cooldown, so it still agrees.
    expect(result.err).not.toContain("package.json: [");
  });

  test("findings carry file and rule, and GitHub annotations in CI", () => {
    const result = run(
      ["--policy", policy, "--bunfig", drift("bunfig-short.toml")],
      { GITHUB_ACTIONS: "true" },
    );
    expectSpawnExit(result, 1);
    expect(result.out).toContain("::error file=");
    expect(result.out).toContain("title=supply-chain-lockstep::");
  });
});

describe("input the gate cannot read never passes", () => {
  const cases: [string, string[], string][] = [
    ["no policy", ["--bunfig", agree("bunfig.toml")], "--policy is required"],
    ["no reader", ["--policy", policy], "no installer or updater file"],
    [
      "missing policy",
      [
        "--policy",
        join(fixtures, "none.yaml"),
        "--bunfig",
        agree("bunfig.toml"),
      ],
      "cannot read policy",
    ],
    [
      "missing reader",
      ["--policy", policy, "--bunfig", join(fixtures, "none.toml")],
      "cannot read --bunfig",
    ],
    [
      "empty policy",
      [
        "--policy",
        unreadable("policy-empty.yaml"),
        "--bunfig",
        agree("bunfig.toml"),
      ],
      "is empty",
    ],
    [
      "policy pattern",
      [
        "--policy",
        unreadable("policy-pattern.yaml"),
        "--bunfig",
        agree("bunfig.toml"),
      ],
      "not an exact package name",
    ],
    [
      "policy without days",
      [
        "--policy",
        unreadable("policy-no-days.yaml"),
        "--bunfig",
        agree("bunfig.toml"),
      ],
      "cooldown.days must be",
    ],
    [
      "policy of zero days",
      [
        "--policy",
        unreadable("policy-zero-days.yaml"),
        "--bunfig",
        agree("bunfig.toml"),
      ],
      "at least 1",
    ],
    [
      "bad TOML",
      ["--policy", policy, "--bunfig", unreadable("bunfig-bad.toml")],
      "is not TOML",
    ],
    [
      "bad JSON5",
      ["--policy", policy, "--renovate", unreadable("renovate-bad.json5")],
      "is not JSON5",
    ],
    [
      "bad JSON",
      ["--policy", policy, "--package-json", unreadable("package-bad.json")],
      "is not JSON",
    ],
    [
      "no updates list",
      [
        "--policy",
        policy,
        "--dependabot",
        unreadable("dependabot-no-updates.yml"),
      ],
      "has no updates list",
    ],
    [
      ".npmrc without the workspace file",
      ["--policy", policy, "--npmrc", agree(".npmrc")],
      "--npmrc needs --pnpm-workspace",
    ],
    [
      ".npmrc with a section",
      [
        "--policy",
        policy,
        "--npmrc",
        unreadable("npmrc-section"),
        "--pnpm-workspace",
        agree("pnpm-workspace.yaml"),
      ],
      "has a section, [registry]",
    ],
    [
      ".npmrc with a key naming an environment variable",
      [
        "--policy",
        policy,
        "--npmrc",
        unreadable("npmrc-env-key"),
        "--pnpm-workspace",
        agree("pnpm-workspace.yaml"),
      ],
      `has a key, \${GRANT}, that names an environment variable`,
    ],
    [
      ".npmrc with a dotted key whose value is an object",
      [
        "--policy",
        policy,
        "--npmrc",
        unreadable("npmrc-dotted-object"),
        "--pnpm-workspace",
        agree("pnpm-workspace.yaml"),
      ],
      "has a key, dangerously-allow-all-builds.extra, whose {} value npm nests",
    ],
    [
      ".npmrc with a dotted key whose value is null",
      [
        "--policy",
        policy,
        "--npmrc",
        unreadable("npmrc-dotted-null"),
        "--pnpm-workspace",
        agree("pnpm-workspace.yaml"),
      ],
      "has a key, dangerously-allow-all-builds.extra, whose null value npm nests",
    ],
    [
      "unknown option",
      ["--policy", policy, "--yarnrc", agree("bunfig.toml")],
      "unknown option --yarnrc",
    ],
    [
      "option twice",
      [
        "--policy",
        policy,
        "--bunfig",
        agree("bunfig.toml"),
        "--bunfig",
        agree("bunfig.toml"),
      ],
      "given twice",
    ],
    [
      "option without value",
      ["--policy", policy, "--bunfig"],
      "--bunfig needs a value",
    ],
  ];
  for (const [name, args, reason] of cases)
    test(name, () => {
      const result = run(args);
      expectSpawnExit(result, 2);
      expect(result.err).toContain("supply-chain-lockstep: could not check: ");
      expect(result.err).toContain(reason);
    });

  test("a could-not-check in CI is an annotation that is not a finding", () => {
    const result = run(["--policy", policy], { GITHUB_ACTIONS: "true" });
    expectSpawnExit(result, 2);
    expect(result.out).toContain(
      "::error title=supply-chain-lockstep%3A could not check::",
    );
  });
});

describe("the parsers", () => {
  test("a policy's lists are exact names, each once", () => {
    expect(parsePolicy("cooldown:\n  days: 3\n", "p")).toEqual({
      days: 3,
      exempt: [],
      allow: [],
    });
    expect(() =>
      parsePolicy("cooldown:\n  days: 3\n  exempt: [a, a]\n", "p"),
    ).toThrow("lists a twice");
    expect(() =>
      parsePolicy("cooldown:\n  days: 3\n  exempt: [/a/]\n", "p"),
    ).toThrow("not an exact package name");
    expect(() => parsePolicy("cooldown:\n  days: 1.5\n", "p")).toThrow(
      "whole number of days",
    );
    expect(() =>
      parsePolicy("cooldown:\n  days: 3\ninstall-scripts: 4\n", "p"),
    ).toThrow("install-scripts is not a mapping");
    expect(() => parsePolicy("- a\n", "p")).toThrow("is not a mapping");
    expect(() => parsePolicy("a: [\n", "p")).toThrow("is not YAML");
  });

  test("durations are read in the units the updater accepts", () => {
    expect(durationSeconds("3 days")).toBe(259200);
    expect(durationSeconds("1 day")).toBe(86400);
    expect(durationSeconds("72 hours")).toBe(259200);
    expect(durationSeconds("0 days")).toBe(0);
    expect(durationSeconds("2 weeks")).toBe(1209600);
    expect(durationSeconds("3d")).toBeUndefined();
    expect(durationSeconds(3)).toBeUndefined();
    expect(durationSeconds("3 fortnights")).toBeUndefined();
  });

  test("the root decides how files are named in findings", () => {
    const options = parseArgs([
      "--policy",
      "p.yaml",
      "--root",
      "/r",
      "--bunfig",
      "/r/bunfig.toml",
    ]);
    expect(options).toEqual({
      policy: "p.yaml",
      root: "/r",
      files: { bunfig: "/r/bunfig.toml" },
    });
  });
});
