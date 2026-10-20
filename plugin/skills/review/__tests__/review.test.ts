import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";

import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

setDefaultTimeout(30000);

const cli = resolve(import.meta.dir, "../scripts/review.ts");
const launch = [
  "--no-env-file",
  `--config=${resolve(import.meta.dir, "../scripts/bunfig.toml")}`,
  cli,
];
const roots: string[] = [];
const sessions: string[] = [];
function run(cwd: string, program: string, args: string[], env = process.env) {
  const child = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
}
function git(root: string, ...args: string[]) {
  const result = run(root, "git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    ...args,
  ]);
  expectSpawnExit(result, 0, `git ${args[0]}`);
  return result.stdout.trim();
}
function fixture(plan = false, preload = false) {
  const root = mkdtempSync(join(tmpdir(), "review consumer "));
  roots.push(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "kept.ts"), "base\n");
  writeFileSync(join(root, "deleted.ts"), "base\n");
  mkdirSync(join(root, ".config"));
  writeFileSync(
    join(root, ".config/jig.yaml"),
    `repository:\n  base_branch: main\n${plan ? "drive:\n  validation_plan_command: bun plan.ts\n" : ""}`,
  );
  writeFileSync(
    join(root, "check.ts"),
    "console.log(JSON.stringify({args:process.argv.slice(2), rules:process.env.RULES,overlay:process.env.JIG_OVERLAY,evil:process.env.EVIL,strict:process.env.STRICT,text:await Bun.file(process.argv[2]).text(),preload:globalThis.reviewPreload,main:import.meta.main,trace:process.env.JIG_TRACE,traceFile:process.env.JIG_TRACE_FILE,traceparent:process.env.TRACEPARENT}));\n",
  );
  if (preload) {
    writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(
      join(root, "preload.ts"),
      'globalThis.reviewPreload="BASE";console.error("BASE PRELOAD");\n',
    );
  }
  if (plan)
    writeFileSync(
      join(root, "plan.ts"),
      'console.log(JSON.stringify({files:(await Bun.stdin.text()).trimEnd().split("\\n"),reviewSkills:["design"]}));',
    );
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "remote", "add", "origin", root);
  git(
    root,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  git(root, "checkout", "-b", "change");
  return root;
}
function setup(root: string, ...files: string[]) {
  const result = run(root, process.execPath, [
    ...launch,
    "setup",
    ...(files.length ? ["--files", ...files] : []),
  ]);
  expectSpawnExit(result, 0);
  const state = JSON.parse(result.stdout) as {
    session: string;
    files: string;
    baseTree: string;
  };
  sessions.push(state.session);
  return state;
}
afterEach(() => {
  for (const session of sessions.splice(0)) {
    const root = roots[0];
    if (root) run(root, process.execPath, [...launch, "cleanup", session]);
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("one NUL list includes committed, staged, unstaged, untracked and deleted paths", () => {
  const root = fixture();
  writeFileSync(join(root, "committed.ts"), "committed\n");
  git(root, "add", "committed.ts");
  git(root, "commit", "-m", "change");
  writeFileSync(join(root, "staged.ts"), "staged\n");
  git(root, "add", "staged.ts");
  writeFileSync(join(root, "kept.ts"), "reviewed\n");
  rmSync(join(root, "deleted.ts"));
  writeFileSync(join(root, "café & [draft].ts"), "untracked\n");
  const state = setup(root);
  expect(
    readFileSync(state.files, "utf8").split("\0").filter(Boolean).sort(),
  ).toEqual(
    [
      "café & [draft].ts",
      "committed.ts",
      "deleted.ts",
      "kept.ts",
      "staged.ts",
    ].sort(),
  );
});

test("explicit files preserve punctuation, deduplicate, and reject newline or escaping paths", () => {
  const root = fixture();
  const state = setup(root, "café & [draft].ts", "kept.ts", "kept.ts");
  expect(readFileSync(state.files, "utf8").split("\0").filter(Boolean)).toEqual(
    ["café & [draft].ts", "kept.ts"],
  );
  for (const path of ["bad\nname", "../escape", "/absolute"]) {
    const result = run(root, process.execPath, [
      ...launch,
      "setup",
      "--files",
      path,
    ]);
    expectSpawnExit(result, 1);
    expect(result.stderr).toMatch(/path|newline/i);
  }
});

test("policy executes the base script against reviewed contents with isolated runtime and environment", () => {
  const root = fixture();
  writeFileSync(join(root, "kept.ts"), "reviewed\n");
  writeFileSync(
    join(root, "check.ts"),
    'throw new Error("reviewed script ran")',
  );
  writeFileSync(join(root, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  writeFileSync(
    join(root, "evil.ts"),
    'throw new Error("reviewed preload ran")',
  );
  writeFileSync(join(root, ".env"), "EVIL=dotenv\nSTRICT=1\n");
  const state = setup(root, "kept.ts", "deleted.ts");
  rmSync(join(root, "deleted.ts"));
  const result = run(
    root,
    process.execPath,
    [
      "--no-env-file",
      `--config=${join(state.baseTree, "../empty-bunfig.toml")}`,
      cli,
      "check",
      state.session,
      "check.ts",
      "rules.yaml",
    ],
    {
      ...process.env,
      EVIL: "inherited",
      JIG_TRACE: "1",
      JIG_TRACE_FILE: join(root, "caller-trace.jsonl"),
      TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
      STRICT: "1",
      JIG_CONSUMER_ROOT: root,
      JIG_OVERLAY: join(root, ".config/jig.yaml"),
    },
  );
  expectSpawnExit(result, 0);
  const output = JSON.parse(result.stdout);
  expect(output.args).toEqual(["kept.ts"]);
  expect(output.text).toBe("reviewed\n");
  expect(output.overlay).toBe(join(state.baseTree, ".config/jig.yaml"));
  expect(output.rules).toBe(join(state.baseTree, "rules.yaml"));
  expect(output.evil).toBeUndefined();
  expect(output.strict).toBeUndefined();
  expect(output.trace).toBeUndefined();
  expect(output.traceFile).toBeUndefined();
  expect(output.traceparent).toBeUndefined();
});

test("configured catalog command reads the fixed file list from stdin inside the base snapshot", () => {
  const root = fixture(true);
  writeFileSync(join(root, "plan.ts"), 'throw new Error("reviewed plan ran")');
  const state = setup(root, "café & [draft].ts", "kept.ts");
  const result = run(root, process.execPath, [
    ...launch,
    "catalog",
    state.session,
  ]);
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout)).toEqual({
    files: ["café & [draft].ts", "kept.ts"],
    reviewSkills: ["design"],
  });
});

test("relative base preloads execute before entering the reviewed data tree", () => {
  const root = fixture(false, true);
  writeFileSync(join(root, "kept.ts"), "reviewed\n");
  writeFileSync(join(root, "preload.ts"), 'throw new Error("HEAD PRELOAD")');
  const state = setup(root, "kept.ts");
  const result = run(root, process.execPath, [
    ...launch,
    "check",
    state.session,
    "check.ts",
    "rules.yaml",
  ]);
  expectSpawnExit(result, 0);
  const output = JSON.parse(result.stdout);
  expect(output.preload).toBe("BASE");
  expect(output.main).toBe(true);
  expect(output.text).toBe("reviewed\n");
  expect(result.stderr).toContain("BASE PRELOAD");
  expect(result.stderr).not.toContain("HEAD PRELOAD");
});

test("setup removes reviewed-tree PATH entries before running even the first git probe", () => {
  const root = fixture();
  const bin = join(root, "bin");
  const marker = join(root, "ran-untrusted-git");
  mkdirSync(bin);
  writeFakeProgram(
    join(bin, "git"),
    `#!/usr/bin/env bun\nimport {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)}, "ran");process.exitCode=1;\n`,
  );
  const result = run(root, process.execPath, [...launch, "setup"], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  });
  expectSpawnExit(result, 0);
  sessions.push(JSON.parse(result.stdout).session);
  expect(existsSync(marker)).toBe(false);
  const refused = run(root, process.execPath, [...launch, "setup"], {
    ...process.env,
    PATH: bin,
  });
  expectSpawnExit(refused, 1);
  expect(existsSync(marker)).toBe(false);
  expect(refused.stderr).toContain("policy PATH has no trusted");
});

test("an unfinished background validator cannot certify a successful catalog plan", () => {
  const root = fixture(true);
  git(root, "checkout", "main");
  const foreground = resolve(
    import.meta.dir,
    "../../drive-pr/scripts/foreground-wait.ts",
  );
  const validator = byPlatform(
    "Windows reaps registered foreground runners; POSIX reaps the policy process group",
    {
      windows: `import {readdirSync,readFileSync} from "node:fs";import {join} from "node:path";const launched=Bun.spawnSync([process.execPath,${JSON.stringify(foreground)},"launch","--",process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"pipe",stderr:"pipe"});if(launched.exitCode!==0)throw new Error(launched.stderr.toString());const dir=join(process.cwd(),".context","foreground-wait");const generation=readdirSync(dir).find(name=>name.startsWith("gen-"));await Bun.write("unfinished.pid",readFileSync(join(dir,generation,"runner.pid")));`,
      posix:
        'const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});await Bun.write("unfinished.pid",String(child.pid));child.unref();',
    },
  );
  writeFileSync(
    join(root, "plan.ts"),
    `${validator}console.log(JSON.stringify({reviewSkills:[]}));`,
  );
  git(root, "add", "plan.ts");
  git(root, "commit", "-m", "background validator");
  git(root, "checkout", "change");
  const state = setup(root, "kept.ts");
  const pidFile = join(state.baseTree, "unfinished.pid");
  try {
    const result = run(root, process.execPath, [
      ...launch,
      "catalog",
      state.session,
    ]);
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain("unfinished descendants");
  } finally {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // The review runner normally reaps the validator before returning.
      }
    }
  }
});

