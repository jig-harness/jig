import { afterAll, expect, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { commandProblems } from "../scripts/config-fit.ts";
import { git, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const linkTest = test.skipIf(
  skipsOnWindows("file-system", "Windows collapses .. before following a link"),
);

/** A repository whose `link` points at real/sub, holding `files`, `tracked` committed. */
function linked(files: Record<string, string>, tracked: string[]): string {
  const dir = scratchRepo({ "real/sub/.keep": "" });
  dirs.push(dir);
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(dir, path), content);
  symlinkSync(join(dir, "real", "sub"), join(dir, "link"));
  git(dir, "add", "--", "link", ...tracked);
  git(dir, "commit", "-q", "-m", "files");
  return dir;
}

// `bun link/../check.ts` runs real/check.ts: the shell follows link first.
linkTest("a command through a link is tracked by the file it reaches", () => {
  const dir = linked({ "real/check.ts": "" }, ["real/check.ts"]);
  expect(commandProblems("bun link/../check.ts", dir)).toEqual([]);
  expect(commandProblems("bun link/x.ts", dir)[0]?.message).toContain(
    "does not exist",
  );
});

linkTest(
  "a tracked file of the collapsed name does not hide the one reached",
  () => {
    const dir = linked({ "real/check.ts": "", "check.ts": "" }, ["check.ts"]);
    expect(commandProblems("bun link/../check.ts", dir)).toEqual([
      {
        severity: "warning",
        message:
          "link/../check.ts reaches real/check.ts, which is not tracked, so a fresh clone lacks it",
      },
    ]);
  },
);

linkTest("an untracked link a command passes through is reported", () => {
  const dir = scratchRepo({ "real/sub/check.ts": "" });
  dirs.push(dir);
  symlinkSync(join(dir, "real", "sub"), join(dir, "link"));
  expect(commandProblems("bun link/check.ts", dir)[0]?.message).toBe(
    "link/check.ts reaches link, which is not tracked, so a fresh clone lacks it",
  );
});
