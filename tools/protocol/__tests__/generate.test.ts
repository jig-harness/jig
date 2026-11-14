import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { CHAPTERS } from "../chapters.ts";
import { generate } from "../generate.ts";
import { planOutputs, staleness } from "../outputs.ts";
import { statusLine } from "../render.ts";
import {
  chapterSource,
  cleanUp,
  fixtureChapter,
  layout,
  put,
  SOURCE,
  tempDir,
  VALUES,
} from "./fixture.ts";

const repo = join(import.meta.dir, "..", "..", "..");
afterAll(cleanUp);

/** A scratch root with `chapters` laid out and written once. */
function written(chapters = [fixtureChapter()]): string {
  const root = tempDir("gen");
  layout(root, chapters);
  const result = generate({ root, chapters, check: false });
  expect(result.findings).toEqual([]);
  return root;
}

/** The problems a plan of `chapters` over `root` finds, one line each. */
const problems = (root: string, chapters = [fixtureChapter()]) =>
  planOutputs(root, chapters).findings.map((f) => `${f.file}: ${f.problem}`);

/** The parts of every output that differ from its file. */
function stale(root: string, chapters = [fixtureChapter()]): string[] {
  return planOutputs(root, chapters).outputs.flatMap((o) =>
    staleness(root, o).map((part) => `${o.path}: ${part}`),
  );
}

describe("the committed chapters", () => {
  test("match the code", () => {
    const plan = planOutputs(repo, CHAPTERS);
    expect(plan.findings).toEqual([]);
    expect(
      plan.outputs.flatMap((o) =>
        staleness(repo, o).map((p) => `${o.path}: ${p}`),
      ),
    ).toEqual([]);
  });
});

describe("writing", () => {
  test("fills the status line and each section, and leaves the prose as written", () => {
    const root = written();
    const text = readFileSync(join(root, "plugin/protocol/fixture.md"), "utf8");
    const lines = text.split("\n");
    expect(lines[0]).toBe("# The fixture chapter");
    expect(lines[2]).toBe("Version 1 · stable");
    expect(text).toContain("Prose a person wrote.");
    expect(text).toContain("Closing prose.");
    expect(text).toContain("| ALPHA | 1 | the first thing happened |");
    expect(stale(root)).toEqual([]);
  });

  test("writes the index page's list and the data file", () => {
    const root = written();
    const index = readFileSync(join(root, "plugin/protocol/README.md"), "utf8");
    expect(index).toContain("An introduction a person wrote.");
    expect(index).toContain(
      "| [The fixture chapter](fixture.md) | What fixture covers. | 1 | stable | [data/fixture.json](data/fixture.json) |",
    );
    const data = JSON.parse(
      readFileSync(join(root, "plugin/protocol/data/fixture.json"), "utf8"),
    );
    expect(data).toMatchObject({
      chapter: "fixture",
      version: 1,
      status: "stable",
      values: VALUES,
    });
    expect(data.planItems).toBeUndefined();
  });

  test("a provisional chapter names its plan items, linked to their epics, in its status line and its data file", () => {
    const chapter = fixtureChapter({
      status: "provisional",
      planItems: [{ item: 7, epic: 70 }],
    });
    expect(statusLine(chapter)).toBe(
      "Version 1 · provisional, moved by [plan item 7](https://github.com/jig-harness/jig/issues/70)",
    );
    const root = written([chapter]);
    const data = JSON.parse(
      readFileSync(join(root, "plugin/protocol/data/fixture.json"), "utf8"),
    );
    expect(data.planItems).toEqual([{ item: 7, epic: 70 }]);
  });

  test("a second write changes nothing", () => {
    const root = written();
    const again = generate({
      root,
      chapters: [fixtureChapter()],
      check: false,
    });
    expect(again.written).toEqual([]);
  });
});

describe("--check over the outputs", () => {
  test("names the section that differs from the code", () => {
    const root = written();
    const changed = fixtureChapter({
      values: [{ ...VALUES[0], meaning: "something else" }, VALUES[1]],
    } as never);
    expect(stale(root, [changed])).toContain(
      `plugin/protocol/fixture.md: the generated section from ${SOURCE} differs from the code's`,
    );
    expect(stale(root, [changed])).toContain(
      "plugin/protocol/data/fixture.json: its values differ from the code's",
    );
  });

  test("names a status line that differs", () => {
    const root = written();
    expect(stale(root, [fixtureChapter({ version: 2 })])).toContain(
      'plugin/protocol/fixture.md: the status line differs: it should read "Version 2 · stable"',
    );
  });

  test("compares a data file as parsed JSON, not as text", () => {
    const root = written();
    const path = join(root, "plugin/protocol/data/fixture.json");
    put(
      root,
      "plugin/protocol/data/fixture.json",
      JSON.stringify(JSON.parse(readFileSync(path, "utf8"))),
    );
    expect(stale(root)).toEqual([]);
  });

  test("names a data file that is missing", () => {
    const root = written();
    rmSync(join(root, "plugin/protocol/data/fixture.json"));
    expect(stale(root)).toEqual([
      "plugin/protocol/data/fixture.json: the file does not exist",
    ]);
  });
});

