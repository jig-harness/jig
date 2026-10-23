import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  argPairs,
  type Context,
  checkDockerfile,
  DEFAULTS,
  envPairs,
  instructions,
  invocations,
  segments,
  splitRun,
  Unreadable,
} from "./check-cache-mounts.ts";

const gate = join(import.meta.dir, "check-cache-mounts.ts");
const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", name, "Dockerfile");

function run(args: string[]) {
  const { GITHUB_ACTIONS: _, ...env } = process.env;
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The temporary files a test made, removed after it. */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function dockerfile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cache-mounts-"));
  dirs.push(dir);
  const path = join(dir, "Dockerfile");
  writeFileSync(path, text);
  return path;
}

/** Each fixture: its exit code, the rules it must report, extra options. */
const cases: [string, number, string[], string[]?][] = [
  ["pass", 0, []],
  ["partial", 1, ["cache-mount-missing"]],
  [
    "arg-pinned",
    1,
    ["cache-mount-missing"],
    ["--build-arg", "npm_config_store_dir=/pnpm-store"],
  ],
  ["arg-pinned", 2, []],
  ["flag-pinned", 1, ["store-flag"]],
  ["no-pin", 0, []],
  ["heredoc", 2, []],
  ["dynamic-command", 2, []],
  ["dynamic-pin", 2, []],
  ["dynamic-from", 2, []],
  ["dynamic-target", 2, []],
  ["empty", 2, []],
];
for (const [name, code, rules, options = []] of cases)
  test(`fixture ${name} ${options.join(" ")} exits ${code}`, () => {
    const result = run([...options, fixture(name)]);
    expectSpawnExit(result, code, name);
    for (const rule of rules) expect(result.stderr).toContain(`[${rule}]`);
  });

