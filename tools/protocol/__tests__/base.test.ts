import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Chapter, Withdrawn } from "../chapter.ts";
import { generate } from "../generate.ts";
import {
  cleanUp,
  commit,
  FIELDS,
  fixtureChapter,
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

  test("passes any of those once the chapter's version is raised", () => {
    const shrunk = fixtureChapter({ version: 2, values: [VALUES[0] as never] });
    const root = scratchRepo([fixtureChapter()], [shrunk]);
    expect(check(root, [shrunk]).problems).toEqual([]);
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
