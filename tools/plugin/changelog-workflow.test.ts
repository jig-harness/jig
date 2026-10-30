/**
 * The `changelog` skill's composite action and its GitHub workflow template
 * are copied into, or run for, other repositories, which cannot rely on
 * Jig's gates having read them. These tests hold both to the lints Jig holds
 * its own workflows to: M13's workflow-convention lint, M7's PR-target safety
 * lint, and actionlint (with shellcheck over the run scripts when it is
 * installed). They live here rather than in the skill's `__tests__/` because
 * the lints are Jig's, outside `plugin/`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { load } from "../../plugin/shared/vendor/js-yaml.mjs";
import {
  cleanEnv,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  repository,
  write,
} from "../../plugin/skills/changelog/__tests__/scratch.ts";

const root = resolve(import.meta.dirname, "../..");
const skill = join(root, "plugin/skills/changelog");
const template = join(skill, "templates/github/changelog.yml");
const conventions = join(
  root,
  "modules/M13-pipeline-economy/reference/workflow-conventions/check-workflow-conventions.ts",
);
const safety = join(
  root,
  "modules/M7-pr-lifecycle-review/reference/pr-target-safety/check-pr-target-safety.ts",
);

/** The pin the setup step replaces: lint-clean, and obviously not a release. */
const PLACEHOLDER_PIN =
  "<jig-owner>/jig/plugin/skills/changelog@0000000000000000000000000000000000000000 # v0.0.0";

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "jig-changelog-wf-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs `argv` with its output captured; the environment minus CI annotations. */
function spawn(argv: string[]) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  return Bun.spawnSync(argv, {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * M13's lint over `workflows` and the action, from an empty root, so Jig's
 * own heavy suites, catalog and exceptions do not apply to a template that
 * leaves Jig.
 */
function lintConventions(workflows: string) {
  const empty = join(scratch, `root-${Math.random().toString(36).slice(2)}`);
  mkdirSync(empty);
  return spawn([
    process.execPath,
    conventions,
    "--root",
    empty,
    "--workflows",
    workflows,
    "--actions",
    skill,
  ]);
}

test("the template and the action pass the workflow-convention lint", () => {
  const result = lintConventions(join(skill, "templates/github"));
  expectSpawnExit(result, 0, "workflow-conventions");
  expect(result.stdout.toString()).toContain("OK");
});

test("the lint reads the template: an action pinned to a tag fails it", () => {
  const dir = join(scratch, "unpinned");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "changelog.yml"),
    readFileSync(template, "utf8").replace(
      "@0000000000000000000000000000000000000000 # v0.0.0",
      "@v1",
    ),
  );
  const result = lintConventions(dir);
  expectSpawnExit(result, 1, "workflow-conventions on an unpinned copy");
  expect(result.stderr.toString()).toContain("[pinned-uses]");
});

test("the template passes the PR-target safety lint", () => {
  expectSpawnExit(spawn([process.execPath, safety, template]), 0, "pr-target");
});

test("every use of the skill's action carries the placeholder pin the setup fills", () => {
  const text = readFileSync(template, "utf8");
  const uses = [
    ...text.matchAll(/uses: (\S+\/jig\/plugin\/skills\/changelog@.*)$/gm),
  ];
  expect(uses.length).toBeGreaterThan(0);
  for (const [, pin] of uses) expect(pin).toBe(PLACEHOLDER_PIN);
  // The header names each placeholder a person or the setup replaces.
  for (const placeholder of [
    "<jig-owner>",
    "<integration-branch>",
    "<workflow that reports a required check>",
    "0000000000000000000000000000000000000000 # v0.0.0",
  ])
    expect(text.slice(0, text.indexOf("\nname:"))).toContain(placeholder);
});

/** actionlint, or null when it is not installed. */
const actionlint = Bun.which("actionlint");

test.skipIf(actionlint === null && !process.env.CI)(
  "actionlint passes the template and Jig's workflows (skipped locally without actionlint; mise.toml pins it)",
  () => {
    // CI installs it through mise.toml, so a CI run without it is a setup
    // fault, never a skip.
    expect(actionlint).not.toBeNull();
    const workflows = readdirSync(join(root, ".github/workflows"))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => join(root, ".github/workflows", f));
    expectSpawnExit(
      spawn([actionlint ?? "actionlint", template]),
      0,
      "actionlint on the template",
    );
    expectSpawnExit(
      spawn([actionlint ?? "actionlint", ...workflows]),
      0,
      "actionlint on Jig's workflows",
    );
  },
);

interface Step {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

/** The action's run steps, as action.yml lists them. */
const steps = (): Step[] =>
  (
    load(readFileSync(join(skill, "action.yml"), "utf8")) as {
      runs: { steps: Step[] };
    }
  ).runs.steps.filter((step) => step.run !== undefined);

/** A step's `env:` with each `${{ inputs.<name> }}` replaced by `inputs`' value. */
function stepEnv(step: Step, inputs: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      String(value).replace(
        /\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g,
        (_, name: string) => inputs[name] ?? "",
      ),
    ]),
  );
}

