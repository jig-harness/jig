/**
 * evidence.ts: a run writes one record tied to the tree it ran against, with
 * counts from a fresh JUnit report, under a deadline, and prints a block that
 * names no argument. Each case builds a scratch repository and a scratch
 * store, and runs the script in a child whose configuration points the store
 * there through the environment layer, so no test touches the developer's
 * store, home or configuration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { ExitError } from "../cli.ts";
import { parseListArgs, parseRunArgs } from "../evidence.ts";
import { type EvidenceRecord, formatBlock } from "../evidence-record.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../guarded-git-spawn.ts";

const SCRIPT = join(import.meta.dir, "..", "evidence.ts");
const BUN = process.execPath;
const PROGRAM = basename(BUN).replace(/\.exe$/i, "");

let scratch: string;
let repo: string;
let store: string;

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !["JIG_CONSUMER_ROOT", "JIG_OVERLAY"].includes(key)
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
    JIG__VERIFY__STORE: store,
    RRC_DEADLINE_GRACE_MS: "50",
    ...extra,
  };
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, env: childEnv() });
  expectSpawnExit({ ...r, exitCode: r.status }, 0, `git ${args.join(" ")}`);
  return r.stdout.trim();
}

function evidence(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(BUN, [SCRIPT, ...args], {
    cwd: repo,
    env: childEnv(extra),
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** `run --json` of `command`, expecting `exit`; the record it wrote. */
function record(
  flags: string[],
  command: string[],
  exit: number,
  extra: Record<string, string> = {},
): EvidenceRecord & { dir: string } {
  const r = evidence(["run", "--json", ...flags, "--", ...command], extra);
  expectSpawnExit(r, exit, "evidence run");
  const parsed = JSON.parse(r.stdout) as EvidenceRecord;
  return {
    ...parsed,
    dir: join(store, parsed.repository, parsed.tree, parsed.command.hash),
  };
}

function listed(args: string[]): EvidenceRecord[] {
  const r = evidence(["list", "--json", ...args]);
  expectSpawnExit(r, 0, "evidence list");
  return JSON.parse(r.stdout) as EvidenceRecord[];
}

const js = (code: string) => [BUN, "-e", code];
const PASS = js("console.log('ok')");
const FAIL = js("console.log('broken'); process.exitCode = 1");

/** A command that writes `xml` as the JUnit report and exits `exit`. */
function writesReport(xml: string, exit = 0): string[] {
  return js(
    `require("node:fs").mkdirSync("reports", { recursive: true }); require("node:fs").writeFileSync("reports/junit.xml", ${JSON.stringify(xml)}); process.exitCode = ${exit};`,
  );
}

const REPORT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="cart">
    <testcase classname="cart" name="adds"/>
    <testcase classname="cart" name="totals"><failure message="off by one"/></testcase>
    <testcase classname="cart" name="later"><skipped/></testcase>
  </testsuite>
  <testsuite name="db">
    <testcase classname="db" name="connects"><skipped/></testcase>
  </testsuite>
  <testsuite name="api">
    <testcase classname="api.v1" name="get"/>
    <testcase classname="api.v2" name="get"/>
  </testsuite>