test("a pass counts the stages and invocations it checked", () => {
  const result = run([fixture("pass")]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("4 stage(s), 7 pnpm invocation(s) checked");
});

test("a pass with no pinned stage says the mount rule had nothing to check", () => {
  const result = run([fixture("no-pin")]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("no stage pins the pnpm store");
});

test("a missing mount names the stage, the line, the path and the fix", () => {
  const result = run([fixture("partial")]);
  expectSpawnExit(result, 1);
  const lines = result.stderr.trim().split("\n");
  expect(lines[0]).toMatch(
    // The path as given, so with backslashes on Windows.
    /partial[\\/]Dockerfile:11: \[cache-mount-missing\] stage 'build' keeps the pnpm store on \/pnpm-store/,
  );
  expect(lines[1]).toContain("--mount=type=cache,target=/pnpm-store");
  expect(result.stderr).toContain("Dockerfile:12:");
  expect(lines).toHaveLength(4);
});

test("a flag pin is reported in both spellings", () => {
  const result = run([fixture("flag-pinned")]);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("with --store-dir=/pnpm-store,");
  expect(result.stderr).toContain("with --store-dir,");
});

test("several Dockerfiles are checked together and one finding fails the run", () => {
  expectSpawnExit(run([fixture("pass"), fixture("no-pin")]), 0);
  expectSpawnExit(run([fixture("pass"), fixture("partial")]), 1);
});

test("an unreadable file among readable ones fails closed", () =>
  expectSpawnExit(run([fixture("pass"), fixture("heredoc")]), 2));

for (const args of [
  [],
  [join(import.meta.dir, "fixtures", "does-not-exist", "Dockerfile")],
  ["--frobnicate", fixture("pass")],
  ["--command"],
  ["--command", "", fixture("pass")],
  ["--build-arg", "no-equals", fixture("pass")],
  [fixture("pass"), "--build-arg"],
])
  test(`fails closed on ${JSON.stringify(args.map((a) => a.replace(import.meta.dir, "")))}`, () => {
    const result = run(args);
    expectSpawnExit(result, 2);
    expect(result.stderr).not.toBe("");
  });

test("the command, variable and flag are options", () => {
  const path = dockerfile(
    [
      "FROM python:3",
      "ENV PIP_CACHE_DIR=/pip-cache",
      "RUN --mount=type=cache,target=/pip-cache pip install -r requirements.txt",
      "RUN pip install build",
      "RUN pip install --cache-dir /tmp wheel",
    ].join("\n"),
  );
  const options = [
    "--command",
    "pip",
    "--store-env",
    "PIP_CACHE_DIR",
    "--store-flag",
    "--cache-dir",
  ];
  const result = run([...options, path]);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("Dockerfile:4: [cache-mount-missing]");
  expect(result.stderr).toContain("Dockerfile:5: [store-flag]");
  expect(result.stderr).toContain("Dockerfile:5: [cache-mount-missing]");
  // With the defaults, the same file has no pnpm and no pin.
  expectSpawnExit(run([path]), 0);
});

test("an escape directive other than the backslash is not read", () =>
  expectSpawnExit(run([dockerfile("# escape=`\nFROM scratch\nRUN true")]), 2));

test("a file with no FROM is not a Dockerfile", () =>
  expectSpawnExit(run([dockerfile("RUN pnpm install")]), 2));

test("under GitHub Actions a finding is also an annotation", () => {
  const result = Bun.spawnSync([process.execPath, gate, fixture("partial")], {
    env: { ...process.env, GITHUB_ACTIONS: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 1);
  expect(result.stdout.toString()).toContain("::error file=");
  expect(result.stdout.toString()).toContain("title=cache-mount-missing");
});

test("continuation lines fold, with comments and blanks inside dropped", () => {
  const folded = instructions(
    "FROM a\nRUN one \\\n  # note\n\n  && two\nENV k=v",
    "f",
  );
  expect(folded.map((i) => [i.keyword, i.line])).toEqual([
    ["FROM", 1],
    ["RUN", 2],
    ["ENV", 6],
  ]);
  expect(folded[1]?.args).toBe("one   && two");
});

test("the tokenizer honours quotes, comments and separators", () => {
  const lists = segments(`a 'b c' "d e" f#g # tail\n h | i && j; k \\
 l $(m) \`n\``);
  expect(lists.map((l) => l.map((w) => w.text))).toEqual([
    ["a", "b c", "d e", "f#g"],
    ["h"],
    ["i"],
    ["j"],
    ["k", "l", "", ""],
    ["m"],
    ["n"],
  ]);
  expect(lists[4]?.[2]?.expands).toBe(true);
  expect(segments(`"$X" $Y 'z$'`)[0]?.map((w) => w.expands)).toEqual([
    true,
    true,
    false,
  ]);
});

const context: Context = {
  command: "pnpm",
  storeEnv: "npm_config_store_dir",
  where: "f:1",
  pinned: true,
};
const calls = (shell: string) => invocations(shell, context).map((c) => c.args);

test("invocations see through wrappers, loops, conditionals and -c bodies", () => {
  expect(calls("pnpm install")).toEqual([["install"]]);
  expect(calls("CI=1 /usr/local/bin/pnpm -r build")).toEqual([["-r", "build"]]);
  expect(calls("env -i CI=1 sudo -E nice timeout -k 5 30s pnpm test")).toEqual([
    ["test"],
  ]);
  expect(calls("for p in a b; do pnpm --filter $p test; done")).toEqual([
    ["--filter", "$p", "test"],
  ]);
  expect(calls("if pnpm outdated; then exit 1; fi")).toEqual([["outdated"]]);
  expect(calls("! pnpm audit || true")).toEqual([["audit"]]);
  expect(calls("case $x in a) pnpm one;; *) pnpm two;; esac")).toEqual([
    ["one"],
    ["two"],
  ]);
  expect(calls("/bin/bash -c 'pnpm licenses list'")).toEqual([
    ["licenses", "list"],
  ]);
  expect(calls('sh -c "pnpm i && pnpm b"')).toEqual([["i"], ["b"]]);
  expect(calls("npm ci && echo pnpm")).toEqual([]);
  expect(calls("echo $(pnpm bin)")).toEqual([["bin"]]);
});

test("a dynamic command or -c body is unreadable", () => {
  for (const shell of ["$PM install", 'sh -c "$SCRIPT"', "bash -c"])
    expect(() => invocations(shell, context)).toThrow(Unreadable);
});

test("RUN flags are split off and cache targets read in every spelling", () => {
  const { mounts, body } = splitRun(
    "--mount=type=cache,target=/a --mount=type=bind,source=x,target=/b --network=none --mount=type=cache,dst=/c/ --mount=destination=/d,type=cache pnpm i",
    "f:1",
  );
  expect(mounts).toEqual([
    { target: "/a", id: "/a" },
    { target: "/c", id: "/c" },
    { target: "/d", id: "/d" },
  ]);
  expect(body).toBe("pnpm i");
  expect(() => splitRun("--mount=type=cache,id=x pnpm i", "f:1")).toThrow(
    Unreadable,
  );
  expect(() => splitRun("pnpm i <<EOF\npnpm b\nEOF", "f:1")).toThrow(
    Unreadable,
  );
});

test("ENV pairs come in both forms, quoted or not", () => {
  const pairs = (args: string) =>
    envPairs(args, "f:1").map(([k, v]) => [k, v?.text, v?.expands]);
  expect(pairs("A=1 B=\"two words\" C='$x'")).toEqual([
    ["A", "1", false],
    ["B", "two words", false],
    ["C", "$x", false],
  ]);
  expect(pairs("STORE /pnpm-store")).toEqual([["STORE", "/pnpm-store", false]]);
  // The one-pair form's value is the whole rest of the line.
  expect(pairs("STORE /s extra")).toEqual([["STORE", undefined, undefined]]);
  expect(pairs('STORE "/s extra"')).toEqual([["STORE", "/s extra", false]]);
  expect(pairs("STORE=$BASE/store")).toEqual([["STORE", "$BASE/store", true]]);
  expect(() => envPairs("", "f:1")).toThrow(Unreadable);
});

test("a stage inherits the pin of the stage it builds on, by name, case-insensitively", () => {
  const text = [
    "FROM node AS Base",
    "ENV npm_config_store_dir=/s",
    "FROM base AS build",
    "RUN pnpm i",
    "FROM node AS fresh",
    "RUN pnpm i",
  ].join("\n");
  const { findings, stages, pinned, checked } = checkDockerfile(
    text,
    "f",
    DEFAULTS,
  );
  expect([stages, pinned, checked]).toEqual([3, 1, 2]);
  expect(findings.map((f) => f.line)).toEqual([4]);
});

test("a pin applies only to the RUNs after it", () => {
  const text = [
    "FROM node",
    "RUN pnpm i",
    "ENV npm_config_store_dir=/s",
    "RUN pnpm i",
  ].join("\n");
  expect(
    checkDockerfile(text, "f", DEFAULTS).findings.map((f) => f.line),
  ).toEqual([4]);
});

test("a mount target with a trailing slash matches the pin", () => {
  const text = [
    "FROM node",
    "ENV npm_config_store_dir=/s/",
    "RUN --mount=type=cache,target=/s pnpm i",
  ].join("\n");
  expect(checkDockerfile(text, "f", DEFAULTS).findings).toEqual([]);
});

const withArg = (value: string) => ({
  ...DEFAULTS,
  buildArgs: new Map([["npm_config_store_dir", value]]),
});

test("a build argument pins the store with the value the build passes, inherited by child stages", () => {
  const text = [
    "FROM node AS base",
    "ARG npm_config_store_dir=/s",
    "RUN --mount=type=cache,target=/other pnpm i",
    "FROM base AS build",
    "RUN pnpm i",
  ].join("\n");
  const { findings, pinned } = checkDockerfile(text, "f", withArg("/other"));
  expect(pinned).toBe(1);
  expect(findings.map((f) => f.line)).toEqual([5]);
});

test("a build argument's default is not its value: without --build-arg the pin is unreadable", () => {
  for (const arg of [
    "ARG npm_config_store_dir=/s",
    "ARG npm_config_store_dir",
    "ARG other=1 npm_config_store_dir",
  ])
    expect(() =>
      checkDockerfile(
        ["FROM node", arg, "RUN --mount=type=cache,target=/s pnpm i"].join(
          "\n",
        ),
        "f",
        DEFAULTS,
      ),
    ).toThrow(Unreadable);
  expect(() =>
    checkDockerfile(
      [
        "FROM node AS base",
        "ARG npm_config_store_dir=/s",
        "FROM base",
        "RUN pnpm i",
      ].join("\n"),
      "f",
      DEFAULTS,
    ),
  ).toThrow(Unreadable);
  expect(() =>
    checkDockerfile(
      ["FROM node", "ARG npm_config_store_dir", "RUN pnpm i"].join("\n"),
      "f",
      withArg("$STORE"),
    ),
  ).toThrow(Unreadable);
  // A stage whose RUNs never invoke the command reads no store.
  expect(
    checkDockerfile(
      ["FROM node", "ARG npm_config_store_dir", "RUN true"].join("\n"),
      "f",
      DEFAULTS,
    ).findings,
  ).toEqual([]);
  expect(argPairs("A=1 B C=$D", "f:1")).toEqual([
    ["A", { text: "1", expands: false }],
    ["B", undefined],
    ["C", { text: "$D", expands: true }],
  ]);
  expect(() => argPairs("", "f:1")).toThrow(Unreadable);
});

test("ENV outranks ARG for the store's path, in either order", () => {
  for (const [first, second] of [
    ["ARG npm_config_store_dir", "ENV npm_config_store_dir=/b"],
    ["ENV npm_config_store_dir=/b", "ARG npm_config_store_dir"],
  ]) {
    const text = [
      "FROM node",
      first,
      second,
      "RUN --mount=type=cache,target=/b pnpm i",
    ].join("\n");
    expect(checkDockerfile(text, "f", withArg("/a")).findings).toEqual([]);
    expect(checkDockerfile(text, "f", DEFAULTS).findings).toEqual([]);
  }
});

test("a FROM through an expansion is unreadable once a stage pins the store, and read otherwise", () => {
  const pinned = [
    "ARG BASE=deps",
    "FROM node AS deps",
    "ENV npm_config_store_dir=/s",
    "FROM $BASE AS build",
    "RUN pnpm i",
  ].join("\n");
  expect(() => checkDockerfile(pinned, "f", DEFAULTS)).toThrow(Unreadable);
  const unpinned = ["ARG V=24", "FROM node:$V", "RUN pnpm i"].join("\n");
  expect(checkDockerfile(unpinned, "f", DEFAULTS).findings).toEqual([]);
});

test("a cache mount whose target is an expansion is unreadable", () => {
  expect(() =>
    splitRun("--mount=type=cache,target=$STORE pnpm i", "f:1"),
  ).toThrow(Unreadable);
  expect(() => splitRun("--mount=type=cache,dst=$STORE pnpm i", "f:1")).toThrow(
    Unreadable,
  );
});

/** The findings of a one-stage Dockerfile whose store is pinned to /s. */
const pinnedRun = (...runs: string[]) =>
  checkDockerfile(
    ["FROM node", "ENV npm_config_store_dir=/s", ...runs].join("\n"),
    "f",
    DEFAULTS,
  ).findings.map((f) => `${f.line} ${f.rule}`);
const unreadable = (...runs: string[]) =>
  expect(() => pinnedRun(...runs)).toThrow(Unreadable);

test("combined shell options still find the -c body, in both forms", () => {
  expect(calls("sh -ec 'pnpm install'")).toEqual([["install"]]);
  expect(calls("bash -euxc 'pnpm i'")).toEqual([["i"]]);
  expect(calls("bash -o pipefail -c 'pnpm i'")).toEqual([["i"]]);
  expect(pinnedRun('RUN ["sh", "-ec", "pnpm install"]')).toEqual([
    "3 cache-mount-missing",
  ]);
  expect(() => invocations("bash --rcfile x -c 'pnpm i'", context)).toThrow(
    Unreadable,
  );
});

test("exec form reads through the same wrappers as shell form", () => {
  expect(pinnedRun('RUN ["env", "pnpm", "install"]')).toEqual([
    "3 cache-mount-missing",
  ]);
  expect(pinnedRun('RUN ["timeout", "5m", "pnpm", "i"]')).toEqual([
    "3 cache-mount-missing",
  ]);
  // Not a JSON array: Docker runs it as shell form, and so does the reader.
  expect(pinnedRun("RUN [ -f x ] && pnpm i")).toEqual([
    "3 cache-mount-missing",
  ]);
});

test("a substitution's commands are read, quoted or not, and the outer command keeps its arguments", () => {
  expect(calls('echo "`pnpm install`"')).toEqual([["install"]]);
  expect(calls("echo `pnpm bin`")).toEqual([["bin"]]);
  expect(calls('pnpm install "$(echo x)" --store-dir=/other')).toEqual([
    ["install", "", "--store-dir=/other"],
  ]);
  expect(calls("pnpm install $(echo x) --store-dir=/other")).toEqual([
    ["install", "", "--store-dir=/other"],
  ]);
  expect(calls('echo "$(echo ")") $(pnpm bin)"')).toEqual([["bin"]]);
  for (const shell of [
    "echo $(pnpm i",
    "echo `pnpm i",
    "echo 'x",
    "echo $(case x in a) pnpm i;; esac)",
  ])
    expect(() => invocations(shell, context)).toThrow(Unreadable);
});

test("leading redirections are not the command", () => {
  expect(calls("> /tmp/install.log pnpm install")).toEqual([["install"]]);
  expect(calls(">/tmp/log 2>&1 pnpm install")).toEqual([["install"]]);
  expect(calls("pnpm install 2>&1 | tee log")).toEqual([["install", "2>&1"]]);
});

test("a command's own store setting is the store it reads", () => {
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/s npm_config_store_dir=/other pnpm install",
    ),
  ).toEqual(["3 cache-mount-missing"]);
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/s env npm_config_store_dir=/other pnpm install",
    ),
  ).toEqual(["3 cache-mount-missing"]);
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/other npm_config_store_dir=/other pnpm install",
    ),
  ).toEqual([]);
  for (const run of [
    "RUN --mount=type=cache,target=/s npm_config_store_dir=$STORE pnpm install",
    "RUN --mount=type=cache,target=/s env -u npm_config_store_dir pnpm install",
    "RUN --mount=type=cache,target=/s env -i pnpm install",
    "RUN --mount=type=cache,target=/s sudo pnpm install",
    "RUN --mount=type=cache,target=/s npm_config_store_dir=/o; pnpm install",
    "RUN --mount=type=cache,target=/s export npm_config_store_dir=/o && pnpm install",
    "RUN --mount=type=cache,target=/s unset npm_config_store_dir && pnpm install",
  ])
    unreadable(run);
  expect(
    pinnedRun("RUN --mount=type=cache,target=/s sudo -E pnpm install"),
  ).toEqual([]);
});

