// Each case builds a throwaway git repository in a temporary directory and
// runs the gate in it.
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanced,
  judge,
  rangeSides,
  readRawDiff,
} from "../scripts/stale-last-updated/stale-last-updated";

const scratch = mkdtempSync(join(tmpdir(), "jig-stale-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A git hook exports GIT_DIR and friends pointing at the real repository; a
// scratch repository's git calls must not inherit them.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
Object.assign(env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

const TODAY = "2099-01-01";
const doc = (date: string, body = "First body line.\n", extra = "") =>
  `---\ntitle: Guide\n${extra}last_updated: ${date}\n---\n\n# Guide\n\n${body}`;

let counter = 0;
function repo(initial: string) {
  const dir = join(scratch, `repo-${counter++}`);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0 && args[0] !== "merge")
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", "main");
  const write = (text: string | Uint8Array, name = "guide.md") =>
    writeFileSync(join(dir, name), text);
  write(initial);
  git("add", ".");
  git("commit", "-qm", "initial");
  const run = (
    args: string[],
    extra: Record<string, string> = {},
    cwd = dir,
  ) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(
          import.meta.dir,
          "../scripts/stale-last-updated/stale-last-updated.ts",
        ),
        ...args,
      ],
      {
        cwd,
        env: { ...env, LAST_UPDATED_TODAY: TODAY, ...extra },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: result.exitCode,
      out: result.stdout.toString() + result.stderr.toString(),
    };
  };
  return { dir, git, write, run };
}

/** Commit a change on a branch and run the gate over main...HEAD. */
function rangeCase(before: string, after: string) {
  const r = repo(before);
  r.git("checkout", "-qb", "work");
  r.write(after);
  r.git("commit", "-qam", "change");
  return r.run(["guide.md"], { DIFF_RANGE: "main...HEAD" });
}

