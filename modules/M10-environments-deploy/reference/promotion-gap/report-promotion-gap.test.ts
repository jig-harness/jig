import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  compilePattern,
  keysIn,
  main,
  parseLog,
  parseOptions,
  promotionGap,
} from "./report-promotion-gap.ts";

const script = join(import.meta.dir, "report-promotion-gap.ts");
const fixtures = join(import.meta.dir, "fixtures");
const fixture = (name: string) => join(fixtures, name);
const KEY = "[A-Z]+-[0-9]+";

/** The environment without anything that points git at another repository. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase())
    )
      env[key] = value;
  return {
    ...env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

function run(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: import.meta.dir,
    env: cleanEnv(),
    input: input ?? "",
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

const logged = (name: string, extra: string[] = []) =>
  run(["--pattern", KEY, "--log", fixture(name), ...extra]);

describe("a collected log", () => {
  test("reports the items the subjects and trailers name, each once, sorted", () => {
    const r = logged("gap.txt", ["--ignore-case"]);
    expectSpawnExit(r, 0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe(
      "GAP — 5 work item(s) across 5 commit(s) in the collected log; 1 commit(s) name no item",
    );
    expect(lines.slice(1)).toEqual([
      "  - SHOP-7 (1 commit(s))",
      "  - SHOP-12 (2 commit(s))",
      "  - SHOP-13 (1 commit(s))",
      "  - SHOP-14 (1 commit(s))",
      "  - SHOP-15 (1 commit(s))",
      "  - (no item) 222222222222 docs: fix a typo in the guide",
    ]);
  });

  test("matches keys as written unless --ignore-case", () => {
    const r = logged("gap.txt", ["--json"]);
    expectSpawnExit(r, 0);
    const gap = JSON.parse(r.stdout);
    expect(gap.items.map((item: { key: string }) => item.key)).toEqual([
      "SHOP-7",
      "SHOP-12",
      "SHOP-13",
      "SHOP-15",
    ]);
    expect(gap.from).toBeNull();
    expect(gap.over).toBe(false);
  });

  test("commits that name no item are a gap of nothing", () => {
    const r = logged("no-items.txt");
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("0 work item(s) across 2 commit(s)");
  });

  test("more items than --max-items fails", () => {
    const r = logged("gap.txt", ["--max-items", "2"]);
    expectSpawnExit(r, 1);
    expect(r.stdout).toStartWith("OVER — 4 work item(s) wait");
    expectSpawnExit(logged("gap.txt", ["--max-items", "4"]), 0);
  });

  test("reads standard input as -", () => {
    const r = run(
      ["--pattern", KEY, "--log", "-", "--json"],
      "1111111111111111111111111111111111111111 feat: x (SHOP-1)\n",
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).items).toEqual([
      { key: "SHOP-1", commits: ["1111111111111111111111111111111111111111"] },
    ]);
  });

  test("a commit listed twice is counted once", () => {
    const record =
      "1111111111111111111111111111111111111111 feat: x (SHOP-1)\nRefs: SHOP-2\n";
    const r = run(
      ["--pattern", KEY, "--log", "-", "--json"],
      `${record}\n${record}`,
    );
    expectSpawnExit(r, 0);
    const gap = JSON.parse(r.stdout);
    expect(gap.commits).toBe(1);
    expect(gap.items).toEqual([
      { key: "SHOP-1", commits: ["1111111111111111111111111111111111111111"] },
      { key: "SHOP-2", commits: ["1111111111111111111111111111111111111111"] },
    ]);
  });

  test("one commit listed twice with different content fails closed", () => {
    const sha = "1".repeat(40);
    const r = run(
      ["--pattern", KEY, "--log", "-"],
      `${sha} feat: x (SHOP-1)\n\n${sha} feat: x (SHOP-1)\nRefs: SHOP-2\n`,
    );
    expectSpawnExit(r, 2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("listed twice");
  });

  for (const pattern of ["\\b", "(?=SHOP-[0-9]+)"])
    test(`a pattern that matches an empty string in a commit (${pattern}) fails closed`, () => {
      const r = run(["--pattern", pattern, "--log", fixture("gap.txt")]);
      expectSpawnExit(r, 2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("matched an empty string");
    });

  for (const name of [
    "empty.txt",
    "blank.txt",
    "malformed.txt",
    "trailer-first.txt",
    "does-not-exist.txt",
  ])
    test(`fails closed on ${name}`, () => {
      const r = logged(name);
      expectSpawnExit(r, 2);
      expect(r.stdout).toBe("");
    });
});

describe("usage", () => {
  for (const [label, args] of [
    ["no pattern", ["--log", fixture("gap.txt")]],
    [
      "a pattern that is not a regular expression",
      ["--pattern", "(", "--log", fixture("gap.txt")],
    ],
    [
      "a pattern that matches the empty string",
      ["--pattern", "[A-Z]*", "--log", fixture("gap.txt")],
    ],
    [
      "--log with --from",
      [
        "--pattern",
        KEY,
        "--log",
        fixture("gap.txt"),
        "--from",
        "a",
        "--to",
        "b",
      ],
    ],
    ["--from without --to", ["--pattern", KEY, "--from", "a"]],
    ["neither --log nor refs", ["--pattern", KEY]],
    [
      "a negative bound",
      ["--pattern", KEY, "--log", fixture("gap.txt"), "--max-items", "-1"],
    ],
    [
      "a bound that is not a number",
      ["--pattern", KEY, "--log", fixture("gap.txt"), "--max-items", "many"],
    ],
    [
      "an unknown option",
      ["--pattern", KEY, "--log", fixture("gap.txt"), "--verbose"],
    ],
    ["a flag without its value", ["--pattern", KEY, "--log"]],
  ] as [string, string[]][])
    test(`${label} is a usage error`, () => {
      const r = run(args);
      expectSpawnExit(r, 2);
      expect(r.stderr).toMatch(/usage:|--pattern/);
    });
});

describe("a pair of refs", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const root of repos) rmSync(root, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", args, { cwd, env: cleanEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  function commit(root: string, subject: string, ...bodyParagraphs: string[]) {
    writeFileSync(join(root, "file.txt"), `${subject}\n`);
    const messages = [subject, ...bodyParagraphs].flatMap((m) => ["-m", m]);
    git(root, "add", "-A");
    git(root, "commit", "-q", ...messages);
    return git(root, "rev-parse", "HEAD");
  }

  /** A repository where `release` lags `main` by three commits. */
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "promotion-gap-"));
    repos.push(root);
    git(root, "init", "-q", "-b", "main");
    commit(root, "feat: first (SHOP-1)");
    git(root, "branch", "release");
    commit(root, "feat(orders): refunds (SHOP-2)", "Refs: SHOP-3");
    commit(root, "docs: guide");
    commit(root, "fix: rounding", "Closes: SHOP-2");
    return root;
  }

  const between = (
    root: string,
    from: string,
    to: string,
    extra: string[] = [],
  ) =>
    run([
      "--pattern",
      KEY,
      "--cwd",
      root,
      "--from",
      from,
      "--to",
      to,
      "--json",
      ...extra,
    ]);

  test("lists what <to> holds and <from> lacks", () => {
    const root = repo();
    const r = between(root, "release", "main");
    expectSpawnExit(r, 0);
    const gap = JSON.parse(r.stdout);
    expect(gap.from.ref).toBe("release");
    expect(gap.from.sha).toBe(git(root, "rev-parse", "release"));
    expect(gap.to.sha).toBe(git(root, "rev-parse", "main"));
    expect(gap.commits).toBe(3);
    expect(gap.items.map((item: { key: string }) => item.key)).toEqual([
      "SHOP-2",
      "SHOP-3",
    ]);
    expect(gap.items[0].commits).toHaveLength(2);
    expect(gap.unkeyed.map((c: { subject: string }) => c.subject)).toEqual([
      "docs: guide",
    ]);
  });

  test("two refs with nothing between them are a gap of nothing", () => {
    const root = repo();
    const r = between(root, "main", "main");
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      commits: 0,
      items: [],
      unkeyed: [],
    });
  });

  test("a <from> that is not an ancestor of <to> is not a range", () => {
    const root = repo();
    git(root, "checkout", "-q", "release");
    commit(root, "fix: hotfix straight to release (SHOP-9)");
    git(root, "checkout", "-q", "main");
    const r = between(root, "release", "main");
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("release is not an ancestor of main");
  });

  test("a ref that names no commit fails closed, even one shaped like an option", () => {
    const root = repo();
    expectSpawnExit(between(root, "release", "nowhere"), 2);
    const r = between(root, "--help", "main");
    expectSpawnExit(r, 2);
    expect(r.stderr).toMatch(/--help|--from/);
  });

  test("--cwd decides the repository even when a hook exports GIT_DIR", () => {
    const root = repo();
    const decoy = repo();
    commit(decoy, "feat: elsewhere (SHOP-99)");
    // The guarded launch refuses a routing variable, so a harness adds them
    // only to the report's own process, as a git hook would.
    const leaks = { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy };
    const harness = `
      const result = Bun.spawnSync(
        [process.execPath, ${JSON.stringify(script)}, "--pattern", ${JSON.stringify(KEY)},
         "--cwd", ${JSON.stringify(root)}, "--from", "release", "--to", "main", "--json"],
        { env: { ...process.env, ...${JSON.stringify(leaks)} } },
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    `;
    const launched = spawnSync(process.execPath, ["-e", harness], {
      cwd: import.meta.dir,
      env: cleanEnv(),
    });
    const r = {
      exitCode: launched.status,
      stdout: launched.stdout,
      stderr: launched.stderr,
    };
    expectSpawnExit(r, 0);
    const gap = JSON.parse(r.stdout);
    expect(gap.to.sha).toBe(git(root, "rev-parse", "main"));
    expect(gap.items.map((item: { key: string }) => item.key)).toEqual([
      "SHOP-2",
      "SHOP-3",
    ]);
  });

  test("a directory that is not a repository fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "promotion-gap-plain-"));
    repos.push(root);
    expectSpawnExit(between(root, "a", "b"), 2);
  });
});