test("eval's literal text is read, and a shell reading standard input stops the check", () => {
  expect(pinnedRun("RUN eval pnpm install")).toEqual(["3 cache-mount-missing"]);
  unreadable("RUN echo 'pnpm install' | sh");
  unreadable("RUN bash <<<'pnpm install'");
  unreadable("RUN eval $CMD");
});

test("a RUN option the reader does not know stops the check", () => {
  unreadable("RUN --device=nvidia.com/gpu=all pnpm install");
  unreadable("RUN --frobnicate pnpm install");
});

test("a SHELL that is not a POSIX shell stops the check for shell-form RUNs, in the stage and its children", () => {
  unreadable('SHELL ["python3", "-c"]', "RUN import subprocess");
  expect(() =>
    checkDockerfile(
      [
        "FROM node AS a",
        'SHELL ["pwsh", "-Command"]',
        "FROM a",
        "RUN pnpm i",
      ].join("\n"),
      "f",
      DEFAULTS,
    ),
  ).toThrow(Unreadable);
  expect(
    pinnedRun('SHELL ["/bin/bash", "-o", "pipefail", "-c"]', "RUN pnpm i"),
  ).toEqual(["4 cache-mount-missing"]);
  expect(pinnedRun('SHELL ["python3", "-c"]', 'RUN ["pnpm", "i"]')).toEqual([
    "4 cache-mount-missing",
  ]);
});

