import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Chapter, Withdrawn } from "../chapter.ts";
import { baseData, namesFile } from "../base.ts";
import { CHAPTERS } from "../chapters.ts";
import { generate, stage } from "../generate.ts";
import {
  cleanUp,
  commit,
  FIELDS,
  fixtureChapter,
  git,
  layout,
  ok,
  put,
  tempDir,
  VALUES,
} from "./fixture.ts";

afterAll(cleanUp);

/**
 * A repository whose `main` holds `base` (or no Protocol at all), checked out
 * on a branch that holds `now`, with `notes` as change notes the branch adds.
 */
function scratchRepo(
  base: readonly Chapter[] | null,
  now: readonly Chapter[],
  notes: Record<string, string> = {},
): string {
  const root = tempDir("base");
  ok(root, "init", "-q");
  put(root, "README.md", "scratch\n");
  if (base !== null) {
    layout(root, base);
    expect(generate({ root, chapters: base, check: false }).findings).toEqual(
      [],
    );
  }
  commit(root, "base");
  ok(root, "checkout", "-q", "-b", "change");
  for (const gone of base ?? [])
    if (!now.some((c) => c.id === gone.id))
      for (const path of [
        `plugin/protocol/${gone.id}.md`,
        `plugin/protocol/data/${gone.id}.json`,
      ])
        rmSync(join(root, path));
  layout(root, now);
  for (const [name, text] of Object.entries(notes))
    put(root, `changes/${name}`, text);
  expect(generate({ root, chapters: now, check: false }).findings).toEqual([]);
  commit(root, "change");
  return root;
}

/** The check's findings and unreadable reason, compared with `main`. */
function check(
  root: string,
  chapters: readonly Chapter[],
  withdrawn: readonly Withdrawn[] = [],
  base = "main",
) {
  const result = generate({ root, chapters, withdrawn, check: true, base });
  return {
    problems: result.findings.map((f) => `${f.file}: ${f.problem}`),
    unreadable: result.unreadable,
  };
}

const BREAKING = (file: string) =>
  `---\nrelease: minor\n---\n\n### Changed\n\n- **Breaking:** The \`${file}\` chapter changed. **Consumer action:** none.\n`;