</testsuites>
`;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "evidence-"));
  repo = join(scratch, "shop");
  store = join(scratch, "store");
  mkdirSync(repo);
  writeFileSync(join(scratch, "gitconfig"), "");
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), "reports/\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const POSIX = process.platform !== "win32";

describe("the tree identity", () => {
  test("covers untracked and changed files, leaves ignored ones out, and never touches the index", () => {
    const index = readFileSync(join(repo, ".git", "index"));
    const clean = record([], PASS, 0);
    expect(clean.tree).toBe(git("rev-parse", "HEAD^{tree}"));
    expect(clean.treeChanged).toBe(false);
    expect(clean.scope).toContain("does not ignore");

    writeFileSync(join(repo, "new.txt"), "new\n");
    const untracked = record([], PASS, 0);
    expect(untracked.tree).not.toBe(clean.tree);

    mkdirSync(join(repo, "reports"));
    writeFileSync(join(repo, "reports", "cache"), "ignored\n");
    expect(record([], PASS, 0).tree).toBe(untracked.tree);

    writeFileSync(join(repo, "a.txt"), "edited\n");
    expect(record([], PASS, 0).tree).not.toBe(untracked.tree);

    expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
    expect(git("status", "--porcelain")).toBe("M a.txt\n?? new.txt".trim());
  });

  test("a tree changed during the run is recorded and never returned as proof", () => {
    const changed = record(
      [],
      js("require('node:fs').writeFileSync('made.txt', 'x')"),
      1,
    );
    expect(changed.outcome).toBe("pass");
    expect(changed.treeChanged).toBe(true);
    expect(changed.treeAfter).not.toBe(changed.tree);
    expect(listed(["--tree", changed.tree])).toEqual([]);
    const all = listed(["--tree", changed.tree, "--all"]);
    expect(all.map((r) => [r.id, r.treeChanged])).toEqual([[changed.id, true]]);
    const block = evidence(["list", "--tree", changed.tree, "--all"]).stdout;
    expect(block).toContain("tree-changed");
  });
});

describe("records", () => {
  test("every run writes its own record, and lookup reads the newest", () => {
    const command = js(
      "process.exitCode = require('node:fs').existsSync('reports/fail') ? 1 : 0",
    );
    mkdirSync(join(repo, "reports"));
    writeFileSync(join(repo, "reports", "fail"), "");
    const failing = record([], command, 1);
    const firstText = readFileSync(join(failing.dir, `${failing.id}.json`));
    writeFileSync(join(repo, "reports", "fail"), "");
    const passing = record([], js("0"), 0);
    expect(passing.command.hash).not.toBe(failing.command.hash);

    const files = () =>
      readdirSync(failing.dir).filter((f) => f.endsWith(".json"));
    // The same command again, now passing: a second file beside the first.
    rmSync(join(repo, "reports", "fail"));
    const again = record([], command, 0);
    expect(again.dir).toBe(failing.dir);
    expect(files().sort()).toEqual(
      [`${failing.id}.json`, `${again.id}.json`].sort(),
    );
    expect(
      readFileSync(join(failing.dir, `${failing.id}.json`)).equals(firstText),
    ).toBe(true);
    expect(existsSync(join(failing.dir, `${failing.id}.log`))).toBe(true);

    const newest = listed(["--command", failing.command.hash]);
    expect(newest.map((r) => [r.id, r.outcome])).toEqual([[again.id, "pass"]]);
    const every = listed(["--command", failing.command.hash, "--all"]);
    expect(every.map((r) => r.id)).toEqual([again.id, failing.id]);
    // Without --tree, lookup reads the tree as it is now; a prefix works too.
    expect(
      listed([])
        .map((r) => r.id)
        .sort(),
    ).toEqual([again.id, passing.id].sort());
    expect(listed(["--tree", again.tree.slice(0, 7), "--all"]).length).toBe(3);
  });

  test("keeps the first and last lines of the output, and all of it in the file beside", () => {
    const ten = js("for (let i = 1; i <= 10; i++) console.log('line ' + i)");
    const r = record([], ten, 0, { JIG__VERIFY__OUTPUT_LINES: "3" });
    expect(r.output.lines).toBe(10);
    expect(r.output.head).toEqual(["line 1", "line 2", "line 3"]);
    expect(r.output.tail).toEqual(["line 8", "line 9", "line 10"]);
    const log = readFileSync(join(r.dir, r.output.file), "utf8");
    for (let i = 1; i <= 10; i++) expect(log).toContain(`line ${i}\n`);
    const stderr = record([], js("console.error('only on stderr')"), 0);
    expect(stderr.output.head).toEqual(["only on stderr"]);
  });

  test("refuses a verify section it cannot read, naming the field and its source", () => {
    const zero = evidence(["run", "--", ...PASS], {
      JIG__VERIFY__OUTPUT_LINES: "0",
    });
    expectSpawnExit(zero, 2);
    expect(zero.stderr).toContain("verify.output_lines must be a whole number");
    expect(zero.stderr).toContain("JIG__VERIFY__OUTPUT_LINES");
    const unknown = evidence(["run", "--", ...PASS], {
      JIG__VERIFY__TIMEOUT: "5",
    });
    expectSpawnExit(unknown, 2);
    expect(unknown.stderr).toContain("verify.timeout is not a field");
    const long = evidence(["run", "--", ...PASS], {
      JIG__VERIFY__TIMEOUT_MINUTES: "35792",
    });
    expectSpawnExit(long, 2);
    expect(long.stderr).toContain(
      "verify.timeout_minutes must be a whole number ≥ 1 and ≤ 35791",
    );
    expect(existsSync(store)).toBe(false);
  });
});

describe("counts from the report", () => {
  test("come per suite from a report this run wrote", () => {
    const r = record(
      ["--junit", "reports/junit.xml"],
      writesReport(REPORT, 1),
      1,
    );
    expect(r.outcome).toBe("fail");
    const junit = r.junit;
    expect(junit?.status).toBe("read");
    expect(junit?.path).toBe("reports/junit.xml");
    expect([junit?.executed, junit?.skipped]).toEqual([4, 2]);
    expect(
      junit?.suites?.map((s) => [s.name, s.run, s.skipped, s.tripwire]),
    ).toEqual([
      ["cart", 2, 1, false],
      ["db", 0, 1, true],
      ["api", 2, 0, false],
    ]);
    expect(junit?.tripwire).toBe(true);
    expect(junit?.failed).toEqual([{ classname: "cart", name: "totals" }]);
    expect(
      junit?.cases?.filter((c) => c.name === "get").map((c) => c.classname),
    ).toEqual(["api.v1", "api.v2"]);
    expect(junit?.cases?.find((c) => c.name === "later")?.result).toBe(
      "skipped",
    );
  });

  test("a suite that ran nothing keeps an otherwise passing run from vouching", () => {
    const ran = evidence([
      "run",
      "--junit",
      "reports/junit.xml",
      "--",
      ...writesReport(REPORT.replace(/<failure[^/]*\/>/, "")),
    ]);
    expectSpawnExit(ran, 1);
    expect(ran.stdout).toContain(
      "4 cases ran, 2 skipped (junit: reports/junit.xml)  ·  ran zero cases: 1 suite",
    );
    const clean = record(
      ["--junit", "reports/junit.xml"],
      writesReport(
        '<testsuite name="cart"><testcase classname="cart" name="adds"/></testsuite>',
      ),
      0,
    );
    expect(clean.junit?.tripwire).toBe(false);
  });

  test("a report left by an earlier run is moved aside and never read", () => {
    mkdirSync(join(repo, "reports"));
    writeFileSync(join(repo, "reports", "junit.xml"), REPORT);
    const r = record(["--junit", "reports/junit.xml"], PASS, 1);
    expect(r.outcome).toBe("pass");
    expect(r.junit?.status).toBe("no report");
    expect(existsSync(join(repo, "reports", "junit.xml"))).toBe(false);
    expect(r.junit?.movedAside).toBe(join(r.dir, `${r.id}.previous-report`));
    expect(readFileSync(r.junit?.movedAside ?? "", "utf8")).toBe(REPORT);
  });

  test("a report written before the run began is refused as stale", () => {
    const backdated = js(
      `const fs = require("node:fs"); fs.mkdirSync("reports"); fs.writeFileSync("reports/junit.xml", ${JSON.stringify(REPORT)}); fs.utimesSync("reports/junit.xml", new Date(2001, 0, 1), new Date(2001, 0, 1));`,
    );
    const r = record(["--junit", "reports/junit.xml"], backdated, 1);
    expect(r.junit?.status).toBe("stale");
    expect(r.junit?.executed).toBeUndefined();
  });
});

describe("the deadline", () => {
  test("a run past it is recorded as timed out, and its whole process tree ends", async () => {
    const hangs = js(
      `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); fs.mkdirSync("reports"); fs.writeFileSync("reports/pid", String(c.pid)); setInterval(() => {}, 1000);`,
    );
    const r = record(["--timeout", "0.02"], hangs, 1);
    expect(r.outcome).toBe("timed-out");
    expect(r.exit).toBeNull();
    expect(r.timeoutMinutes).toBe(0.02);
    const pid = Number(readFileSync(join(repo, "reports", "pid"), "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 10_000;
    while (alive() && Date.now() < deadline) await Bun.sleep(50);
    expect(alive()).toBe(false);
  }, 30_000);

  test("the block says timed out, never exit or pass", () => {
    const ran = evidence([
      "run",
      "--timeout",
      "0.01",
      "--",
      ...js("setInterval(() => {}, 1000)"),
    ]);
    expectSpawnExit(ran, 1);
    expect(ran.stdout.split("\n")[1]).toStartWith("timed out at 0.01m");
  }, 30_000);
});

describe("--expect-fail", () => {
  test("records a seen-to-fail when the command fails, and a failed expectation when it passes", () => {
    const red = record(["--expect-fail"], FAIL, 0);
    expect(red.outcome).toBe("seen-to-fail");
    expect(red.expectFail?.met).toBe(true);
    const green = record(["--expect-fail"], PASS, 1);
    expect(green.outcome).toBe("expectation-failed");
    expect(green.expectFail?.reason).toBe("the command passed");
  });

  test("names the failing case from this run's report", () => {
    const flags = ["--junit", "reports/junit.xml", "--expect-fail"];
    const named = record([...flags, "totals"], writesReport(REPORT, 1), 0);
    expect(named.outcome).toBe("seen-to-fail");
    expect(named.expectFail?.failedCases).toEqual(["cart::totals"]);
    const block = evidence([
      "run",
      ...flags,
      "cart::totals",
      "--",
      ...writesReport(REPORT, 1),
    ]);
    expect(block.stdout).toContain("(seen to fail: 1 case)");
    expect(block.stdout).not.toContain("totals");
    const passed = record([...flags, "adds"], writesReport(REPORT, 1), 1);
    expect(passed.outcome).toBe("expectation-failed");
    expect(passed.expectFail?.reason).toBe("case adds did not fail");
  });

  test("a named case needs the report", () => {
    const r = evidence(["run", "--expect-fail", "totals", "--", ...FAIL]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("--junit <path> is required");
  });
});

describe("the printed block", () => {
  test("names the program and the command hash, never the arguments or the output", () => {
    writeFileSync(
      join(repo, "check.ts"),
      "console.log(process.argv.slice(2).join(' '));\n",
    );
    const secret = "--password=hunter2-s3cret";
    const ran = evidence(["run", "--", BUN, "check.ts", secret]);
    expectSpawnExit(ran, 0);
    const lines = ran.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(ran.stdout).not.toContain("hunter2");
    expect(lines[0]).toMatch(
      new RegExp(`^EVIDENCE {2}tree [0-9a-f]{7} {2}${PROGRAM} [0-9a-f]{12}$`),
    );
    expect(lines[1]).toMatch(/^exit 0 {2}· {2}[0-9.]+s$/);
    // A store under the home folder is shown from `~`, as Windows' temporary folder is.
    const shown = (lines[2] ?? "").slice("record ".length);
    const path = shown.startsWith("~") ? homedir() + shown.slice(1) : shown;
    expect(path).toStartWith(store);
    const kept = JSON.parse(readFileSync(path, "utf8")) as EvidenceRecord;
    expect(kept.command.argv).toEqual([BUN, "check.ts", secret]);
    expect(
      readFileSync(join(dirname(path), kept.output.file), "utf8"),
    ).toContain("hunter2");

    const named = evidence(["run", "--name", "gates", "--", ...PASS]);
    expect(named.stdout.split("\n")[0]).toEndWith("  gates");
  });
});

describe("what vouches", () => {
  test("lookup passes over a newer run that does not vouch to the newest that does", () => {
    const command = js(
      "process.exitCode = require('node:fs').existsSync('reports/fail') ? 1 : 0",
    );
    const passing = record([], command, 0);
    mkdirSync(join(repo, "reports"));
    writeFileSync(join(repo, "reports", "fail"), "");
    const failing = record([], command, 1);
    expect(failing.dir).toBe(passing.dir);
    expect(
      listed(["--command", passing.command.hash]).map((r) => r.id),
    ).toEqual([passing.id]);
  });

  test("a pass whose report failed a case does not vouch", () => {
    const r = record(
      ["--junit", "reports/junit.xml"],
      writesReport(
        '<testsuite name="cart"><testcase classname="cart" name="adds"><failure/></testcase></testsuite>',
      ),
      1,
    );
    expect(r.outcome).toBe("pass");
    expect(r.junit?.failed).toEqual([{ classname: "cart", name: "adds" }]);
    expect(listed(["--command", r.command.hash])).toEqual([]);
  });

  test.if(POSIX)("a command ended by a signal is never seen to fail", () => {
    const r = record(
      ["--expect-fail"],
      js("process.kill(process.pid, 'SIGTERM')"),
      1,
    );
    expect(r.outcome).toBe("expectation-failed");
    expect(r.exit).toBeNull();
    expect(r.signal).toBe("SIGTERM");
  });

  test("a run that leaves no tree to identify is recorded, vouching for none", () => {
    const r = record(
      [],
      js("require('node:fs').rmSync('.git', { recursive: true, force: true })"),
      1,
      { GIT_CEILING_DIRECTORIES: scratch },
    );
    expect(r.treeAfter).toBeNull();
    expect(r.treeChanged).toBe(true);
    expect(existsSync(join(r.dir, `${r.id}.json`))).toBe(true);
  });
});

describe("the store", () => {
  test("is namespaced by the clone, not by its folder name alone", () => {
    const r = record([], PASS, 0);
    const common = realpathSync(join(repo, ".git"));
    const id = createHash("sha256").update(common).digest("hex").slice(0, 8);
    expect(r.repository).toBe(`shop-${id}`);
  });

  test.if(POSIX)("keeps what it writes readable by its owner alone", () => {
    mkdirSync(join(repo, "reports"));
    writeFileSync(join(repo, "reports", "junit.xml"), REPORT);
    const r = record(["--junit", "reports/junit.xml"], PASS, 1);
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(r.dir)).toBe(0o700);
    for (const file of [
      `${r.id}.json`,
      `${r.id}.log`,
      `${r.id}.previous-report`,
    ])
      expect([file, mode(join(r.dir, file))]).toEqual([file, 0o600]);
  });

  test("refuses a record missing a field it reads, naming the file", () => {
    const r = record([], PASS, 0);
    const { tree: _tree, ...broken } = JSON.parse(
      readFileSync(join(r.dir, `${r.id}.json`), "utf8"),
    ) as EvidenceRecord;
    writeFileSync(join(r.dir, "broken.json"), JSON.stringify(broken));
    const listing = evidence(["list", "--all"]);
    expectSpawnExit(listing, 2);
    expect(listing.stderr).toContain("broken.json");
  });

  test("a report path another live run holds is refused; a dead holder's is taken over", () => {
    const first = record([], PASS, 0);
    const locks = join(store, first.repository, "report-locks");
    const lock = join(
      locks,
      createHash("sha256")
        .update(join(realpathSync(repo), "reports", "junit.xml"))
        .digest("hex")
        .slice(0, 12),
    );
    mkdirSync(locks, { recursive: true });
    writeFileSync(lock, String(process.pid));
    const flags = ["run", "--junit", "reports/junit.xml", "--", ...PASS];
    const held = evidence(flags);
    expectSpawnExit(held, 2);
    expect(held.stderr).toContain(`another run (pid ${process.pid})`);
    expect(existsSync(lock)).toBe(true);

    const gone = Bun.spawnSync([BUN, "-e", "0"]);
    writeFileSync(lock, String(gone.pid));
    expectSpawnExit(evidence(flags), 1);
    expect(existsSync(lock)).toBe(false);
  });

  test("a dead holder's lock another run is taking over is left to that run", () => {
    const first = record([], PASS, 0);
    const lock = reportLock(first.repository, "reports");
    const gone = Bun.spawnSync([BUN, "-e", "0"]);
    writeFileSync(lock, String(gone.pid));
    writeFileSync(`${lock}.reclaim`, String(process.pid));
    const r = evidence(["run", "--junit", "reports/junit.xml", "--", ...PASS]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("taking over the report lock");
    expect(readFileSync(lock, "utf8")).toBe(String(gone.pid));
  });

  test.if(POSIX)(
    "a report path through a linked folder shares the folder's lock",
    () => {
      const first = record([], PASS, 0);
      mkdirSync(join(repo, "reports"));
      symlinkSync(join(repo, "reports"), join(repo, "reports-alias"));
      writeFileSync(
        reportLock(first.repository, "reports"),
        String(process.pid),
      );
      const r = evidence([
        "run",
        "--junit",
        "reports-alias/junit.xml",
        "--",
        ...PASS,
      ]);
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain(`another run (pid ${process.pid})`);
    },
  );

  test.if(POSIX)(
    "a report path that is a link is refused before anything moves",
    () => {
      const outside = join(scratch, "outside.xml");
      writeFileSync(outside, REPORT, { mode: 0o644 });
      mkdirSync(join(repo, "reports"));
      symlinkSync(outside, join(repo, "reports", "junit.xml"));
      const r = evidence([
        "run",
        "--junit",
        "reports/junit.xml",
        "--",
        ...PASS,
      ]);
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain("is a symbolic link");
      expect(
        lstatSync(join(repo, "reports", "junit.xml")).isSymbolicLink(),
      ).toBe(true);
      expect(statSync(outside).mode & 0o777).toBe(0o644);
    },
  );

  test.if(POSIX)(
    "a report the command leaves as a link is recorded unreadable",
    () => {
      const outside = join(scratch, "outside.xml");
      const r = record(
        ["--junit", "reports/junit.xml"],
        js(
          `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(outside)}, ${JSON.stringify(REPORT.replace(/<failure[^>]*\/>/, ""))}); fs.mkdirSync("reports", { recursive: true }); fs.symlinkSync(${JSON.stringify(outside)}, "reports/junit.xml");`,
        ),
        1,
      );
      expect(r.junit?.status).toBe("unreadable");
      expect(r.junit?.problem).toContain("symbolic link");
      expect(listed([])).toEqual([]);
    },
  );

  test("a case both failed and skipped reads back as one failed case", () => {
    const both = `<testsuites><testsuite name="s">
  <testcase classname="s" name="ok"/>
  <testcase classname="s" name="x"><failure/><skipped/></testcase>