test("a continued argument stays on its command", () => {
  const text = [
    "FROM node",
    "ENV npm_config_store_dir=/s",
    "RUN --mount=type=cache,target=/s pnpm install \\",
    "  --store-dir=/other",
  ].join("\n");
  expect(
    checkDockerfile(text, "f", DEFAULTS).findings.map((f) => f.rule),
  ).toEqual(["store-flag"]);
});

test("a file that ends inside a continuation is unreadable", () =>
  expect(() =>
    instructions(
      "FROM node\nENV npm_config_store_dir=/s\nRUN pnpm install \\",
      "f",
    ),
  ).toThrow(Unreadable));

test("every mount of the store's path is the same cache", () => {
  expect(
    pinnedRun(
      "RUN --mount=type=cache,id=deps,target=/s pnpm install",
      "RUN --mount=type=cache,id=other,target=/s pnpm build",
    ),
  ).toEqual(["4 cache-id-mismatch"]);
  expect(
    pinnedRun(
      "RUN --mount=type=cache,id=deps,target=/s pnpm install",
      "RUN --mount=type=cache,target=/s pnpm build",
    ),
  ).toEqual(["4 cache-id-mismatch"]);
  expect(
    pinnedRun(
      "RUN --mount=type=cache,id=deps,target=/s pnpm install",
      "RUN --mount=type=cache,id=deps,target=/s/ pnpm build",
      "RUN --mount=type=cache,target=/other,id=x pnpm --version",
    ),
  ).toEqual(["5 cache-mount-missing"]);
  unreadable("RUN --mount=type=cache,id=$ID,target=/s pnpm install");
});