/**
 * Runs one of the action's run steps with bash in `cwd`, as a GitHub job
 * would: the action's directory, a runner temp folder and an output file.
 */
function runStep(
  step: Step,
  cwd: string,
  inputs: Record<string, string>,
  temp: string,
) {
  const output = join(temp, `output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(output, "");
  const result = Bun.spawnSync(["bash", "-e", "-c", step.run ?? ""], {
    cwd,
    env: cleanEnv({
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_ACTION_PATH: skill,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      JIG_HOME: join(temp, "jig-home"),
      ...stepEnv(step, inputs),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return { ...result, outputs };
}

/** The step that refuses an unknown command, and the release step. */
function releaseSteps(): { refuse: Step; release: Step } {
  const [refuse] = steps();
  const release = steps().find((step) => step.id === "release");
  if (!refuse || !release) throw new Error("action.yml lacks a step");
  return { refuse, release };
}

const INPUTS = {
  command: "release",
  rerun: "false",
  "git-user-name": "release-bot[bot]",
  "git-user-email": "1+release-bot[bot]@users.noreply.github.com",
};

test("the action refuses a command it does not have, before any setup", () => {
  const [refuse] = steps();
  if (!refuse) throw new Error("action.yml has no run step");
  const temp = mkdtempSync(join(scratch, "temp-"));
  const result = runStep(refuse, scratch, { ...INPUTS, command: "push" }, temp);
  expectSpawnExit(result, 2, "an unknown command");
  expect(result.stdout.toString()).toContain(
    "command must be check, lint, release or tag",
  );
});

test("the action's release commits the release step's writes, after_version included, and bundles that one commit", () => {
  const dir = repository({
    "CHANGELOG.md": KEEP_CHANGELOG,
    "package.json": `{"version": "1.2.0"}\n`,
    "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- a\n",
    ".config/jig.yaml": jigYaml(
      "  file: CHANGELOG.md\n  after_version: echo done > after.txt",
    ),
  });
  const start = git(dir, "rev-parse", "HEAD").trim();
  const temp = mkdtempSync(join(scratch, "temp-"));
  const { refuse, release } = releaseSteps();
  expectSpawnExit(runStep(refuse, dir, INPUTS, temp), 0, "the command check");
  const result = runStep(release, dir, INPUTS, temp);
  expectSpawnExit(result, 0, "the release step");
  const commit = git(dir, "rev-parse", "HEAD").trim();
  expect(result.outputs).toEqual({
    start,
    notes: "1",
    version: "1.3.0",
    push: "direct",
    "release-branch": "changelog-release",
    changed: "true",
    commit,
    // The action's bash step joins with a slash, on Windows too.
    bundle: `${temp}/jig-changelog-release.bundle`,
  });
  expect(git(dir, "rev-parse", "HEAD^").trim()).toBe(start);
  expect(git(dir, "log", "-1", "--format=%s%n%an <%ae>")).toBe(
    "chore(release): 1.3.0\nrelease-bot[bot] <1+release-bot[bot]@users.noreply.github.com>\n",
  );
  expect(
    git(dir, "show", "--name-status", "--format=", "HEAD")
      .split("\n")
      .sort()
      .join(" ")
      .trim(),
  ).toBe("A\tafter.txt D\tchanges/a.md M\tCHANGELOG.md M\tpackage.json");
  expect(git(dir, "status", "--porcelain")).toBe("");
  // The bundle needs only the commit the release ran on.
  expect(
    git(
      dir,
      "bundle",
      "list-heads",
      join(temp, "jig-changelog-release.bundle"),
    ),
  ).toBe(`${commit} HEAD\n`);
  expect(
    git(dir, "bundle", "verify", join(temp, "jig-changelog-release.bundle")),
  ).toContain(start);
});

test("the action's release leaves a repository with no notes untouched and says nothing changed", () => {
  const dir = repository({
    "CHANGELOG.md": KEEP_CHANGELOG,
    "package.json": `{"version": "1.2.0"}\n`,
    ".config/jig.yaml": jigYaml("  file: CHANGELOG.md"),
  });
  const start = git(dir, "rev-parse", "HEAD").trim();
  const temp = mkdtempSync(join(scratch, "temp-"));
  const { refuse, release } = releaseSteps();
  expectSpawnExit(runStep(refuse, dir, INPUTS, temp), 0, "the command check");
  const result = runStep(release, dir, INPUTS, temp);
  expectSpawnExit(result, 0, "the release step");
  expect(result.outputs.changed).toBe("false");
  expect(result.outputs.commit).toBeUndefined();
  expect(git(dir, "rev-parse", "HEAD").trim()).toBe(start);
});

/** A step of the action by its id. */
function stepById(id: string): Step {
  const step = steps().find((s) => s.id === id);
  if (!step) throw new Error(`action.yml has no step ${id}`);
  return step;
}

/** The check step, which has no id. */
const checkStep = (): Step => {
  const step = steps().find((s) => s.run?.includes("scripts/check.ts"));
  if (!step) throw new Error("action.yml has no check step");
  return step;
};

/** The whole-changelog check's step, which has no id. */
const lintStep = (): Step => {
  const step = steps().find((s) => s.run?.includes("scripts/lint.ts"));
  if (!step) throw new Error("action.yml has no lint step");
  return step;
};

/**
 * A checkout whose Bun settings would run its own code in place of the
 * action's: a tsconfig.json whose `paths` maps every import (the entry script
 * included) to evil.ts, a bunfig.toml that preloads it, and a .env that would
 * turn the changelog fields on from the environment. evil.ts leaves a mark and
 * prints a forged tag plan.
 */
function hostile(dir: string): void {
  writeFileSync(
    join(dir, "evil.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(join(dir, "ran-evil"))}, "");`,
      `console.log(JSON.stringify({ ready: [{ tag: "v9.9.9", commit: "${"0".repeat(40)}", message: "v9.9.9" }] }));`,
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "*": ["./evil.ts"] } } }),
  );
  writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  writeFileSync(join(dir, ".env"), "JIG__CHANGELOG__FILE=OTHER.md\n");
}