test("GitHub default-branch fallback also excludes reviewed-tree executables", () => {
  const root = fixture();
  git(root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  const reviewedBin = join(root, "bin");
  const trustedBin = mkdtempSync(join(tmpdir(), "review-trusted-tools-"));
  roots.push(trustedBin);
  mkdirSync(reviewedBin);
  const marker = join(root, "ran-untrusted-gh");
  writeFakeProgram(
    join(reviewedBin, "gh"),
    `#!/usr/bin/env bun\nimport {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)}, "ran");console.log("main");\n`,
  );
  writeFakeProgram(
    join(trustedBin, "gh"),
    '#!/usr/bin/env bun\nconsole.log("main");\n',
  );
  const result = run(
    root,
    process.execPath,
    [...launch, "setup", "--files", "kept.ts"],
    {
      ...process.env,
      PATH: [reviewedBin, trustedBin, process.env.PATH ?? ""].join(delimiter),
    },
  );
  expectSpawnExit(result, 0);
  sessions.push(JSON.parse(result.stdout).session);
  expect(existsSync(marker)).toBe(false);
});

test("catalog membership matches literal whole records instead of prefixes or globs", () => {
  const root = fixture(true);
  const catalog = "catalog[1].yaml";
  git(root, "checkout", "main");
  writeFileSync(join(root, catalog), "areas: {}\n");
  const overlay = join(root, ".config/jig.yaml");
  writeFileSync(
    overlay,
    `${readFileSync(overlay, "utf8")}  change_areas_catalog: ${JSON.stringify(catalog)}\n`,
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "catalog policy");
  git(root, "checkout", "change");
  const lookalikes = [`prefix/${catalog}`, "catalog1.yaml", `${catalog}.bak`];
  const absent = setup(root, ...lookalikes);
  const absentResult = run(root, process.execPath, [
    ...launch,
    "catalog",
    absent.session,
  ]);
  expectSpawnExit(absentResult, 0);
  expect(absentResult.stderr).not.toContain("catalog_changed");
  expect(JSON.parse(absentResult.stdout).files).toEqual([...lookalikes].sort());
  const present = setup(root, ...lookalikes, catalog);
  const presentResult = run(root, process.execPath, [
    ...launch,
    "catalog",
    present.session,
  ]);
  expectSpawnExit(presentResult, 0);
  expect(presentResult.stderr).toBe("catalog_changed\n");
});

test("policy checks do not run when all selected files have been deleted", () => {
  const root = fixture();
  const state = setup(root, "deleted.ts");
  rmSync(join(root, "deleted.ts"));
  const result = run(root, process.execPath, [
    ...launch,
    "check",
    state.session,
    "check.ts",
    "rules.yaml",
  ]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