test("a command's store setting reaches the commands it runs", () => {
  for (const nested of [
    "sh -c 'pnpm install'",
    "bash -ec 'pnpm install'",
    "eval pnpm install",
  ]) {
    expect(
      pinnedRun(
        `RUN --mount=type=cache,target=/s npm_config_store_dir=/other ${nested}`,
      ),
    ).toEqual(["3 cache-mount-missing"]);
    expect(
      pinnedRun(
        `RUN --mount=type=cache,target=/other npm_config_store_dir=/other ${nested}`,
      ),
    ).toEqual([]);
    unreadable(`RUN --mount=type=cache,target=/s env -i ${nested}`);
  }
  unreadable(
    "RUN --mount=type=cache,target=/s npm_config_store_dir=/o sh -c 'npm_config_store_dir=/p; pnpm i'",
  );
});

test("a wrapper option the reader does not model stops the check", () => {
  for (const run of [
    "RUN --mount=type=cache,target=/s env -unpm_config_store_dir pnpm install",
    "RUN --mount=type=cache,target=/s env --unset=npm_config_store_dir pnpm install",
    "RUN --mount=type=cache,target=/s sudo --preserve-env=CI pnpm install",
    "RUN --mount=type=cache,target=/s exec -c pnpm install",
    "RUN --mount=type=cache,target=/s env --frobnicate pnpm install",
    "RUN --mount=type=cache,target=/s sudo -i pnpm install",
    "RUN --mount=type=cache,target=/s env -iu x pnpm install",
    "RUN --mount=type=cache,target=/s env -u $V pnpm install",
  ])
    unreadable(run);
  for (const run of [
    "RUN --mount=type=cache,target=/s env -uOTHER pnpm install",
    "RUN --mount=type=cache,target=/s sudo --preserve-env=CI,npm_config_store_dir pnpm install",
    "RUN --mount=type=cache,target=/s sudo -uroot -E pnpm install",
    "RUN --mount=type=cache,target=/s timeout --signal=KILL 30s pnpm install",
    "RUN --mount=type=cache,target=/s env -- pnpm install",
  ])
    expect(pinnedRun(run)).toEqual([]);
});