describe("the comparison with the integration branch", () => {
  test("passes when the base holds no Protocol", () => {
    const chapter = fixtureChapter();
    const root = scratchRepo(null, [chapter]);
    expect(check(root, [chapter])).toEqual({ problems: [], unreadable: null });
  });

  test("passes a stable chapter that only grows", () => {
    const grown = fixtureChapter({
      values: [...VALUES, { name: "GAMMA", code: 3, meaning: "a third" }],
    });
    const root = scratchRepo([fixtureChapter()], [grown]);
    expect(check(root, [grown]).problems).toEqual([]);
  });

  test("fails a value the base has and the new data lacks", () => {
    const shrunk = fixtureChapter({ values: [VALUES[0] as never] });
    const root = scratchRepo([fixtureChapter()], [shrunk]);
    expect(check(root, [shrunk]).problems).toEqual([
      'plugin/protocol/data/fixture.json: the value the base lists as name "BETA", code 2 is gone',
    ]);
  });

  test("fails a renumbered value, whose identity is its name and its code", () => {
    const renumbered = fixtureChapter({
      values: [VALUES[0] as never, { ...VALUES[1], code: 9 }],
    });
    const root = scratchRepo([fixtureChapter()], [renumbered]);
    expect(check(root, [renumbered]).problems).toEqual([
      'plugin/protocol/data/fixture.json: the value the base lists as name "BETA", code 2 is gone',
    ]);
  });

  test("fails a value whose meaning changed to another value's", () => {
    const reused = fixtureChapter({
      values: [
        VALUES[0] as never,
        { ...VALUES[1], meaning: "the first thing happened" },
      ],
    });
    const root = scratchRepo([fixtureChapter()], [reused]);
    expect(check(root, [reused]).problems).toEqual([
      'plugin/protocol/data/fixture.json: the value name "BETA", code 2 now carries the meaning the base gives name "ALPHA", code 1',
    ]);
  });

  test("passes a meaning reworded in place", () => {
    const reworded = fixtureChapter({
      values: [
        { ...VALUES[0], meaning: "the first thing, reworded" },
        VALUES[1] as never,
      ],
    });
    const root = scratchRepo([fixtureChapter()], [reworded]);
    expect(check(root, [reworded]).problems).toEqual([]);
  });

  test("fails a published field of a value still listed that changed, unless the value is withdrawn to a tombstone", () => {
    const behaviour = {
      ...FIELDS,
      exit: {
        type: "integer" as const,
        nullable: true,
        required: true,
        identifies: false,
        description: "The exit a reader branches on.",
      },
      kind: {
        type: "string" as const,
        nullable: false,
        required: true,
        identifies: false,
        description: "Its kind.",
      },
    };
    const withBehaviour = (exit: number | null, kind: string) =>
      fixtureChapter({
        fields: behaviour,
        values: [{ ...VALUES[0], exit, kind }, VALUES[1] as never].map(
          (v, i) => (i === 0 ? v : { ...v, exit: 0, kind: "state" }),
        ),
      });
    const base = withBehaviour(0, "state");
    const changed = withBehaviour(24, "state");
    const root = scratchRepo([base], [changed]);
    expect(check(root, [changed]).problems).toEqual([
      'plugin/protocol/data/fixture.json: the value name "ALPHA", code 1 changed its exit from 0 to 24',
    ]);
    const withdrawn = withBehaviour(null, "tombstone");
    const second = scratchRepo([base], [withdrawn]);
    expect(check(second, [withdrawn]).problems).toEqual([]);
  });

  test("fails a field that is new and identifies a value, which would let two values share the base's identity", () => {
    const variant = {
      ...FIELDS,
      variant: {
        type: "string" as const,
        nullable: false,
        required: false,
        identifies: true,
        description: "A variant.",
      },
    };
    const added = fixtureChapter({
      fields: variant,
      values: [
        { ...VALUES[0], variant: "a" },
        { ...VALUES[0], variant: "b" },
        VALUES[1] as never,
      ],
    });
    const root = scratchRepo([fixtureChapter()], [added]);
    const { problems } = check(root, [added]);
    expect(problems).toContain(
      "plugin/protocol/data/fixture.json: the field variant is new and identifies a value",
    );
    expect(problems).toContain(
      'plugin/protocol/data/fixture.json: two values share the identity the base gives name "ALPHA", code 1',
    );
  });

  test("fails a field whose type changed", () => {
    const fields = { ...FIELDS, code: { ...FIELDS.code, nullable: true } };
    const retyped = fixtureChapter({ fields } as never);
    const root = scratchRepo([fixtureChapter()], [retyped]);
    expect(check(root, [retyped]).problems).toEqual([
      "plugin/protocol/data/fixture.json: the field code changed type from integer to integer or null",
    ]);
  });

  test("fails a field that is new and required, and one made required", () => {
    const optional = {
      ...FIELDS,
      note: {
        type: "string" as const,
        nullable: false,
        required: false,
        identifies: false,
        description: "An optional note.",
      },
    };
    const added = fixtureChapter({
      fields: {
        ...FIELDS,
        origin: { ...optional.note, required: true },
      },
      values: VALUES.map((v) => ({ ...v, origin: "here" })),
    });
    const root = scratchRepo([fixtureChapter()], [added]);
    expect(check(root, [added]).problems).toEqual([
      "plugin/protocol/data/fixture.json: the field origin is new and required",
    ]);

    const made = fixtureChapter({
      fields: { ...optional, note: { ...optional.note, required: true } },
      values: VALUES.map((v) => ({ ...v, note: "n" })),
    });
    const second = scratchRepo([fixtureChapter({ fields: optional })], [made]);
    expect(check(second, [made]).problems).toEqual([
      "plugin/protocol/data/fixture.json: the field note changed from optional to required",
    ]);
  });

  test("passes any of those once the chapter's version is raised and a note marks it breaking", () => {
    const shrunk = fixtureChapter({ version: 2, values: [VALUES[0] as never] });
    const root = scratchRepo([fixtureChapter()], [shrunk], {
      "note.md": BREAKING("fixture.md"),
    });
    expect(check(root, [shrunk]).problems).toEqual([]);
  });

  test("fails a raised version with no breaking note when it breaks the chapter", () => {
    const shrunk = fixtureChapter({ version: 2, values: [VALUES[0] as never] });
    const root = scratchRepo([fixtureChapter()], [shrunk]);
    expect(check(root, [shrunk]).problems).toHaveLength(1);
    expect(check(root, [shrunk]).problems[0]).toContain(
      "with no change note marked breaking",
    );
  });

  test("fails a value listed twice whatever the chapter's status, with or without a breaking note", () => {
    const doubled = (extra: Parameters<typeof fixtureChapter>[0]) =>
      fixtureChapter({ values: [...VALUES, VALUES[0] as never], ...extra });
    for (const chapter of [
      doubled({}),
      doubled({ status: "provisional" }),
      doubled({ version: 2 }),
    ]) {
      const root = tempDir("doubled");
      ok(root, "init", "-q");
      layout(root, [chapter]);
      expect(
        generate({ root, chapters: [chapter], check: false }).findings.some(
          (f) => f.problem.includes("is listed more than once"),
        ),
      ).toBe(true);
    }
  });

  test("no chapter identifies a value by a nullable field, which a withdrawal would null", () => {
    for (const chapter of CHAPTERS)
      for (const [name, spec] of Object.entries(chapter.fields))
        if (spec.identifies)
          expect({
            chapter: chapter.id,
            name,
            nullable: spec.nullable,
          }).toEqual({ chapter: chapter.id, name, nullable: false });
  });

  test("fails a version lowered below the base's", () => {
    const lowered = fixtureChapter({ version: 1 });
    const root = scratchRepo([fixtureChapter({ version: 2 })], [lowered]);
    expect(check(root, [lowered]).problems).toEqual([
      "plugin/protocol/data/fixture.json: the chapter's version 1 is below the base's 2",
    ]);
  });

  test("fails a stable chapter marked provisional, unless its version is raised and a note marks it breaking", () => {
    const provisional = (version: number) =>
      fixtureChapter({
        version,
        status: "provisional",
        planItems: [{ item: 7, epic: 70 }],
      });
    const plain = scratchRepo([fixtureChapter()], [provisional(1)]);
    expect(check(plain, [provisional(1)]).problems).toEqual([
      "plugin/protocol/data/fixture.json: the base lists fixture as stable, and this change marks it provisional",
    ]);
    const raised = scratchRepo([fixtureChapter()], [provisional(2)]);
    expect(check(raised, [provisional(2)]).problems).toEqual([
      "plugin/protocol/data/fixture.json: the base lists fixture as stable, and this change marks it provisional",
    ]);
    const noted = scratchRepo([fixtureChapter()], [provisional(2)], {
      "fixture.md": BREAKING("fixture.md"),
    });
    expect(check(noted, [provisional(2)]).problems).toEqual([]);
  });

  test("does not hold a chapter the base lists as provisional", () => {
    const base = fixtureChapter({
      status: "provisional",
      planItems: [{ item: 7, epic: 70 }],
    });
    const shrunk = fixtureChapter({
      status: "provisional",
      planItems: [{ item: 7, epic: 70 }],
      values: [VALUES[0] as never],
    });
    const root = scratchRepo([base], [shrunk]);
    expect(check(root, [shrunk]).problems).toEqual([]);
  });

  test("fails a stable chapter removed, unless it is withdrawn at a raised version with a breaking note", () => {
    const other = fixtureChapter({ id: "other", takes: [] });
    const both = [fixtureChapter(), other];
    const removed = scratchRepo(both, [other]);
    expect(check(removed, [other]).problems).toEqual([
      "plugin/protocol/fixture.md: the base lists fixture as a stable chapter at version 1, and the chapter list no longer names it",
    ]);
    const unnoted = scratchRepo(both, [other]);
    expect(
      check(unnoted, [other], [{ id: "fixture", version: 2 }]).problems,
    ).toEqual([
      "plugin/protocol/fixture.md: the stable chapter fixture is withdrawn with no change note marked breaking",
    ]);
    const invalid = scratchRepo(both, [other], {
      "withdraw.md": BREAKING("fixture.md"),
    });
    for (const version of [Number.NaN, Number.POSITIVE_INFINITY, 2.5])
      expect(
        check(invalid, [other], [{ id: "fixture", version }]).problems,
      ).toEqual([
        "plugin/protocol/fixture.md: the base lists fixture as a stable chapter at version 1, and the chapter list no longer names it",
      ]);
    const archived = scratchRepo(both, [other], {
      "archive/withdraw.md": BREAKING("fixture.md"),
    });
    expect(
      check(archived, [other], [{ id: "fixture", version: 2 }]).problems,
    ).toEqual([
      "plugin/protocol/fixture.md: the stable chapter fixture is withdrawn with no change note marked breaking",
    ]);
    const withdrawn = scratchRepo(both, [other], {
      "withdraw.md": BREAKING("fixture.md"),
    });
    expect(
      check(withdrawn, [other], [{ id: "fixture", version: 2 }]).problems,
    ).toEqual([]);
  });
});

