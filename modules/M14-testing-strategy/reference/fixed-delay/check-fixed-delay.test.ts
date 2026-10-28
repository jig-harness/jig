import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  DEFAULT_PATTERNS,
  delayPattern,
  lineFindings,
} from "./check-fixed-delay.ts";

const gate = join(import.meta.dir, "check-fixed-delay.ts");
const fixtures = join(import.meta.dir, "fixtures");

/** Run the gate from the fixtures directory, outside GitHub Actions unless a test asks. */
function run(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    cwd: options.cwd ?? fixtures,
    env: { ...process.env, GITHUB_ACTIONS: "false", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const lines = (text: string) =>
  lineFindings("f.ts", text.split("\n"), DEFAULT_PATTERNS.map(delayPattern));

describe("files", () => {
  test("delays with a justified token beside them pass, and the scope is stated", () => {
    const r = run(["clean"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("2 text file(s), 3 line(s) with a fixed delay");
    expect(r.stdout).toContain("a delay written another way is not seen");
  });

  test("a delay without a token fails, with its file, line and fix", () => {
    const r = run(["bare/queue.test.ts"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "bare/queue.test.ts:6: [fixed-delay] fixed delay without a `fixed-delay: <reason>` token",
    );
    expect(r.stderr).toContain("fix: wait for the state with a polling helper");
  });

  test("a token without a reason does not excuse the delay", () => {
    const r = run(["no-reason"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "no-reason/queue.test.ts:6: [fixed-delay] `fixed-delay:` without a reason",
    );
    expect(r.stderr).toContain("1 finding(s)");
  });

  test("a token with no delay on its line or the line below fails", () => {
    const r = run(["stale"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "stale/queue.test.ts:7: [fixed-delay] `fixed-delay:` with no delay on its line or the line below excuses nothing",
    );
    expect(r.stderr).toContain("fix: delete the token");
  });

  test("a token two lines from its delay excuses nothing, and the delay is bare", () => {
    const r = run(["far"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("far/hang.test.ts:4: [fixed-delay] fixed delay");
    expect(r.stderr).toContain(
      "far/hang.test.ts:7: [fixed-delay] `fixed-delay:` with no delay",
    );
  });

  test("a glob reads from --root, and --exclude leaves files out", () => {
    expectSpawnExit(run(["**/*.test.ts"]), 1);
    const r = run(["**/*", "--exclude", "{bare,no-reason,stale,far,java}/**"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("2 text file(s)");
    expectSpawnExit(
      run(["clean/*"], { cwd: import.meta.dir }),
      2,
      "the glob is read from the working directory by default",
    );
    expectSpawnExit(
      run(["clean/*", "--root", "fixtures"], { cwd: import.meta.dir }),
      0,
    );
  });

  test("--exclude matches a file named by its absolute path relative to --root", () => {
    expectSpawnExit(
      run([join(fixtures, "bare", "queue.test.ts"), "--exclude", "bare/**"]),
      2,
      "the only file named is excluded",
    );
    expectSpawnExit(
      run(
        [
          join(fixtures, "bare", "queue.test.ts"),
          "--root",
          "fixtures",
          "--exclude",
          "bare/**",
        ],
        { cwd: import.meta.dir },
      ),
      2,
      "the only file named is excluded",
    );
  });

  test("--pattern replaces the delay texts", () => {
    const r = run(["java", "--pattern", "Thread.sleep("]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("java/OrdersTest.java:3:");
    expectSpawnExit(run(["bare", "--pattern", "Thread.sleep("]), 0);
    expectSpawnExit(
      run(["bare", "--pattern", "Thread.sleep(", "--pattern", "Bun.sleep("]),
      1,
    );
  });

  test("under GitHub Actions each finding is also an annotation", () => {
    const r = run(["stale"], { env: { GITHUB_ACTIONS: "true" } });
    expectSpawnExit(r, 1);
    expect(r.stdout).toContain(
      "::error file=stale/queue.test.ts,line=7,title=fixed-delay::",
    );
  });

  test("files are reported in code-unit order, whatever the machine's locale", () => {
    const root = mkdtempSync(join(tmpdir(), "fixed-delay-"));
    try {
      for (const name of ["a.ts", "Z.ts"])
        writeFileSync(join(root, name), "await Bun.sleep(5);\n");
      const r = run(["a.ts", "Z.ts"], { cwd: root });
      expectSpawnExit(r, 1);
      expect(r.stderr.indexOf("Z.ts:1:")).toBeGreaterThanOrEqual(0);
      expect(r.stderr.indexOf("Z.ts:1:")).toBeLessThan(
        r.stderr.indexOf("a.ts:1:"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("could not check", () => {
  test.each([
    ["no file named", []],
    ["an empty pattern", ["clean", "--pattern", ""]],
    ["an unknown option", ["clean", "--patterns", "sleep("]],
    ["a path that does not exist", ["missing/file.ts"]],
    ["a glob that matches no file", ["**/*.rb"]],
    ["every file excluded", ["clean", "--exclude", "**"]],
  ])("%s exits 2", (_name, args) => {
    expectSpawnExit(run(args), 2);
  });

  test("a directory holding only binary files exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "fixed-delay-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin", "tool"), new Uint8Array([0, 1, 2]));
      const r = run(["bin"], { cwd: root });
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain("no text file left to scan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lines", () => {
  test("a token on the line above or the same line covers the delay", () => {
    expect(
      lines("// fixed-delay: back-off\nawait Bun.sleep(10);").findings,
    ).toEqual([]);
    expect(lines("await sleep(10); // fixed-delay: back-off").findings).toEqual(
      [],
    );
  });

  test("a delay text after a name character is a look-alike, not a delay", () => {
    expect(lines("oversleep(1); mySetTimeout(f);").delays).toBe(0);
    expect(lines("await asyncio.sleep(1)").delays).toBe(1);
  });

  test("a block comment's closing marker is not a reason", () => {
    const { findings } = lines("/* fixed-delay: */ setTimeout(f, 1);");
    expect(findings.map((f) => f.problem)).toEqual([
      "`fixed-delay:` without a reason does not excuse the delay",
    ]);
    for (const closer of ["-->", "--!>"])
      expect(
        lines(`<!-- fixed-delay: ${closer} setTimeout(f, 1);`).findings,
      ).toHaveLength(1);
  });

  test("every token on a line needs a reason, not only the first", () => {
    const { findings } = lines(
      "await sleep(1); /* fixed-delay: back-off */ /* fixed-delay: */",
    );
    expect(findings.map((f) => f.problem)).toEqual([
      "`fixed-delay:` without a reason does not excuse the delay",
    ]);
    expect(
      lines("await sleep(1); /* fixed-delay: back-off */ // fixed-delay: cap")
        .findings,
    ).toEqual([]);
  });

  test("a token without a reason and without a delay is reported as stale", () => {
    const { findings } = lines("// fixed-delay:\nconst x = 1;");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain("excuses nothing");
  });

  test("a name ending in the token text is not a token", () => {
    const { findings } = lines(
      "const not-fixed-delay: = 1;\nawait Bun.sleep(1);",
    );
    expect(findings.map((f) => f.line)).toEqual([2]);
  });
});