test("cache identity is checked on every store a RUN reads, within one stage lineage", () => {
  expect(
    pinnedRun(
      "RUN --mount=type=cache,id=a,target=/other npm_config_store_dir=/other pnpm install",
      "RUN --mount=type=cache,id=b,target=/other npm_config_store_dir=/other pnpm build",
    ),
  ).toEqual(["4 cache-id-mismatch"]);
  const stages = (...lines: string[]) =>
    checkDockerfile(lines.join("\n"), "f", DEFAULTS).findings.map(
      (f) => `${f.line} ${f.rule}`,
    );
  expect(
    stages(
      "FROM node AS frontend",
      "ENV npm_config_store_dir=/s",
      "RUN --mount=type=cache,id=frontend-deps,target=/s pnpm install",
      "FROM node AS backend",
      "ENV npm_config_store_dir=/s",
      "RUN --mount=type=cache,id=backend-deps,target=/s pnpm install",
    ),
  ).toEqual([]);
  expect(
    stages(
      "FROM node AS deps",
      "ENV npm_config_store_dir=/s",
      "RUN --mount=type=cache,id=deps,target=/s pnpm install",
      "FROM deps AS build",
      "RUN --mount=type=cache,id=other,target=/s pnpm build",
    ),
  ).toEqual(["5 cache-id-mismatch"]);
});

