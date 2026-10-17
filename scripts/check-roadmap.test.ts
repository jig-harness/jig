import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRoadmap,
  citedItems,
  compare,
  parseGroups,
  RENDERED,
} from "./check-roadmap.ts";

const root = join(import.meta.dir, "..");

const plan = `# The plan

## Now

### 2. Internal only

### 3. Kickoff

### 4. Changelog

## Later

- **Jira store.** Detail.
- **Drive follow-ups.** Detail.

## Open decisions

- **Publishing.** Detail.
`;

const roadmap = `# Roadmap

## Now

### 3. The kickoff family

### 4. \`changelog\` skill

## Later

- **Jira store.** Short.
`;

/**
 * The string literals of the content loader's `pattern: [...]` array. Throws
 * on anything else in the array (a spread, a variable) or a non-array value,
 * so a list this cannot read fails the test instead of shrinking it.
 */
function loaderPatterns(source: string): string[] {
  const start = /\bpattern\s*:\s*\[/.exec(source);
  if (!start) throw new Error("no `pattern: [` array in the loader");
  const literal = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`/y;
  const skip = /(?:\s|,|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
  const patterns: string[] = [];
  let at = start.index + start[0].length;
  for (;;) {
    skip.lastIndex = at;
    skip.exec(source);
    at = skip.lastIndex;
    if (source[at] === "]") return patterns;
    literal.lastIndex = at;
    const match = literal.exec(source);
    if (!match)
      throw new Error(
        `the loader's pattern list holds something other than a string literal at offset ${at}`,
      );
    patterns.push(match[1] ?? match[2] ?? match[3] ?? "");
    at = literal.lastIndex;
  }
}

const problems = (
  r: string,
  p = plan,
  rendered: { file: string; text: string }[] = [],
) => compare(r, p, rendered).map((f) => f.problem);