describe("a merge base that cannot be read", () => {
  test("fails, naming the fetch, when the integration branch is not in the clone", () => {
    const chapter = fixtureChapter();
    const root = scratchRepo([chapter], [chapter]);
    expect(check(root, [chapter], [], "origin/main")).toEqual({
      problems: [],
      unreadable:
        "origin/main cannot be read; fetch it: git fetch <remote> origin/main (the remote that holds origin/main)",
    });
  });

  test("fails, naming the fetch that deepens it, in a shallow clone", () => {
    const chapter = fixtureChapter();
    const origin = scratchRepo([chapter], [chapter]);
    ok(origin, "checkout", "-q", "main");
    put(origin, "README.md", "main moved on\n");
    commit(origin, "main moves");
    const clone = tempDir("shallow");
    ok(
      origin,
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      "change",
      pathToFileURL(origin).href,
      clone,
    );
    ok(
      clone,
      "fetch",
      "-q",
      "--depth",
      "1",
      "origin",
      "main:refs/remotes/origin/main",
    );
    expect(check(clone, [chapter], [], "origin/main")).toEqual({
      problems: [],
      unreadable:
        "the merge base with origin/main cannot be read in this shallow clone; fetch the history that holds it: git fetch --unshallow origin main",
    });
    ok(clone, "fetch", "-q", "--unshallow", "origin", "main");
    expect(check(clone, [chapter], [], "origin/main")).toEqual({
      problems: [],
      unreadable: null,
    });
  });
});