test("a function's body is read in the RUN that defines it", () => {
  expect(pinnedRun("RUN function deps { pnpm install; }; deps")).toEqual([
    "3 cache-mount-missing",
  ]);
  expect(pinnedRun("RUN deps() { pnpm install; }; deps")).toEqual([
    "3 cache-mount-missing",
  ]);
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/s function deps { pnpm i; }; deps",
    ),
  ).toEqual([]);
});

test("a pin of several words in ENV's one-pair form is unreadable", () => {
  expect(() =>
    checkDockerfile(
      "FROM node\nENV npm_config_store_dir /s extra\nRUN --mount=type=cache,target=/s pnpm i",
      "f",
      DEFAULTS,
    ),
  ).toThrow(Unreadable);
  expect(
    checkDockerfile(
      "FROM node\nENV OTHER two words\nENV npm_config_store_dir /s\nRUN --mount=type=cache,target=/s pnpm i",
      "f",
      DEFAULTS,
    ).findings,
  ).toEqual([]);
});

test("a function is called with the store its body was read with, or the check stops", () => {
  unreadable(
    "RUN --mount=type=cache,target=/s deps() { pnpm install; }; npm_config_store_dir=/other deps",
  );
  unreadable(
    "RUN --mount=type=cache,target=/s function deps { pnpm i; }; env -i deps",
  );
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/s deps() { pnpm install; }; CI=1 deps",
    ),
  ).toEqual([]);
  // Setting the pinned path again gives the function the same store.
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/s deps() { pnpm install; }; npm_config_store_dir=/s/ deps",
    ),
  ).toEqual([]);
});