describe("range mode", () => {
  test("a body edit without a bump fails", () => {
    const result = rangeCase(
      doc("2026-01-01"),
      doc("2026-01-01", "Changed body line.\n"),
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "guide.md: the body changed but last_updated was not advanced (still '2026-01-01'",
    );
  });

  test("a body edit with a bump passes", () => {
    const result = rangeCase(
      doc("2026-01-01"),
      doc("2026-02-01", "Changed body line.\n"),
    );
    expect(result.out).toContain("OK —");
    expect(result.code).toBe(0);
  });

  test("a body deletion without a bump fails", () => {
    const result = rangeCase(
      doc("2026-01-01", "Line one.\nLine two.\n"),
      doc("2026-01-01", "Line one.\n"),
    );
    expect(result.code).toBe(1);
  });

  test("a frontmatter-only edit passes", () => {
    const result = rangeCase(
      doc("2026-01-01"),
      doc("2026-01-01", "First body line.\n", "owner: docs\n"),
    );
    expect(result.code).toBe(0);
  });

  test("re-touching the date with the same or an older value fails", () => {
    const body = "Changed body line.\n";
    const same = rangeCase(
      doc("2026-01-01"),
      doc("2026-01-01", body).replace("2026-01-01", "'2026-01-01'"),
    );
    expect(same.code).toBe(1);
    const older = rangeCase(doc("2026-01-01"), doc("2025-12-31", body));
    expect(older.code).toBe(1);
  });

  test("a body line starting last_updated: is not a bump", () => {
    const result = rangeCase(
      doc("2026-01-01"),
      doc("2026-01-01", "last_updated: 2099-01-01\n"),
    );
    expect(result.code).toBe(1);
  });

  test("a comment added to the date is not a bump", () => {
    const result = rangeCase(
      doc("2026-01-01"),
      doc("2026-01-01 # refreshed", "Changed body line.\n"),
    );
    expect(result.code).toBe(1);
  });

  test("a date already equal to today passes without a bump", () => {
    const result = rangeCase(doc(TODAY), doc(TODAY, "Changed body line.\n"));
    expect(result.code).toBe(0);
  });

  test("a new file is exempt", () => {
    const r = repo(doc("2026-01-01"));
    r.git("checkout", "-qb", "work");
    r.write(doc("2020-01-01"), "new.md");
    r.git("add", ".");
    r.git("commit", "-qm", "add");
    expect(r.run(["new.md"], { DIFF_RANGE: "main...HEAD" }).code).toBe(0);
  });

  test("triple-dot reads the old side at the merge base, two-dot at the left tip", () => {
    // main later changes the body; the branch changes only frontmatter. Against
    // the merge base the branch touched no body line; against main's tip the
    // body differs.
    const r = repo(doc("2026-01-01"));
    r.git("checkout", "-qb", "work");
    r.write(doc("2026-01-01", "First body line.\n", "owner: docs\n"));
    r.git("commit", "-qam", "frontmatter");
    r.git("checkout", "-q", "main");
    r.write(doc("2026-01-01", "Main body line.\n"));
    r.git("commit", "-qam", "body on main");
    r.git("checkout", "-q", "work");
    expect(r.run(["guide.md"], { DIFF_RANGE: "main...HEAD" }).code).toBe(0);
    expect(r.run(["guide.md"], { DIFF_RANGE: "main..HEAD" }).code).toBe(1);
  });

  test("with no files named, every modified Markdown file in the range is checked", () => {
    const r = repo(doc("2026-01-01"));
    r.git("checkout", "-qb", "work");
    r.write(doc("2026-01-01", "Changed body line.\n"));
    r.git("commit", "-qam", "change");
    const result = r.run([], { DIFF_RANGE: "main...HEAD" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("guide.md");
  });

  test("a date bump written with a space before the colon counts; a removed one does not", () => {
    const body = "Changed body line.\n";
    const spaced = rangeCase(
      doc("2026-01-01"),
      doc("2026-02-01", body).replace("last_updated:", "last_updated :"),
    );
    expect(spaced.code).toBe(0);
    const backwards = rangeCase(
      doc("2026-02-01").replace("last_updated:", "last_updated :"),
      doc("2026-01-01", body),
    );
    expect(backwards.code).toBe(1);
  });

  test("removing or unclosing the frontmatter of an existing document fails", () => {
    const removed = rangeCase(doc("2026-01-01"), "# Guide\n\nChanged.\n");
    expect(removed.code).toBe(1);
    expect(removed.out).toContain(
      "frontmatter was removed or no longer closes",
    );
    const unclosed = rangeCase(
      doc("2026-01-01"),
      doc("2026-01-01", "Changed.\n").replace(/\n---\n/, "\n"),
    );
    expect(unclosed.code).toBe(1);
  });

  test("a body edit git would call binary still fails without a bump", () => {
    const binary = (body: string) =>
      new Uint8Array([...Buffer.from(doc("2026-01-01", body)), 0, 10]);
    const r = repo("");
    r.write(binary("First body line.\n"));
    r.git("add", ".");
    r.git("commit", "-qm", "binary");
    r.git("checkout", "-qb", "work");
    r.write(binary("Changed body line.\n"));
    r.git("commit", "-qam", "change");
    expect(r.run(["guide.md"], { DIFF_RANGE: "main...HEAD" }).code).toBe(1);
  });

  test("an unknown range is an error, not a pass", () => {
    const r = repo(doc("2026-01-01"));
    expect(r.run(["guide.md"], { DIFF_RANGE: "nope...HEAD" }).code).toBe(2);
  });
});

describe("renames, names and paths", () => {
  test("a renamed document whose body changed must advance its date", () => {
    const r = repo(doc("2026-01-01", "One.\nTwo.\nThree.\nFour.\nFive.\n"));
    r.git("checkout", "-qb", "work");
    r.git("mv", "guide.md", "renamed.md");
    r.write(
      doc("2026-01-01", "One.\nTwo.\nThree.\nFour.\nChanged.\n"),
      "renamed.md",
    );
    r.git("commit", "-qam", "rename");
    const result = r.run([], { DIFF_RANGE: "main...HEAD" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("renamed.md: the body changed");
    expect(r.run(["renamed.md"], { DIFF_RANGE: "main...HEAD" }).code).toBe(1);
  });

  test("a renamed document with an advanced date passes", () => {
    const r = repo(doc("2026-01-01", "One.\nTwo.\nThree.\nFour.\nFive.\n"));
    r.git("checkout", "-qb", "work");
    r.git("mv", "guide.md", "renamed.md");
    r.write(
      doc("2026-02-01", "One.\nTwo.\nThree.\nFour.\nChanged.\n"),
      "renamed.md",
    );
    r.git("commit", "-qam", "rename");
    expect(r.run([], { DIFF_RANGE: "main...HEAD" }).code).toBe(0);
  });

  test("a non-ASCII file name is checked, not taken for a new file", () => {
    const r = repo(doc("2026-01-01"));
    r.write(doc("2026-01-01"), "café.md");
    r.git("add", ".");
    r.git("commit", "-qm", "accent");
    r.git("checkout", "-qb", "work");
    r.write(doc("2026-01-01", "Changed body line.\n"), "café.md");
    r.git("commit", "-qam", "change");
    const all = r.run([], { DIFF_RANGE: "main...HEAD" });
    expect(all.code).toBe(1);
    expect(all.out).toContain("café.md");
    expect(r.run(["café.md"], { DIFF_RANGE: "main...HEAD" }).code).toBe(1);
  });

  test("an absolute path argument names the same document", () => {
    const r = repo(doc("2026-01-01"));
    r.git("checkout", "-qb", "work");
    r.write(doc("2026-01-01", "Changed body line.\n"));
    r.git("commit", "-qam", "change");
    const result = r.run([join(r.dir, "guide.md")], {
      DIFF_RANGE: "main...HEAD",
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("guide.md: the body changed");
  });
});

describe("ranges and options", () => {
  test("a range with no left side is an error, with or without --ci", () => {
    // An unset base variable turns $BASE...HEAD into ...HEAD: a range was
    // given, so it must fail rather than skip.
    const r = repo(doc("2026-01-01"));
    for (const range of ["...HEAD", "..HEAD"])
      for (const args of [["guide.md"], ["--ci", "guide.md"]]) {
        const result = r.run(args, { DIFF_RANGE: range });
        expect(result.code).toBe(2);
        expect(result.out).toContain("has no left side");
      }
    expect(r.run(["--range="]).code).toBe(2);
    expect(r.run(["--ci", "--range="]).code).toBe(2);
  });

  test("a range with two separators, or a right side that does not resolve, is an error", () => {
    const r = repo(doc("2026-01-01"));
    r.git("checkout", "-qb", "work");
    r.write(doc("2026-01-01", "Changed body line.\n"));
    r.git("commit", "-qam", "change");
    const doubled = r.run(["guide.md"], { DIFF_RANGE: "main..HEAD..nope" });
    expect(doubled.code).toBe(2);
    expect(doubled.out).toContain("more than one '..'");
    for (const range of ["main..nope", "main...nope"])
      expect(r.run(["guide.md"], { DIFF_RANGE: range }).code).toBe(2);
  });

  test("a named file outside the repository is an error", () => {
    const r = repo(doc("2026-01-01"));
    const result = r.run([join(scratch, "elsewhere.md")], {
      DIFF_RANGE: "main...HEAD",
    });
    expect(result.code).toBe(2);
    expect(result.out).toContain("outside the repository");
  });

  test("--staged with a range is an error, and a malformed DIFF_RANGE fails staged mode too", () => {
    const r = repo(doc("2026-01-01"));
    for (const range of ["--range=main...HEAD", "--range=...HEAD", "--range="])
      expect(r.run(["--staged", range]).code).toBe(2);
    const malformed = r.run(["--staged"], { DIFF_RANGE: "...HEAD" });
    expect(malformed.code).toBe(2);
    expect(malformed.out).toContain("has no left side");
    const unresolved = r.run(["--staged"], { DIFF_RANGE: "nope...HEAD" });
    expect(unresolved.code).toBe(2);
    expect(unresolved.out).toContain("not a commit: nope");
  });

  test("a document replaced by a symlink fails rather than passing unchecked", () => {
    const r = repo(doc("2026-01-01"));
    r.write(doc("2026-01-01", "Other text.\n"), "other.md");
    r.git("add", "other.md");
    r.git("commit", "-qm", "other");
    r.git("checkout", "-qb", "work");
    rmSync(join(r.dir, "guide.md"));
    symlinkSync("other.md", join(r.dir, "guide.md"));
    r.git("add", "guide.md");
    r.git("commit", "-qm", "link");
    const result = r.run([], { DIFF_RANGE: "main...HEAD" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("guide.md: it is not a regular file");
    const named = r.run(["guide.md"], { DIFF_RANGE: "main...HEAD" });
    expect(named.code).toBe(1);
    expect(named.out).toContain("guide.md: it is not a regular file");
  });

  test("a document staged as a symlink fails when named", () => {
    const r = repo(doc("2026-01-01"));
    r.write(doc("2026-01-01", "Other text.\n"), "other.md");
    r.git("add", "other.md");
    r.git("commit", "-qm", "other");
    rmSync(join(r.dir, "guide.md"));
    symlinkSync("other.md", join(r.dir, "guide.md"));
    r.git("add", "guide.md");
    const result = r.run(["--staged", "guide.md"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("guide.md: it is not a regular file");
  });

  test("an unknown option, or --range without a value, is an error", () => {
    const r = repo(doc("2026-01-01"));
    expect(r.run(["--stagged"]).code).toBe(2);
    expect(r.run(["--range", "main...HEAD"]).code).toBe(2);
  });
});

describe("staged and CI modes", () => {
  test("staged: a staged body edit without a bump fails, with a bump passes", () => {
    const r = repo(doc("2026-01-01"));
    r.write(doc("2026-01-01", "Changed body line.\n"));
    r.git("add", "guide.md");
    expect(r.run(["--staged", "guide.md"]).code).toBe(1);
    r.write(doc("2026-03-01", "Changed body line.\n"));
    r.git("add", "guide.md");
    expect(r.run(["--staged"]).code).toBe(0);
  });

  test("staged: the index is checked, not unstaged edits on top", () => {
    const r = repo(doc("2026-01-01"));
    r.write(doc("2026-03-01", "Changed body line.\n"));
    r.git("add", "guide.md");
    r.write(doc("2026-01-01", "Changed body line.\n"));
    expect(r.run(["--staged", "guide.md"]).code).toBe(0);
  });

  test("--ci without a range skips with a note", () => {
    const r = repo(doc("2026-01-01"));
    const result = r.run(["--ci", "guide.md"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("SKIP — no diff range");
  });

  test("a merge: a file carried unchanged from one side is exempt, one edited during the merge is not", () => {
    const r = repo(doc("2026-01-01"));
    r.write(doc("2026-01-01"), "other.md");
    r.git("add", ".");
    r.git("commit", "-qm", "other");
    r.git("checkout", "-qb", "side");
    // The side branch changed the body without a bump: it would fail on its
    // own, but this gate judged it on its own branch, so the merge carries it.
    r.write(doc("2026-01-01", "Side body line.\n"));
    r.git("commit", "-qam", "side");
    r.git("checkout", "-q", "main");
    r.write(
      doc("2026-01-01", "First body line.\n", "owner: docs\n"),
      "other.md",
    );
    r.git("commit", "-qam", "main");
    r.git("merge", "--no-commit", "--no-ff", "-q", "side");
    expect(r.run(["--staged", "guide.md"]).code).toBe(0);
    // The merge is recognised from a subdirectory too.
    const sub = join(r.dir, "sub");
    mkdirSync(sub);
    expect(r.run(["--staged", "../guide.md"], {}, sub).code).toBe(0);
    // Edited during the merge: matches neither parent, so it is checked.
    r.write(doc("2026-01-01", "Merge-time body line.\n"));
    r.git("add", "guide.md");
    expect(r.run(["--staged", "guide.md"]).code).toBe(1);
  });
});

describe("the pure parts", () => {
  test("advanced: a later date, a newly present date or today counts; a non-date does not", () => {
    expect(advanced("2026-01-01", "2026-02-01", TODAY)).toBe(true);
    expect(advanced("", "2026-01-01", TODAY)).toBe(true);
    expect(advanced("2026-01-01", TODAY, TODAY)).toBe(true);
    expect(advanced("2026-01-01", "2026-01-01", TODAY)).toBe(false);
    expect(advanced("2026-01-01", "2025-12-31", TODAY)).toBe(false);
    expect(advanced("2026-01-01", "soon", TODAY)).toBe(false);
  });
  test("advanced: a date that is not on the calendar never counts", () => {
    expect(advanced("2026-01-01", "2026-99-99", TODAY)).toBe(false);
    expect(advanced("2026-01-01", "2026-02-30", TODAY)).toBe(false);
    expect(advanced("2026-02-30", "2026-03-01", TODAY)).toBe(true);
    expect(advanced("2028-02-28", "2028-02-29", TODAY)).toBe(true);
  });
  test("judge: frontmatter the reader rejects fails, even when the body is unchanged", () => {
    const duplicate = doc("2026-01-01", "New.\n", "last_updated: 2026-05-01\n");
    expect(judge("a.md", doc("2026-01-01"), duplicate, TODAY)).toContain(
      "duplicate key 'last_updated'",
    );
    const anchor = doc("2026-01-01", undefined, "related: &a [x]\n");
    expect(judge("a.md", doc("2026-01-01"), anchor, TODAY)).toContain(
      "a.md: its frontmatter cannot be read",
    );
  });
  test("judge: an old side the reader rejects has no date, so a corrected new side passes", () => {
    const unreadable = doc("2026-01-01", undefined, "related: &a [x]\n");
    expect(judge("a.md", unreadable, doc("2026-01-01", "New.\n"), TODAY)).toBe(
      undefined,
    );
  });
  test("judge: a body change needs a later date; no frontmatter on either side is not a document to date", () => {
    expect(judge("a.md", doc("2026-01-01"), doc("2026-01-01"), TODAY)).toBe(
      undefined,
    );
    expect(
      judge("a.md", doc("2026-01-01"), doc("2026-01-01", "New.\n"), TODAY),
    ).toContain("a.md: the body changed");
    expect(judge("a.md", "# A\n", "# A changed\n", TODAY)).toBe(undefined);
    expect(
      judge(
        "a.md",
        doc("2026-01-01"),
        doc("2026-01-01").replace(/\n/g, "\r\n"),
        TODAY,
      ),
    ).toBe(undefined);
  });
  test("readRawDiff: a rename carries its old path, and a side that is not a regular file is marked", () => {
    const ids = `${"a".repeat(40)} ${"b".repeat(40)}`;
    expect(
      readRawDiff(
        [
          `:100644 100644 ${ids} R096`,
          "old.md",
          "new.md",
          `:100644 100755 ${ids} M`,
          "a b.md",
          `:100644 000000 ${ids} D`,
          "gone.md",
          `:000000 100644 ${ids} A`,
          "new2.md",
          `:100644 120000 ${ids} T`,
          "link.md",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      { status: "R", path: "new.md", oldPath: "old.md", regular: true },
      { status: "M", path: "a b.md", oldPath: "a b.md", regular: true },
      { status: "A", path: "new2.md", oldPath: "new2.md", regular: true },
      { status: "T", path: "link.md", oldPath: "link.md", regular: false },
    ]);
  });
  test("rangeSides: one separator, a left side, HEAD for an empty right side", () => {
    expect(rangeSides("main...HEAD")).toEqual({
      left: "main",
      right: "HEAD",
      triple: true,
    });
    expect(rangeSides("main..")).toEqual({
      left: "main",
      right: "HEAD",
      triple: false,
    });
    expect(rangeSides("main")).toEqual({
      left: "main",
      right: "HEAD",
      triple: false,
    });
    expect(rangeSides("...HEAD")).toContain("no left side");
    expect(rangeSides("a..b..c")).toContain("more than one");
  });
});