describe("the pure parts", () => {
  test("parseLog reads a SHA-256 commit line", () => {
    const sha = "a".repeat(64);
    expect(parseLog(`${sha} feat: x (SHOP-1)\nRefs: SHOP-2\n`)).toEqual([
      { sha, subject: "feat: x (SHOP-1)", trailers: ["Refs: SHOP-2"] },
    ]);
    expect(() => parseLog(`${"a".repeat(50)} feat: x\n`)).toThrow(
      "neither a commit line",
    );
  });

  test("parseLog keeps trailers with their commit and tolerates CRLF", () => {
    const commits = parseLog(
      "1111111111111111111111111111111111111111 a\r\nRefs: X-1\r\n\r\n2222222222222222222222222222222222222222 b\r\n",
    );
    expect(commits).toEqual([
      {
        sha: "1111111111111111111111111111111111111111",
        subject: "a",
        trailers: ["Refs: X-1"],
      },
      {
        sha: "2222222222222222222222222222222222222222",
        subject: "b",
        trailers: [],
      },
    ]);
  });

  test("keysIn de-duplicates and keeps first appearance", () => {
    const pattern = compilePattern(KEY, false);
    expect(keysIn("B-2 then A-1 then B-2", pattern, false)).toEqual([
      "B-2",
      "A-1",
    ]);
    expect(keysIn("b-2", compilePattern(KEY, true), true)).toEqual(["B-2"]);
  });

  test("promotionGap sorts keys numerically within a prefix", () => {
    const gap = promotionGap(
      [
        { sha: "1".repeat(40), subject: "x (A-10)", trailers: [] },
        { sha: "2".repeat(40), subject: "y (A-9)", trailers: ["Refs: A-10"] },
      ],
      compilePattern(KEY, false),
      false,
    );
    expect(gap.items).toEqual([
      { key: "A-9", commits: ["2".repeat(40)] },
      { key: "A-10", commits: ["1".repeat(40), "2".repeat(40)] },
    ]);
  });

  test("parseOptions applies the mode rules, and main runs in-process", () => {
    expect(() => parseOptions(["--pattern", KEY])).toThrow("give --from");
    expect(() =>
      parseOptions(["--pattern", KEY, "--log", "x", "--to", "b"]),
    ).toThrow("--log excludes");
    const options = parseOptions([
      "--pattern",
      KEY,
      "--log",
      "x",
      "--max-items",
      "3",
      "--json",
    ]);
    expect(options).toMatchObject({
      log: "x",
      maxItems: 3,
      json: true,
      ignoreCase: false,
    });
    expect(main(["--pattern", KEY, "--log", fixture("no-items.txt")])).toBe(0);
    expect(
      main(["--pattern", KEY, "--log", fixture("gap.txt"), "--max-items", "1"]),
    ).toBe(1);
  });
});