describe("reading the base's data files", () => {
  test("a listing git cannot make fails the check, quoting git; an empty one means no Protocol", () => {
    const chapter = fixtureChapter();
    const root = scratchRepo(null, [chapter]);
    const main = ok(root, "rev-parse", "main").trim();
    expect(baseData(root, main)).toEqual({
      ok: true,
      data: new Map(),
      findings: [],
    });
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const read = baseData(root, missing);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain(
        "the base's data files cannot be listed: git ls-tree",
      );
      expect(read.reason).toContain(missing);
    }
  });

  test("a data file git cannot show fails the check, quoting git", () => {
    const chapter = fixtureChapter();
    const root = scratchRepo([chapter], [chapter]);
    const blob = ok(
      root,
      "rev-parse",
      "main:plugin/protocol/data/fixture.json",
    ).trim();
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const result = check(root, [chapter]);
    expect(result.problems).toEqual([]);
    expect(result.unreadable).toContain(
      "the base's copy of plugin/protocol/data/fixture.json cannot be read: git show",
    );
  });

  test("a base copy that is not JSON, and one without a data file's shape, are reported apart", () => {
    const chapter = fixtureChapter();
    const broken = (text: string) => {
      const root = tempDir("broken");
      ok(root, "init", "-q");
      put(root, "plugin/protocol/data/fixture.json", text);
      commit(root, "base");
      ok(root, "checkout", "-q", "-b", "change");
      rmSync(join(root, "plugin/protocol/data/fixture.json"));
      layout(root, [chapter]);
      generate({ root, chapters: [chapter], check: false });
      commit(root, "change");
      return check(root, [chapter]).problems;
    };
    const [notJson] = broken("{ not json");
    expect(notJson).toContain("is not valid JSON (");
    expect(broken('{ "chapter": "fixture" }\n')).toEqual([
      expect.stringContaining(
        "is JSON without a data file's shape (chapter, version, status, fields and values)",
      ),
    ]);
  });
});

