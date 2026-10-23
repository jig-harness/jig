import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

linkTest("an untracked link inside a link's target is reported", () => {
  const dir = scratchRepo({ "real/check.ts": "" });
  dirs.push(dir);
  symlinkSync(join(dir, "real"), join(dir, "intermediate"));
  symlinkSync("intermediate", join(dir, "link"));
  git(dir, "add", "--", "link");
  git(dir, "commit", "-q", "-m", "link");
  expect(commandProblems("bun link/check.ts", dir)[0]?.message).toBe(
    "link/check.ts reaches intermediate, which is not tracked, so a fresh clone lacks it",
  );
});

linkTest("a link loop needs nothing tracked", () => {
  const dir = scratchRepo({});
  dirs.push(dir);
  symlinkSync("b", join(dir, "a"));
  symlinkSync("a", join(dir, "b"));
  expect(commandProblems("bun a/check.ts", dir)[0]?.message).toContain(
    "does not exist",
  );
});

// Windows collapses `link/..` by text, so the root-level check.ts runs.
test.skipIf(process.platform !== "win32")(
  "on Windows a command through link/.. is tracked by the collapsed name",
  () => {
    const dir = linked({ "real/check.ts": "", "check.ts": "" }, [
      "real/check.ts",
    ]);
    expect(commandProblems("bun link/../check.ts", dir)).toEqual([
      {
        severity: "warning",
        message: "link/../check.ts is not tracked, so a fresh clone lacks it",
      },
    ]);
  },
);

// Whether the scratch directory's file system ignores case, as macOS and
// Windows ones do by default; the case tests mean nothing elsewhere.
const ignoresCase = (() => {
  const dir = scratchRepo({ probe: "" });
  dirs.push(dir);
  return existsSync(join(dir, "PROBE"));
})();
const caseTest = test.skipIf(!ignoresCase);
const caseLinkTest = test.skipIf(
  !ignoresCase ||
    skipsOnWindows("file-system", "symbolic links need privileges on Windows"),
);

function committed(files: Record<string, string>): string {
  const dir = scratchRepo(files);
  dirs.push(dir);
  return dir;
}

// A case-insensitive file system runs scripts/check.ts for SCRIPTS/CHECK.ts.
caseTest(
  "a command spelled in another case is tracked by the entry it reaches",
  () => {
    const dir = committed({ "scripts/check.ts": "" });
    expect(commandProblems("bun SCRIPTS/CHECK.ts", dir)).toEqual([]);
  },
);

caseLinkTest(
  "a link spelled in another case is tracked by its own entry",
  () => {
    const dir = committed({ "scripts/.keep": "", "real/check.ts": "" });
    symlinkSync(join(dir, "real"), join(dir, "scripts", "link"));
    git(dir, "add", "--", "scripts/link");
    git(dir, "commit", "-q", "-m", "link");
    expect(commandProblems("bun Scripts/LINK/Check.ts", dir)).toEqual([]);
  },
);

/** A repository holding `tracked`, with `untracked` a hard link to it. */
function hardLinked(tracked: string, untracked: string): string {
  const dir = committed({ [tracked]: "" });
  linkSync(join(dir, tracked), join(dir, untracked));
  return dir;
}

// Hard links share a file's identity, never its name: SCRIPTS/CHECK.ts
// reaches the entry check.ts, whichever other name shares its file.
caseTest("an untracked hard link is not tracked by its other name", () => {
  const dir = hardLinked("scripts/aaa.ts", "scripts/check.ts");
  expect(commandProblems("bun scripts/CHECK.ts", dir)[0]?.message).toBe(
    "scripts/CHECK.ts reaches scripts/check.ts, which is not tracked, so a fresh clone lacks it",
  );
});

caseTest("a tracked entry is not hidden by an untracked hard link", () => {
  const dir = hardLinked("scripts/check.ts", "scripts/aaa.ts");
  expect(commandProblems("bun scripts/CHECK.ts", dir)).toEqual([]);
});

// NTFS keeps `é` and `e` + combining acute as two entries, and
// scripts/É.ts reaches only the composed one; macOS cannot hold both.
test.skipIf(process.platform !== "win32")(
  "a hard link spelled with another Unicode normalization is another entry on NTFS",
  () => {
    const dir = hardLinked("scripts/é.ts", "scripts/é.ts");
    expect(commandProblems("bun scripts/É.ts", dir)[0]?.message).toBe(
      "scripts/É.ts reaches scripts/é.ts, which is not tracked, so a fresh clone lacks it",
    );
  },
);