describe("refusals", () => {
  test("a chapter file with no entry in the list", () => {
    const root = written();
    put(root, "plugin/protocol/stray.md", chapterSource("Stray"));
    expect(problems(root)).toEqual([
      "plugin/protocol/stray.md: a chapter file with no entry in the chapter list",
    ]);
  });

  test("a data file with no entry in the list", () => {
    const root = written();
    put(root, "plugin/protocol/data/stray.json", "{}\n");
    expect(problems(root)).toEqual([
      "plugin/protocol/data/stray.json: a data file with no entry in the chapter list",
    ]);
  });

  test("an entry with no file", () => {
    const root = written();
    rmSync(join(root, "plugin/protocol/fixture.md"));
    expect(problems(root)).toEqual([
      "plugin/protocol/fixture.md: the chapter list names this chapter, but its file does not exist",
    ]);
  });

  test("a marker whose source is not the one the list names", () => {
    const root = tempDir("marker");
    const chapter = fixtureChapter();
    layout(root, [chapter]);
    put(
      root,
      "plugin/protocol/fixture.md",
      chapterSource(chapter.title, ["fixture/other.ts#ELSEWHERE"]),
    );
    expect(problems(root, [chapter])).toEqual([
      `plugin/protocol/fixture.md: line 7: the marker names source fixture/other.ts#ELSEWHERE, but the chapter list names ${SOURCE} for section 1`,
    ]);
  });

  test("a section the list names with no markers, and an unclosed one", () => {
    const root = tempDir("markers");
    const chapter = fixtureChapter({ sources: [SOURCE, "fixture/two.ts#T"] });
    layout(root, [chapter]);
    expect(problems(root, [chapter])).toEqual([
      "plugin/protocol/fixture.md: 1 generated section(s) the chapter list names have no markers: fixture/two.ts#T",
    ]);
    put(
      root,
      "plugin/protocol/fixture.md",
      chapterSource(chapter.title).replace(
        "<!-- /protocol:generated -->\n",
        "",
      ),
    );
    expect(problems(root, [fixtureChapter()])).toEqual([
      "plugin/protocol/fixture.md: line 7: a section with no end marker",
    ]);
  });

  test("a value whose meaning is empty", () => {
    const root = written();
    const chapter = fixtureChapter({
      values: [{ name: "ALPHA", code: 1, meaning: " " }],
    });
    expect(problems(root, [chapter])).toEqual([
      "plugin/protocol/fixture.md: ALPHA has no meaning",
    ]);
  });

  test("a value two chapters take", () => {
    const root = tempDir("twice");
    const one = fixtureChapter({ id: "one" });
    const two = fixtureChapter({ id: "two", takes: [`${SOURCE}.BETA`] });
    layout(root, [one, two]);
    expect(problems(root, [one, two])).toEqual([
      `plugin/protocol/two.md: ${SOURCE}.BETA is taken by one and two`,
    ]);
  });

  test("a provisional chapter whose plan item is not in the plan", () => {
    const root = written();
    const chapter = fixtureChapter({
      status: "provisional",
      planItems: [
        { item: 7, epic: 70 },
        { item: 8, epic: 80 },
      ],
    });
    expect(problems(root, [chapter])).toEqual([
      "plugin/protocol/fixture.md: plan item 8 is not in design/plan.md",
    ]);
  });

  test("a provisional chapter with no plan item, and a stable one that names one", () => {
    const root = written();
    expect(problems(root, [fixtureChapter({ status: "provisional" })])).toEqual(
      [
        "plugin/protocol/fixture.md: a provisional chapter names no plan item that still moves it",
      ],
    );
    expect(
      problems(root, [fixtureChapter({ planItems: [{ item: 7, epic: 70 }] })]),
    ).toEqual([
      "plugin/protocol/fixture.md: a stable chapter names plan items (7)",
    ]);
  });

  test("a value that does not fit its declared fields", () => {
    const root = written();
    const chapter = fixtureChapter({
      values: [{ name: "ALPHA", code: "one", meaning: "m" }],
    });
    expect(problems(root, [chapter])).toEqual([
      'plugin/protocol/fixture.md: ALPHA\'s code is "one", which its field declaration (integer, required) does not allow',
    ]);
  });
});

describe("the command", () => {
  test("refuses --stage with --check, and --base without --check", () => {
    const script = join(import.meta.dir, "..", "generate.ts");
    for (const args of [
      ["--check", "--stage"],
      ["--base", "main"],
    ]) {
      const result = Bun.spawnSync([process.execPath, script, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(result, 2, args.join(" "));
      expect(result.stderr.toString()).toContain("usage: generate.ts");
    }
  });
});
