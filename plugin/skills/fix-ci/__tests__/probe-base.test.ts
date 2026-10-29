/**
 * probe-base.ts: a failing check is run again on a freshly fetched base in a
 * throwaway worktree, and the verdict says whether the failure belongs to the
 * change or was there before. Each case builds a bare remote and a clone in a
 * scratch directory, runs the script from the clone (as the plugin cache does,
 * from outside this directory) and reads its one JSON line.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { junitCases, junitVerdict, parseArgs } from "../scripts/probe-base.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "probe-base.ts");
const CHECK = "check.ts";
const PASSING =
  'console.log("check ran on the base");\nprocess.exitCode = 0;\n';
const FAILING =
  'console.log("check ran on the base");\nprocess.exitCode = 1;\n';
/** A check that needs what the setup step installs, as a suite needs node_modules. */
const NEEDS_SETUP =
  'if (require("node:fs").existsSync("installed")) { console.log("check ran on the base"); process.exitCode = 0; } else { console.log("not installed"); process.exitCode = 1; }\n';
const SETUP = "setup.ts";
const INSTALLS = 'require("node:fs").writeFileSync("installed", "");\n';
/** The setup command runs through the shell, so the runtime's path is quoted. */
const SETUP_COMMAND = `"${process.execPath}" ${SETUP}`;

let scratch: string;
let remote: string;
let seed: string;
let clone: string;

