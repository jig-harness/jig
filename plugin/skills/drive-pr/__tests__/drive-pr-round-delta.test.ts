/**
 * drive-pr suite: round-delta.ts. Shared fixtures live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  gitCleanEnv,
  REPO_ROOT,
  SCRIPTS,
  tmpRoot,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { addOrigin, prBaseGh } from "./round-plan-fixtures.ts";

useDrivePrSuite();

const NO_QUOTE_NAMES = skipsOnWindows(
  "file-system",
  "a double quote is not a legal file-name character on Windows, so the file cannot be created",
);

describe("round-delta.ts", () => {
  // The helpers under test run git. Inherited routing variables (GIT_DIR,
  // GIT_WORK_TREE, GIT_INDEX_FILE from a hook or a parent git process)
  // override `-C dir` and would point them at the real checkout, so each call
  // runs in a child process whose environment is scrubbed (`gitCleanEnv`)
  // rather than in this one.
  async function inChild(
    fn: "changedFilesSince" | "changedFilesSinceExcludingMerges",
    args: unknown[],
    extraEnv: Record<string, string> = {},
  ): Promise<string[] | null> {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const m = await import(process.env.RD_MODULE);
         const r = await m[process.env.RD_FN](...JSON.parse(process.env.RD_ARGS));
         process.stdout.write(JSON.stringify(r));`,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...gitCleanEnv(),
          ...extraEnv,
          RD_MODULE: join(SCRIPTS, "lib", "round-delta.ts"),
          RD_FN: fn,
          RD_ARGS: JSON.stringify(args),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ exitCode, stdout, stderr }, 0);
    return JSON.parse(stdout) as string[] | null;
  }

  // Git quotes a pathname containing a literal `"` or `\` regardless of
  // `core.quotePath` — that setting only
  // controls the SEPARATE non-ASCII-escaping behavior. A `\n`-split of
  // quoted `--name-only`/`ls-files` output would keep the surrounding quotes
  // (and backslash-escape any embedded `"`), which then never matches
  // `finish-round.ts`'s `touched.has(t.path)` comparison against GitHub's
  // own unescaped path — silently failing the untriaged-thread guard OPEN
  // for exactly the files whose names make this matter. `-z` NUL-delimits
  // every entry with no quoting at all, so this reproduces the reviewer's own
  // repro script directly against the real functions.
  it.skipIf(NO_QUOTE_NAMES)(
    "changedFilesSinceExcludingMerges resolves a filename containing a literal double-quote unescaped",
    async () => {
      const dir = mkdtempSync(join(tmpRoot, "round-delta-quote-"));
      const env = gitCleanEnv();
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "probe@example.invalid");
      git("config", "user.name", "drive-pr probe");
      git("config", "commit.gpgsign", "false");
      git("config", "core.autocrlf", "false");
      git("config", "core.hooksPath", "/dev/null");
      writeFileSync(join(dir, "seed.ts"), "seed\n");
      git("add", "-A");
      git("commit", "-qm", "seed", "--no-verify");
      const since = git("rev-parse", "HEAD").stdout.toString().trim();
      // `changedFilesSinceExcludingMerges` excludes everything reachable from
      // `origin/develop` — give it one, pointed at the same seed commit, so
      // the quoted-path commit below is the only thing "this round" touched.
      git("update-ref", "refs/remotes/origin/develop", since);
      const quotedName = 'a"b.ts';
      writeFileSync(join(dir, quotedName), "quoted\n");
      git("add", "-A");
      git("commit", "-qm", "quoted path", "--no-verify");

      addOrigin(dir);
      const result = await inChild(
        "changedFilesSinceExcludingMerges",
        [dir, "999", since, 30],
        { PATH: `${prBaseGh()}${delimiter}${process.env.PATH}` },
      );
      expect(result).not.toBeNull();
      expect(result).toContain(quotedName);
    },
  );

  it.skipIf(NO_QUOTE_NAMES)(
    "changedFilesSince resolves a filename containing a literal double-quote unescaped",
    async () => {
      const dir = mkdtempSync(join(tmpRoot, "round-delta-quote-diff-"));
      const env = gitCleanEnv();
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "probe@example.invalid");
      git("config", "user.name", "drive-pr probe");
      git("config", "commit.gpgsign", "false");
      git("config", "core.autocrlf", "false");
      git("config", "core.hooksPath", "/dev/null");
      writeFileSync(join(dir, "seed.ts"), "seed\n");
      git("add", "-A");
      git("commit", "-qm", "seed", "--no-verify");
      const since = git("rev-parse", "HEAD").stdout.toString().trim();
      const quotedName = 'a"b.ts';
      writeFileSync(join(dir, quotedName), "quoted\n");
      git("add", "-A");
      git("commit", "-qm", "quoted path", "--no-verify");

      const result = await inChild("changedFilesSince", [dir, since, 30]);
      expect(result).not.toBeNull();
      expect(result).toContain(quotedName);
    },
  );
});