/** A changelog with a release heading for each of `versions`, newest first. */
const released = (...versions: string[]): string =>
  `# Changelog\n\n## [Unreleased]\n\n${versions.map((v) => `## [${v}] - 2026-01-02\n\n### Fixed\n\n- ${v}\n`).join("\n")}`;

test("the action runs its own scripts, whatever Bun settings the checkout holds", () => {
  const origin = mkdtempSync(join(scratch, "origin-"));
  git(origin, "init", "-q", "--bare");
  const dir = repository({
    "CHANGELOG.md": released("1.2.0"),
    ".config/jig.yaml": `${jigYaml("  file: CHANGELOG.md\n  version: { tags: true }")}ci:\n  required_checks: []\n`,
  });
  git(dir, "remote", "add", "origin", origin);
  git(dir, "tag", "-a", "v1.2.0", "-m", "v1.2.0");
  write(dir, "CHANGELOG.md", released("1.3.0", "1.2.0"));
  git(dir, "commit", "-qam", "chore(release): 1.3.0");
  const release = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "push", "-q", "origin", "main", "v1.2.0");
  git(dir, "fetch", "-q", "origin");
  git(dir, "remote", "set-head", "origin", "main");
  hostile(dir);
  const temp = mkdtempSync(join(scratch, "temp-"));
  const inputs = { ...INPUTS, command: "tag", token: "a-token" };
  const { refuse } = releaseSteps();
  expectSpawnExit(runStep(refuse, dir, inputs, temp), 0, "the command check");
  const tag = runStep(stepById("tag"), dir, inputs, temp);
  expectSpawnExit(tag, 0, "the tag plan");
  expect(JSON.parse(tag.outputs.ready ?? "")).toEqual([
    { tag: "v1.3.0", commit: release, message: "v1.3.0" },
  ]);
  expect(tag.outputs.failed).toBe("false");
  const check = runStep(checkStep(), dir, { ...inputs, base: "HEAD" }, temp);
  expectSpawnExit(check, 0, "the branch check");
  expect(check.stdout.toString()).toContain("(plugin ");
  const lint = runStep(lintStep(), dir, { ...inputs, command: "lint" }, temp);
  // The changelog names no versioning scheme and links no version: the
  // action's own lint finds that, where the checkout's script would pass.
  expectSpawnExit(lint, 1, "the whole-changelog check");
  expect(lint.stdout.toString()).toContain("jig changelog lint (plugin ");
  expect(lint.stderr.toString()).toContain(
    "CHANGELOG.md:1: [keep-a-changelog/semver-statement]",
  );
  expect(existsSync(join(dir, "ran-evil"))).toBe(false);
});

/** shellcheck, or null when it is not installed. */
const shellcheck = Bun.which("shellcheck");

test.skipIf(shellcheck === null)(
  "shellcheck passes the action's run scripts (skipped without shellcheck; actionlint does not read composite actions)",
  () => {
    const dir = mkdtempSync(join(scratch, "shellcheck-"));
    const files = steps().map((step, i) => {
      const file = join(dir, `step-${i}.sh`);
      writeFileSync(file, `#!/usr/bin/env bash\n${step.run}`);
      return file;
    });
    expectSpawnExit(
      spawn([shellcheck ?? "shellcheck", ...files]),
      0,
      "shellcheck",
    );
  },
);