describe("roadmap-plan", () => {
  test("reads groups, numbered items and bold-led entries outside code blocks", () => {
    const groups = parseGroups(`${plan}\n\`\`\`\n## Not a group\n\`\`\`\n`);
    expect(groups.map((g) => g.name)).toEqual([
      "Now",
      "Later",
      "Open decisions",
    ]);
    expect(groups[0]?.items.map((i) => i.key)).toEqual(["2", "3", "4"]);
    expect(groups[1]?.bullets.map((b) => b.key)).toEqual([
      "Jira store",
      "Drive follow-ups",
    ]);
  });

  test("accepts a roadmap that is a subset of the plan in the plan's order", () => {
    expect(problems(roadmap)).toEqual([]);
  });

  test("an item the plan does not have under that group", () => {
    expect(problems(roadmap.replace("### 4.", "### 5."))).toEqual([
      'item 5 is not under "Now" in the plan',
    ]);
  });

  test("items out of the plan's order", () => {
    const swapped = roadmap
      .replace("### 3. The kickoff family", "### 9. placeholder")
      .replace("### 4. `changelog` skill", "### 3. The kickoff family")
      .replace("### 9. placeholder", "### 4. `changelog` skill");
    expect(problems(swapped)).toEqual([
      'item 4 is out of the plan\'s order under "Now" (3, 4)',
      'item 3 is out of the plan\'s order under "Now" (3, 4)',
    ]);
  });

  test("a Later entry and a group the plan does not have", () => {
    expect(problems(`${roadmap}- **Windows.** Short.\n\n## Someday\n`)).toEqual(
      [
        '"Windows" is not under "Later" in the plan',
        'the plan has no "Someday" group',
      ],
    );
  });

  test("a rendered page may cite only items on the roadmap", () => {
    const rendered = [
      {
        file: "FACTORY.md",
        text: "See [ROADMAP.md](ROADMAP.md) item 3.\nAnd roadmap items 4 and 2,\nthen ROADMAP.md item 40.",
      },
    ];
    expect(
      compare(roadmap, plan, rendered).map((f) => `${f.line}: ${f.problem}`),
    ).toEqual([
      "2: cites roadmap item 2, which only the maintainers' plan has",
      "3: cites roadmap item 40, which neither the roadmap nor the plan has",
    ]);
  });

  test("finds citations in the forms the documents use", () => {
    const keys = (text: string) => citedItems(text).map((c) => c.key);
    expect(keys("(ROADMAP.md item 19)")).toEqual(["19"]);
    expect(
      keys("the shorthand (item 9, which merges) and (items 14 and 15)"),
    ).toEqual(["9", "14", "15"]);
    expect(keys("[planned work](ROADMAP.md#999-missing)")).toEqual(["999"]);
    expect(keys("roadmap items 10 and 12")).toEqual(["10", "12"]);
    expect(keys("Roadmap item 10")).toEqual(["10"]);
    expect(keys("the roadmap's item 7")).toEqual(["7"]);
    expect(keys("a list item 4 of the steps")).toEqual([]);
  });

  test("a citation wrapped onto the next line, in every form, with its line", () => {
    const text =
      "Planned in ROADMAP.md\nitem 999; also roadmap\nitems 2 and\n40, see (item\n41) or [this](ROADMAP.md#42-x).";
    expect(
      compare(roadmap, plan, [{ file: "M9.md", text }]).map(
        (f) => `${f.line}: ${f.problem}`,
      ),
    ).toEqual([
      "2: cites roadmap item 999, which neither the roadmap nor the plan has",
      "3: cites roadmap item 2, which only the maintainers' plan has",
      "4: cites roadmap item 40, which neither the roadmap nor the plan has",
      "5: cites roadmap item 41, which neither the roadmap nor the plan has",
      "5: cites roadmap item 42, which neither the roadmap nor the plan has",
    ]);
  });

  test("whole groups out of the plan's order", () => {
    const reordered = `# Roadmap\n\n## Later\n\n- **Jira store.** Short.\n\n## Now\n\n### 3. Kickoff\n`;
    expect(problems(reordered)).toEqual([
      `group "Later" is out of the plan's order (Now, Later)`,
      `group "Now" is out of the plan's order (Now, Later)`,
    ]);
  });

  test("an item number or a group name given twice, in either page", () => {
    const twice = `${roadmap}\n## Now\n\n### 3. Kickoff again\n`;
    expect(problems(twice, twice)).toEqual([
      'group "Now" appears twice (first on line 3)',
      "item 3 appears twice (first on line 5)",
      'group "Now" appears twice (first on line 3)',
      "item 3 appears twice (first on line 5)",
    ]);
  });

  test("structure it does not read is a finding, not silence", () => {
    const odd = roadmap
      .replace("# Roadmap\n", "# Roadmap\n\n### 1. Before any group\n")
      .replace("### 4. ", "### Item 4: ");
    expect(problems(odd)).toEqual([
      '"### 1. Before any group" is not a form this check reads',
      '"### Item 4: `changelog` skill" is not a form this check reads',
    ]);
  });

  test("a fence closes only on its own character, at least as long", () => {
    const fenced = `${roadmap}\n\`\`\`\`md\n\`\`\`\n### 998. Shown as code\n\`\`\`\`\n\n~~~\n\`\`\`\n~~~\n\n## Now again\n\n### 999. Missing from plan\n`;
    expect(problems(fenced)).toEqual(['the plan has no "Now again" group']);
    expect(problems(fenced.replace("## Now again\n", ""))).toEqual([
      'item 999 is not under "Later" in the plan',
    ]);
  });

  test("an entry under a group in a form this check does not read", () => {
    const odd = roadmap.replace(
      "- **Jira store.** Short.\n",
      "- **Jira store.** Short.\n- New public feature absent from the plan\n* **Windows.** Short.\n1. **Numbered.** Short.\n",
    );
    expect(problems(odd)).toEqual([
      '"- New public feature absent from the plan" is not a form this check reads',
      '"* **Windows.** Short." is not a form this check reads',
      '"1. **Numbered.** Short." is not a form this check reads',
    ]);
  });

  test("a heading or entry CommonMark reads in a form this check does not", () => {
    const odd = roadmap.replace(
      "- **Jira store.** Short.\n",
      "- **Jira store.** Short.\n  - a child of the entry\n\n    - a deeper child\n - **Sibling.** Short.\n\nText.\n  - **Indented.** Short.\n###\t999. Missing from plan\n  ### 998. Indented\n##\tTabbed group\n",
    );
    expect(problems(odd)).toEqual([
      '" - **Sibling.** Short." is not a form this check reads',
      '"  - **Indented.** Short." is not a form this check reads',
      '"###\t999. Missing from plan" is not a form this check reads',
      '"  ### 998. Indented" is not a form this check reads',
      '"##\tTabbed group" is not a form this check reads',
    ]);
  });

  test("lists inside an item's body and continuation lines are the item's text", () => {
    const body = roadmap.replace(
      "### 3. The kickoff family\n",
      "### 3. The kickoff family\n\n- a step\n* **Bold.** another\n  continued\n",
    );
    expect(problems(body)).toEqual([]);
  });

  test("reads a list of numbers to its end, with or without a serial comma", () => {
    const keys = (text: string) => citedItems(text).map((c) => c.key);
    expect(keys("roadmap items 3, 4, and 999")).toEqual(["3", "4", "999"]);
    expect(keys("roadmap items 3, 4 and 999")).toEqual(["3", "4", "999"]);
    expect(keys("(items 3, 4, or 999)")).toEqual(["3", "4", "999"]);
  });

  test("the shorthand inside parentheses, or in a block with an explicit citation", () => {
    const keys = (text: string) => citedItems(text).map((c) => c.key);
    expect(
      keys("- the merge (until a repository delegates it, item 9);"),
    ).toEqual(["9"]);
    expect(
      keys("(Jira is ROADMAP.md item 12; the deferral\nstep, item 10)"),
    ).toEqual(["12", "10"]);
    expect(
      keys("Roadmap item 10 holds the names;\nitem 12 holds the rest."),
    ).toEqual(["10", "12"]);
    expect(
      keys("Roadmap item 10 holds the names.\n\nThen item 12 of the steps."),
    ).toEqual(["10"]);
    expect(keys("as in Step 4a item 1, and item 2) closes")).toEqual([]);
    expect(
      keys("See the details ([the plan](design/plan.md), item 2)."),
    ).toEqual([]);
    expect(keys("(see design/plan.md item 2)")).toEqual([]);
    expect(keys("(see Step 4a item 1)")).toEqual([]);
    expect(keys("(§ 3, item 2)")).toEqual([]);
    expect(keys("(see [the roadmap](ROADMAP.md), item 3)")).toEqual(["3"]);
    expect(keys("(see the steps, item 3)")).toEqual(["3"]);
    expect(keys("(a link)\n\nitem 7 of the list")).toEqual([]);
  });

  test("the shorthand takes the subject of the nearest document its block names", () => {
    const keys = (text: string) => citedItems(text).map((c) => c.key);
    expect(keys("See design/plan.md (item 2).")).toEqual([]);
    expect(keys("[The plan](design/plan.md) says more (item 2).")).toEqual([]);
    expect(
      keys("(ROADMAP.md item 3 and [Herdr](https://herdr.dev); item 999)"),
    ).toEqual(["3", "999"]);
    expect(
      keys(
        "(ROADMAP.md item 3, [the checker](scripts/check-roadmap.ts), item 999)",
      ),
    ).toEqual(["3", "999"]);
    expect(
      keys("See design/plan.md.\nROADMAP.md item 3 then (item 4)."),
    ).toEqual(["3", "4"]);
    expect(
      keys("ROADMAP.md item 3, then design/plan.md item 5 (item 6)."),
    ).toEqual(["3"]);
    expect(keys("See design/plan.md for more.\n\nThe merge (item 9).")).toEqual(
      ["9"],
    );
  });

  test("a roadmap or plan with no items, or a rendered pattern matching nothing, cannot be checked", () => {
    const scratch = mkdtempSync(join(tmpdir(), "check-roadmap-"));
    try {
      mkdirSync(join(scratch, "design"));
      writeFileSync(join(scratch, "ROADMAP.md"), "");
      writeFileSync(join(scratch, "design/plan.md"), "");
      expect(checkRoadmap(scratch)).toBe(2);
      writeFileSync(join(scratch, "ROADMAP.md"), roadmap);
      writeFileSync(join(scratch, "design/plan.md"), plan);
      expect(checkRoadmap(scratch)).toBe(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("reads the loader's patterns in any valid formatting", () => {
    expect(
      loaderPatterns(
        `glob({ pattern: [\n  "a.md", // rendered\n  'b/*.md',\n  /* c */ \`c.md\`, ], base: "..", })`,
      ),
    ).toEqual(["a.md", "b/*.md", "c.md"]);
    expect(() =>
      loaderPatterns(`glob({ pattern: [...EXTRA, "a.md"] })`),
    ).toThrow();
    expect(() => loaderPatterns(`glob({ pattern: PATTERNS })`)).toThrow();
  });

  test("checks the documents the site renders", () => {
    const config = readFileSync(
      join(root, "website/src/content.config.ts"),
      "utf8",
    );
    expect(
      loaderPatterns(config).filter(
        (p) => p !== "ROADMAP.md" && p !== "CHANGELOG.md",
      ),
    ).toEqual(RENDERED);
  });

  test("the repository's roadmap and plan agree", () => {
    expect(checkRoadmap(root)).toBe(0);
  });
});