/** Git without the developer's hooks, config or signing, and with a fixed identity. */
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
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit `content` as the check on the seed clone's main and push it. */
function publish(content: string, message: string): string {
  writeFileSync(join(seed, CHECK), content);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", message);
  git(seed, "push", "-q", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

function run(args: string[], cwd: string = clone) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function verdict(stdout: string): {
  base: string;
  base_commit: string;
  setup: string | null;
  expect: string;
  command: string[];
  command_exit: number;
  evidence: string;
  junit: string | null;
  verdict: string;
} {
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

/** The text the check's failure shows, as CI would have shown it. */
const EXPECTED = "check ran on the base";
const CHECK_COMMAND = ["--expect", EXPECTED, "--", process.execPath, CHECK];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "probe-base-"));
  // Tracked links check out as links, as on POSIX: Git for Windows writes
  // them as plain files unless core.symlinks says otherwise.
  writeFileSync(join(scratch, "gitconfig"), "[core]\n\tsymlinks = true\n");
  remote = join(scratch, "remote.git");
  seed = join(scratch, "seed");
  clone = join(scratch, "clone");
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "remote", "add", "origin", remote);
  publish(PASSING, "base");
  git(scratch, "clone", "-q", remote, clone);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("probe-base", () => {
  test("the check passes on the base: the failure belongs to the change", () => {
    const base = git(clone, "rev-parse", "origin/main");
    writeFileSync(join(clone, CHECK), FAILING);
    const r = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(r, 0);
    const v = verdict(r.stdout);
    expect(v.verdict).toBe("change");
    expect(v.base).toBe("origin/main");
    expect(v.base_commit).toBe(base);
    expect(v.command_exit).toBe(0);
    expect(v.command).toEqual([process.execPath, CHECK]);
    expect(r.stderr).toContain("check ran on the base");
  });

  test("the check fails on the base too: the failure is pre-existing", () => {
    const broken = publish(FAILING, "break the check on main");
    const r = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(r, 1);
    const v = verdict(r.stdout);
    expect(v.verdict).toBe("pre-existing");
    expect(v.base_commit).toBe(broken);
    expect(v.command_exit).toBe(1);
    expect(v.expect).toBe(EXPECTED);
  });

  test("a failure on the base that does not show the expected text is no answer", () => {
    publish(FAILING, "break the check on main");
    const r = run([
      "--base",
      "main",
      "--expect",
      "total rounds to cents",
      "--",
      process.execPath,
      CHECK,
    ]);
    expectSpawnExit(r, 2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      'the command failed on the base (exit 1), but its output does not show "total rounds to cents"',
    );
  });

  test("fetches from the remote repository.remote names when --remote is not given", () => {
    git(clone, "remote", "rename", "origin", "upstream");
    const base = git(clone, "rev-parse", "upstream/main");
    writeFileSync(join(clone, CHECK), FAILING);
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--base", "main", ...CHECK_COMMAND],
      {
        cwd: clone,
        env: { ...cleanEnv(), JIG__REPOSITORY__REMOTE: "upstream" },
        encoding: "utf8",
      },
    );
    const result = { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    expectSpawnExit(result, 0);
    const v = verdict(result.stdout);
    expect(v.base).toBe("upstream/main");
    expect(v.base_commit).toBe(base);
  });

  test("fetches into a ref of its own and leaves it behind neither FETCH_HEAD nor the ref", () => {
    git(clone, "fetch", "-q", "origin", "main");
    const before = readFileSync(join(clone, ".git", "FETCH_HEAD"), "utf8");
    publish(FAILING, "break the check on main");
    const r = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(r, 1);
    expect(readFileSync(join(clone, ".git", "FETCH_HEAD"), "utf8")).toBe(
      before,
    );
    expect(git(clone, "for-each-ref", "refs/probe-base")).toBe("");
  });

  test("probes the commit the fetch returned, not the stale remote-tracking ref", () => {
    // The clone was taken when main passed; main then broke and was fixed
    // again while the clone's origin/main still points at the first commit.
    publish(FAILING, "break the check on main");
    const stale = git(clone, "fetch", "-q", "origin", "main");
    expect(stale).toBe("");
    const brokenRef = git(clone, "rev-parse", "origin/main");
    const fixed = publish(PASSING, "fix the check on main");
    expect(fixed).not.toBe(brokenRef);
    const r = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(r, 0);
    const v = verdict(r.stdout);
    expect(v.base_commit).toBe(fixed);
    expect(v.verdict).toBe("change");
  });

  test("never touches the checkout it runs from and leaves no worktree behind", () => {
    writeFileSync(join(clone, CHECK), FAILING);
    const before = git(clone, "status", "--porcelain");
    const r = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(r, 0);
    expect(readFileSync(join(clone, CHECK), "utf8")).toBe(FAILING);
    expect(git(clone, "status", "--porcelain")).toBe(before);
    expect(git(clone, "stash", "list")).toBe("");
    const worktrees = git(clone, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(worktrees).toHaveLength(1);
  });

  test("a check that needs an install step: --setup runs it in the worktree first", () => {
    writeFileSync(join(seed, SETUP), INSTALLS);
    publish(NEEDS_SETUP, "the check needs an install");
    writeFileSync(join(clone, CHECK), FAILING);
    // Without the install the base's check fails for another reason, which
    // is no answer rather than a pre-existing failure.
    const bare = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(bare, 2);
    expect(bare.stderr).toContain("not installed");
    expect(bare.stderr).toContain("does not show");
    const r = run([
      "--base",
      "main",
      "--setup",
      SETUP_COMMAND,
      ...CHECK_COMMAND,
    ]);
    expectSpawnExit(r, 0);
    const v = verdict(r.stdout);
    expect(v.verdict).toBe("change");
    expect(v.setup).toBe(SETUP_COMMAND);
    expect(r.stderr).toContain("check ran on the base");
    expect(existsSync(join(clone, "installed"))).toBe(false);
  });

  test("setup runs consumer install syntax through Bun without an external shell", () => {
    writeFileSync(join(seed, SETUP), INSTALLS);
    publish(NEEDS_SETUP, "the check needs a portable setup");
    const args = [
      "--base",
      "main",
      "--setup",
      `READY=yes; [ "$READY" = yes ] && ${SETUP_COMMAND}`,
      ...CHECK_COMMAND,
    ];
    const bootstrap = `
      import { mock } from "bun:test";
      const cp = await import("node:child_process");
      const original = cp.spawnSync;
      mock.module("node:child_process", () => ({ ...cp, spawnSync(command, args, options) {
        const shell = typeof args === "object" && !Array.isArray(args) ? args.shell : options?.shell;
        if (shell) throw new Error("setup must not launch an external shell");
        if (typeof command === "string" && command.startsWith("READY=")) throw new Error("setup must be passed as data to bun exec");
        return original(command, args, options);
      }}));
      const { main } = await import(${JSON.stringify(SCRIPT)});
      Object.defineProperty(process, "platform", { value: "win32" });
      process.exitCode = await main(${JSON.stringify(args)});
    `;
    const r = spawnSync(process.execPath, ["-e", bootstrap], {
      cwd: clone,
      env: cleanEnv(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expectSpawnExit({ ...r, exitCode: r.status }, 0);
    expect(verdict(r.stdout).verdict).toBe("change");
  });

  test("a setup command that fails is no answer", () => {
    const r = run([
      "--base",
      "main",
      "--setup",
      `"${process.execPath}" -e "process.exit(3)"`,
      ...CHECK_COMMAND,
    ]);
    expectSpawnExit(r, 2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("the setup command failed on the base (exit 3)");
    expect(
      git(clone, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toHaveLength(1);
  });

  test("a base that cannot be fetched is no answer", () => {
    git(clone, "remote", "set-url", "origin", join(scratch, "gone.git"));
    const r = run(["--base", "main", ...CHECK_COMMAND]);
    expectSpawnExit(r, 2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("could not decide");
    expect(r.stderr).toContain("fetching origin main failed");
    expect(
      git(clone, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toHaveLength(1);
  });

  test("a branch the remote does not have is no answer", () => {
    const r = run(["--base", "no-such-branch", ...CHECK_COMMAND]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("fetching origin no-such-branch failed");
  });

  test("outside a git repository it cannot decide", () => {
    const elsewhere = join(scratch, "plain");
    mkdirSync(elsewhere);
    const r = run(["--base", "main", ...CHECK_COMMAND], elsewhere);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("not inside a git repository");
  });

  test("a command that cannot start is no answer", () => {
    const r = run([
      "--base",
      "main",
      "--expect",
      EXPECTED,
      "--",
      "no-such-command-for-probe-base",
    ]);
    expectSpawnExit(r, 2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("could not run on the base");
  });

  test.skipIf(process.platform === "win32")(
    "a fetch that hangs is killed at the deadline and no answer",
    () => {
      // An SSH transport that never answers stands in for a hung remote.
      const ssh = join(scratch, "hung-ssh");
      writeFileSync(ssh, "#!/bin/sh\nexec 2>/dev/null\nsleep 5\n", {
        mode: 0o755,
      }); // fixed-delay: stands in for a remote that hangs
      git(clone, "remote", "set-url", "origin", "ssh://hung.invalid/repo.git");
      git(clone, "config", "core.sshCommand", ssh);
      const started = Date.now();
      const r = run(["--base", "main", "--timeout", "1", ...CHECK_COMMAND]);
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain("fetching origin main failed");
      expect(r.stderr).toContain("git ran over the deadline and was killed");
      expect(Date.now() - started).toBeLessThan(4000);
    },
  );

  test("a command that runs over the deadline is killed and no answer", () => {
    const r = run([
      "--base",
      "main",
      "--timeout",
      "1",
      "--expect",
      EXPECTED,
      "--",
      process.execPath,
      "-e",
      "await Bun.sleep(30000)", // fixed-delay: stands in for a check that hangs
    ]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("ran over the 1s deadline");
    expect(existsSync(join(clone, CHECK))).toBe(true);
    expect(
      git(clone, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree ")),
    ).toHaveLength(1);
  });

  test("a usage error exits 2 before any fetch", () => {
    git(clone, "remote", "set-url", "origin", join(scratch, "gone.git"));
    for (const args of [
      [...CHECK_COMMAND],
      ["--base", "main"],
      ["--base", "main", "--timeout", "soon", ...CHECK_COMMAND],
      ["--base", "main", "--remote", ...CHECK_COMMAND],
      ["--base", "main", "--setup", ...CHECK_COMMAND],
      ["--base", "main", "--shard", "1", ...CHECK_COMMAND],
      ["--base", "main", "--", process.execPath, CHECK],
      ["--base", "main", "--expect", " ", "--", process.execPath, CHECK],
    ]) {
      const r = run(args);
      expectSpawnExit(r, 2, args.join(" "));
      expect(r.stderr).toContain("usage:");
    }
  });
});

/**
 * A suite that prints both cases' names, as a runner's summary does, and
 * writes the JUnit report: the case the failure names passes or fails on
 * the base, while another case fails beside it.
 */
const suite = (target: "pass" | "fail") => {
  const failure = '<failure message="expected 1999 to be 2000"/>';
  const xml = `<testsuites><testsuite name="total"><testcase name="total rounds to cents">${target === "fail" ? failure : ""}</testcase><testcase name="rejects negative totals">${failure}</testcase></testsuite></testsuites>`;
  return `require("node:fs").writeFileSync("report.xml", ${JSON.stringify(xml)});\nconsole.log("${target.toUpperCase()} total rounds to cents\\nFAIL rejects negative totals");\nprocess.exitCode = 1;\n`;
};
const TARGET = "total rounds to cents";

describe("probe-base with a JUnit report", () => {
  const probe = (expected = TARGET, report = "report.xml") =>
    run([
      "--base",
      "main",
      "--expect",
      expected,
      "--junit",
      report,
      "--",
      process.execPath,
      CHECK,
    ]);

  test("the named case passed on the base, another failed: the failure is the change's", () => {
    publish(suite("pass"), "another case fails on main");
    const r = probe();
    expectSpawnExit(r, 0);
    const v = verdict(r.stdout);
    expect(v.verdict).toBe("change");
    expect(v.evidence).toBe("junit");
    expect(v.command_exit).toBe(1);
  });

  test("output alone would call that same run pre-existing", () => {
    publish(suite("pass"), "another case fails on main");
    const r = run([
      "--base",
      "main",
      "--expect",
      TARGET,
      "--",
      process.execPath,
      CHECK,
    ]);
    expectSpawnExit(r, 1);
    expect(verdict(r.stdout).evidence).toBe("output");
  });

  test("the named case failed on the base: the failure is pre-existing", () => {
    publish(suite("fail"), "the case fails on main");
    const r = probe();
    expectSpawnExit(r, 1);
    const v = verdict(r.stdout);
    expect(v.verdict).toBe("pre-existing");
    expect(v.junit).toBe("report.xml");
  });

  test("no case by that name, cases with different results, or no report: no answer", () => {
    publish(suite("pass"), "another case fails on main");
    const none = probe("refunds the fee");
    expectSpawnExit(none, 2);
    expect(none.stderr).toContain("lists no test case whose name holds");
    const both = probe("t");
    expectSpawnExit(both, 2);
    expect(both.stderr).toContain("with different results (failed, passed)");
    const missing = probe(TARGET, "elsewhere.xml");
    expectSpawnExit(missing, 2);
    expect(missing.stderr).toContain("wrote no JUnit report at elsewhere.xml");
  });

  /** A check that fails before it writes any report. */
  const WRITES_NOTHING =
    'console.log("crashed before the suite ran");\nprocess.exitCode = 1;\n';
  const failingReport = `<testsuite name="s"><testcase name="${TARGET}"><failure/></testcase></testsuite>`;

  test("a report the base already holds is not read for a command that wrote none", () => {
    writeFileSync(join(seed, "report.xml"), failingReport);
    publish(WRITES_NOTHING, "a stale report is tracked");
    const r = probe();
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("wrote no JUnit report at report.xml");
  });

  test("a tracked link at the report path is removed as a link, and what it pointed at is left alone", () => {
    const outside = join(scratch, "outside.xml");
    writeFileSync(outside, failingReport);
    symlinkSync(outside, join(seed, "report.xml"));
    publish(WRITES_NOTHING, "a link is tracked at the report path");
    const r = probe();
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("wrote no JUnit report at report.xml");
    expect(readFileSync(outside, "utf8")).toBe(failingReport);
  });

  test("a report under a directory link that leads outside the worktree is no answer", () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "report.xml"), failingReport);
    symlinkSync(outside, join(seed, "out"));
    publish(WRITES_NOTHING, "a directory link is tracked");
    const r = probe(TARGET, "out/report.xml");
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain(
      "lies under a link that leads outside the worktree",
    );
    expect(readFileSync(join(outside, "report.xml"), "utf8")).toBe(
      failingReport,
    );
  });
});

/** What a call that refuses writes on its way out: it throws, and says why on stderr. */
function refusal(fn: () => unknown): string {
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(fn).toThrow();
    return errors.mock.calls.flat().join("\n");
  } finally {
    errors.mockRestore();
  }
}

describe("junitCases and junitVerdict", () => {
  const suiteOf = (cases: string) => `<testsuite name="s">${cases}</testsuite>`;

  test("a case quoted in captured output or a comment is not one", () => {
    const cases = junitCases(
      suiteOf(
        `<testcase name="a &amp; b"><system-out><![CDATA[<testcase name="x"><failure/></testcase>]]></system-out></testcase><!-- <testcase name="y"><failure/></testcase> --><testcase name='c'><skipped/></testcase>`,
      ),
    );
    expect(cases).toEqual([
      { name: "a & b", failed: false, skipped: false },
      { name: "c", failed: false, skipped: true },
    ]);
  });

  test("a comment opener inside CDATA does not join one case to the next", () => {
    const cases = junitCases(
      suiteOf(
        `<testcase name="t"><system-out><![CDATA[<!--]]></system-out><failure message="broken"/></testcase><!-- end --><testcase name="other"></testcase>`,
      ),
    );
    expect(junitVerdict(cases, "t", "r")).toBe("pre-existing");
  });

  test("a report that is not well-formed JUnit gives no answer", () => {
    expect(
      refusal(() => junitCases(`<testcase name="t"><error/></testcase>`, "r")),
    ).toContain("r could not be read: not a JUnit report");
    expect(
      refusal(() =>
        junitCases(suiteOf(`<testcase name="t"></testcase bogus="1">`), "r"),
      ),
    ).toContain("could not be read: not well-formed XML");
  });

  test("an <error> fails a case, and a case only skipped gives no answer", () => {
    expect(
      junitVerdict(
        junitCases(suiteOf(`<testcase name="t"><error/></testcase>`)),
        "t",
        "r",
      ),
    ).toBe("pre-existing");
    expect(
      refusal(() =>
        junitVerdict(
          junitCases(suiteOf(`<testcase name="t"><skipped/></testcase>`)),
          "t",
          "r",
        ),
      ),
    ).toContain("was skipped on the base");
  });

  test("an exact name is read before the cases that merely hold it", () => {
    const cases = junitCases(
      suiteOf(
        `<testcase name="saves"/><testcase name="saves invalid input"><failure/></testcase>`,
      ),
    );
    expect(junitVerdict(cases, "saves", "r")).toBe("change");
  });

  test("a skipped case beside a failed or a passed one gives no answer", () => {
    for (const sibling of ["<failure/>", ""]) {
      const cases = junitCases(
        suiteOf(
          `<testcase name="saves it"><skipped/></testcase><testcase name="saves invalid input">${sibling}</testcase>`,
        ),
      );
      expect(refusal(() => junitVerdict(cases, "saves", "r"))).toContain(
        "with different results",
      );
    }
  });
});

describe("parseArgs", () => {
  test("reads the base, the remote, the deadline and the command", () => {
    expect(
      parseArgs([
        "--base",
        "develop",
        "--remote",
        "upstream",
        "--timeout",
        "30",
        "--setup",
        "pip install -e .",
        "--expect",
        "test_total",
        "--",
        "pytest",
        "-x",
      ]),
    ).toEqual({
      base: "develop",
      expect: "test_total",
      junit: undefined,
      remote: "upstream",
      timeoutSeconds: 30,
      setup: "pip install -e .",
      command: ["pytest", "-x"],
    });
  });

  test("defaults the remote to origin and bounds the deadline", () => {
    const args = parseArgs([
      "--base",
      "main",
      "--expect",
      "TestTotal",
      "--",
      "go",
      "test",
      "./...",
    ]);
    expect(args.remote).toBe("origin");
    expect(args.setup).toBeUndefined();
    expect(args.timeoutSeconds).toBeGreaterThan(0);
  });

  test("a JUnit report is a path inside the worktree", () => {
    const args = ["--base", "main", "--expect", "t"];
    expect(
      parseArgs([...args, "--junit", "out/report.xml", "--", "x"]).junit,
    ).toBe("out/report.xml");
    for (const outside of ["/tmp/report.xml", "../report.xml", "a/../../r.xml"])
      expect(
        refusal(() => parseArgs([...args, "--junit", outside, "--", "x"])),
      ).toContain("inside the worktree");
  });

  test("an option that looks like a flag is not a value", () => {
    expect(() =>
      parseArgs(["--base", "--remote", "origin", "--expect", "y", "--", "x"]),
    ).toThrow();
  });
});