</testsuite></testsuites>`;
    const r = record(["--junit", "reports/junit.xml"], writesReport(both), 1);
    expect(r.junit).toMatchObject({
      status: "read",
      executed: 2,
      skipped: 0,
      failed: [{ classname: "s", name: "x" }],
    });
    const all = evidence(["list", "--all", "--json"]);
    expectSpawnExit(all, 0, "evidence list --all");
    expect(
      (JSON.parse(all.stdout) as EvidenceRecord[]).map((x) => x.id),
    ).toEqual([r.id]);
  });

  test("refuses a read report missing the counts vouching reads", () => {
    const r = record([], PASS, 0);
    const forged = {
      ...(JSON.parse(
        readFileSync(join(r.dir, `${r.id}.json`), "utf8"),
      ) as EvidenceRecord),
      id: "forged",
      junit: { path: "r.xml", status: "read", suites: [{ tripwire: true }] },
    };
    writeFileSync(join(r.dir, "forged.json"), JSON.stringify(forged));
    const listing = evidence(["list"]);
    expectSpawnExit(listing, 2);
    expect(listing.stderr).toContain("forged.json");
  });
});

/** The lock file of the report `<folder>/junit.xml` in the repository. */
function reportLock(repository: string, folder: string): string {
  const locks = join(store, repository, "report-locks");
  mkdirSync(locks, { recursive: true });
  return join(
    locks,
    createHash("sha256")
      .update(join(realpathSync(repo), folder, "junit.xml"))
      .digest("hex")
      .slice(0, 12),
  );
}

describe("a report that cannot be read safely", () => {
  test.if(POSIX)(
    "a named pipe is refused, never read",
    () => {
      const r = record(
        ["--junit", "reports/junit.xml"],
        js(
          "require('node:fs').mkdirSync('reports'); require('node:child_process').execFileSync('mkfifo', ['reports/junit.xml'])",
        ),
        1,
      );
      expect([r.junit?.status, r.junit?.problem]).toEqual([
        "unreadable",
        "not a regular file",
      ]);
    },
    30_000,
  );

  test("one the parser cannot get through is recorded unreadable, the run still recorded", () => {
    const r = record(
      ["--junit", "reports/junit.xml"],
      js(
        "const fs = require('node:fs'); fs.mkdirSync('reports'); const n = 200000; fs.writeFileSync('reports/junit.xml', '<testsuite>'.repeat(n) + '</testsuite>'.repeat(n));",
      ),
      1,
    );
    expect(r.junit?.status).toBe("unreadable");
    expect(existsSync(join(r.dir, `${r.id}.json`))).toBe(true);
  });

  test("one larger than the bound is refused, never parsed", () => {
    const r = record(
      ["--junit", "reports/junit.xml"],
      js(
        "const fs = require('node:fs'); fs.mkdirSync('reports'); fs.writeFileSync('reports/junit.xml', '<testsuite/>'); fs.truncateSync('reports/junit.xml', 65 * 1024 * 1024);",
      ),
      1,
    );
    expect(r.junit?.status).toBe("unreadable");
    expect(r.junit?.problem).toContain("bytes, more than");
  });
});

describe("the printed block keeps the report's names local", () => {
  test("names no suite, case or parser diagnostic", () => {
    const secret = "ops-token-9f8e7d";
    const tripped = evidence([
      "run",
      "--junit",
      "reports/junit.xml",
      "--expect-fail",
      secret,
      "--",
      ...writesReport(
        `<testsuites><testsuite name="${secret}"><testcase classname="${secret}" name="${secret}"><skipped/></testcase></testsuite></testsuites>`,
        1,
      ),
    ]);
    expectSpawnExit(tripped, 1);
    expect(tripped.stdout).toContain("ran zero cases: 1 suite");
    expect(tripped.stdout).toContain("(expected to fail: not met");
    const broken = evidence([
      "run",
      "--junit",
      "reports/junit.xml",
      "--",
      ...writesReport(`<testsuite name="${secret}"`),
    ]);
    expectSpawnExit(broken, 1);
    expect(broken.stdout).toContain("unreadable (junit: reports/junit.xml)");
    for (const out of [tripped.stdout, broken.stdout])
      expect(out).not.toContain(secret);
  });

  test("never shows sixty seconds", () => {
    const r = record([], PASS, 0);
    for (const [ms, shown] of [
      [9_960, "10s"],
      [59_600, "1m00s"],
      [119_600, "2m00s"],
      [3_599_600, "1h00m"],
    ] as const)
      expect([
        ms,
        formatBlock({ ...r, durationMs: ms }, "x").split("\n")[1],
      ]).toEqual([ms, `exit 0  ·  ${shown}`]);
  });
});

describe("the command line", () => {
  /** The exit code a usage error throws, or null when it parses. */
  const refused = (parse: () => unknown): number | null => {
    try {
      parse();
      return null;
    } catch (error) {
      if (error instanceof ExitError) return error.code;
      throw error;
    }
  };

  test("run takes its flags before -- and the command after it", () => {
    expect(
      parseRunArgs([
        "--timeout",
        "0.5",
        "--expect-fail",
        "--json",
        "--",
        "bun",
        "--expect-fail",
      ]),
    ).toEqual({
      timeoutMinutes: 0.5,
      junit: undefined,
      name: undefined,
      expectFail: { case: null },
      json: true,
      command: ["bun", "--expect-fail"],
    });
    expect(
      parseRunArgs(["--expect-fail", "a::b", "--junit", "r.xml", "--", "x"])
        .expectFail,
    ).toEqual({ case: "a::b" });
  });

  test("run refuses what it cannot use", () => {
    for (const argv of [
      ["--", "x"].slice(0, 1),
      ["--timeout", "0", "--", "x"],
      ["--timeout", "-1", "--", "x"],
      ["--timeout", "--", "x"],
      ["--junit"],
      ["--shell", "--", "x"],
      ["toString", "--", "x"],
    ])
      expect([argv, refused(() => parseRunArgs(argv))]).toEqual([argv, 2]);
  });

  test("list takes a tree and a command hash or their prefixes", () => {
    expect(parseListArgs(["--tree", "3f9c", "--all"])).toEqual({
      tree: "3f9c",
      command: undefined,
      all: true,
      json: false,
    });
    for (const argv of [
      ["--tree", "3f9"],
      ["--command", "XYZW"],
      ["--", "x"],
    ])
      expect([argv, refused(() => parseListArgs(argv))]).toEqual([argv, 2]);
  });
});
