/**
 * drive-pr suite: round-delta.ts. Shared fixtures live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  changedFilesSince,
  changedFilesSinceExcludingMerges,
} from "../scripts/lib/round-delta.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { gitCleanEnv, tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";
import { addOrigin, prBaseGh } from "./round-plan-fixtures.ts";

useDrivePrSuite();

const NO_QUOTE_NAMES = skipsOnWindows(
  "file-system",
  "a double quote is not a legal file-name character on Windows, so the file cannot be created",
);

describe("round-delta.ts", () => {
  // The helpers under test run git in this process. Inherited routing
  // variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE from a hook or a parent
  // git process) override `-C dir` and would point them at the real checkout,
  // so each call runs with those variables dropped and the environment
  // restored afterwards.
  async function inScrubbedEnv<T>(
    extra: Record<string, string>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env))
        if (k.startsWith("GIT_") || k.startsWith("DRIVE_PR_"))
          delete process.env[k];
      Object.assign(process.env, extra);
      return await fn();
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
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
      const result = await inScrubbedEnv(
        { PATH: `${prBaseGh()}${delimiter}${process.env.PATH}` },
        () => changedFilesSinceExcludingMerges(dir, "999", since, 30),
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

      const result = await inScrubbedEnv({}, () =>
        changedFilesSince(dir, since, 30),
      );
      expect(result).not.toBeNull();
      expect(result).toContain(quotedName);
    },
  );
});