test("a function named for a command the check models stops the check", () => {
  for (const name of ["env", "sudo", "bash", "eval", "export", "pnpm"])
    unreadable(
      `RUN --mount=type=cache,target=/s ${name}() { pnpm install; }; npm_config_store_dir=/other ${name} ignored`,
    );
  unreadable(
    "RUN --mount=type=cache,target=/s function time { pnpm i; }; time ls",
  );
});

test("functions are found in shell syntax, not in quoted text or comments", () => {
  expect(
    pinnedRun(
      "RUN --mount=type=cache,target=/s printf '%s' 'example: function cat'; npm_config_store_dir=/other cat /etc/os-release",
    ),
  ).toEqual([]);
  expect(
    pinnedRun(
      `RUN --mount=type=cache,target=/s echo "deps()" \\deps\\(\\) # deps()\nRUN npm_config_store_dir=/other deps`,
    ),
  ).toEqual([]);
  // A definition after a reserved word, or inside a substitution, counts.
  unreadable(
    "RUN --mount=type=cache,target=/s if true; then deps() { pnpm i; }; fi; npm_config_store_dir=/other deps",
  );
  unreadable(
    "RUN --mount=type=cache,target=/s x=$(deps() { :; }); npm_config_store_dir=/other deps",
  );
  // So does a definition the shell's `time` keyword times.
  for (const timed of ["time", "time -p", "! time"]) {
    unreadable(
      `RUN --mount=type=cache,target=/s ${timed} deps() { pnpm i; }; npm_config_store_dir=/other deps`,
    );
    unreadable(
      `RUN --mount=type=cache,target=/s ${timed} function deps { pnpm i; }; npm_config_store_dir=/other deps`,
    );
  }
});

test("a timed definition's body is read where it is defined", () => {
  for (const timed of ["time", "time -p", "! time"]) {
    for (const definition of [
      `${timed} function deps { pnpm install; }`,
      `${timed} deps() { pnpm install; }`,
    ]) {
      expect(pinnedRun(`RUN ${definition}; deps`)).toEqual([
        "3 cache-mount-missing",
      ]);
      expect(
        pinnedRun(
          `RUN --mount=type=cache,target=/s ${definition.replace("install", "install --store-dir=/other")}; deps`,
        ),
      ).not.toEqual([]);
      expect(
        pinnedRun(`RUN --mount=type=cache,target=/s ${definition}; deps`),
      ).toEqual([]);
    }
  }
});

test("time is read as a wrapper with its options", () => {
  expect(pinnedRun("RUN time -p pnpm install")).toEqual([
    "3 cache-mount-missing",
  ]);
  expect(pinnedRun("RUN /usr/bin/time -o t.log pnpm install")).toEqual([
    "3 cache-mount-missing",
  ]);
  unreadable("RUN time --frobnicate pnpm install");
});

test("a SHELL with an operand among its options is not a shell the RUN text is read for", () => {
  unreadable('SHELL ["/bin/bash", "-c", "pnpm install", "-c"]', "RUN true");
  unreadable('SHELL ["/bin/bash", "-o", "-c"]', "RUN true");
  expect(
    pinnedRun(
      'SHELL ["/bin/bash", "-e", "+x", "-o", "pipefail", "-c"]',
      "RUN true",
    ),
  ).toEqual([]);
});

test("an argument whose expansion can pass the store flag is unreadable", () => {
  for (const args of ["$FLAGS", '"$F"', "--store$X", "--filter=$X", "-$X"])
    unreadable(`RUN --mount=type=cache,target=/s pnpm install ${args}`);
  expect(
    pinnedRun(
      'RUN --mount=type=cache,target=/s pnpm --filter "app-$P" --filter="$Q" test',
    ),
  ).toEqual([]);
  expect(
    pinnedRun("RUN --mount=type=cache,target=/s pnpm i --store-dir=$S"),
  ).toEqual(["3 store-flag"]);
});