describe("histories that share no commit", () => {
  test("are reported as unrelated, not as a missing fetch", () => {
    const chapter = fixtureChapter();
    const root = scratchRepo([chapter], [chapter]);
    ok(root, "checkout", "-q", "--orphan", "other");
    commit(root, "unrelated");
    expect(check(root, [chapter])).toEqual({
      problems: [],
      unreadable:
        "HEAD and main share no history, so there is no merge base to compare with: compare with the branch this one was cut from (--base <ref>)",
    });
  });
});

describe("the breaking note's chapter", () => {
  test("is named by its whole file name", () => {
    expect(
      namesFile("- **Breaking:** `drive-exits.md` changed", "drive-exits"),
    ).toBe(true);
    expect(
      namesFile("- **Breaking:** plugin/protocol/exits.md changed", "exits"),
    ).toBe(true);
    expect(namesFile("- **Breaking:** `drive-exits.md` changed", "exits")).toBe(
      false,
    );
    expect(namesFile("- **Breaking:** exits.mdx changed", "exits")).toBe(false);
    expect(namesFile("- **Breaking:** exits.md.bak changed", "exits")).toBe(
      false,
    );
    expect(namesFile("- **Breaking:** changed exits.md.", "exits")).toBe(true);
  });

  test("a note naming another chapter whose name ends in this one's does not clear it", () => {
    const provisional = fixtureChapter({
      id: "exits",
      version: 2,
      status: "provisional",
      planItems: [{ item: 7, epic: 70 }],
    });
    const root = scratchRepo([fixtureChapter({ id: "exits" })], [provisional], {
      "other.md": BREAKING("drive-exits.md"),
    });
    expect(check(root, [provisional]).problems).toEqual([
      "plugin/protocol/data/exits.json: the base lists exits as stable, and this change marks it provisional",
    ]);
  });
});

/** Every file under `root` but git's own, with its bytes. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(full, readFileSync(full, "base64"));
    }
  };
  walk(root);
  return files;
}

describe("--check and --stage", () => {
  test("a failing check writes nothing", () => {
    const changed = fixtureChapter({ values: [VALUES[0] as never] });
    const root = scratchRepo([fixtureChapter()], [fixtureChapter()]);
    const before = snapshot(root);
    const result = check(root, [changed]);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(snapshot(root)).toEqual(before);
  });

  test("--stage stages exactly the outputs a write changed", () => {
    const root = scratchRepo(null, [fixtureChapter()]);
    put(root, "README.md", "an edit the commit does not include\n");
    const changed = fixtureChapter({ values: [VALUES[0] as never] });
    const written = generate({
      root,
      chapters: [changed],
      check: false,
    }).written;
    expect([...written].sort()).toEqual([
      "plugin/protocol/data/fixture.json",
      "plugin/protocol/fixture.md",
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
    );
    expect(stage(root, written, env)).toBe(0);
    expect(
      ok(root, "diff", "--cached", "--name-only").trim().split("\n").sort(),
    ).toEqual([
      "plugin/protocol/data/fixture.json",
      "plugin/protocol/fixture.md",
    ]);
    expect(git(root, "diff", "--name-only").stdout.toString().trim()).toBe(
      "README.md",
    );
  });
});
