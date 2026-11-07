/** A scratch consumer repository and the review helper's commands, for the review skill's suites. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

export const cli = resolve(import.meta.dir, "../scripts/review.ts");
export const launch = [
  "--no-env-file",
  `--config=${resolve(import.meta.dir, "../scripts/bunfig.toml")}`,
  cli,
];
export const roots: string[] = [];
export const sessions: string[] = [];

export function run(
  cwd: string,
  program: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  input?: string,
) {
  const child = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
    ...(input === undefined ? {} : { input }),
  });
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
}

export function git(root: string, ...args: string[]) {
  const result = run(root, "git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "protocol.file.allow=always",
    ...args,
  ]);
  expectSpawnExit(result, 0, `git ${args[0]}`);
  return result.stdout.trim();
}

/** The helper's own command line, run in `root`. */
export function review(
  root: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
) {
  return run(root, process.execPath, [...launch, ...args], env);
}

export function fixture(plan = false, preload = false) {
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

export interface SetupState {
  session: string;
  files: string;
  diff: string;
  baseTree: string;
}

export function setup(root: string, ...files: string[]): SetupState {
  const result = review(root, [
    "setup",
    ...(files.length ? ["--files", ...files] : []),
  ]);
  expectSpawnExit(result, 0);
  const state = JSON.parse(result.stdout) as SetupState;
  sessions.push(state.session);
  return state;
}

/** Create each file (and its folders) in `root` with one line of content. */
export function touch(root: string, ...files: string[]): void {
  for (const file of files) {
    mkdirSync(resolve(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), `${file}\n`);
  }
}

/** Remove every session and scratch directory the test made; each suite runs it after each test. */
export function cleanupFixtures(): void {
  for (const session of sessions.splice(0)) {
    const root = roots[0];
    if (root) review(root, ["cleanup", session]);
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}
