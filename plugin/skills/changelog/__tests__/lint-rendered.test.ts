/**
 * Common Changelog's rules over what a changelog renders as: references with
 * their authors, broken reference groups, hidden HTML, category headings and
 * every list of a group; and the line each finding points at where a heading
 * is hidden or written over several lines.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMON_RULES,
  lintCommonChangelog,
} from "../scripts/lint-common-changelog.ts";
import { readChangelog } from "../scripts/lint-structure.ts";

const clean = readFileSync(
  join(import.meta.dir, "fixtures", "lint", "common-changelog", "clean.md"),
  "utf8",
);
const NONE = { current: null, tagged: [] };
const lint = (text: string) =>
  lintCommonChangelog(readChangelog("CHANGELOG.md", text), NONE);

/** The rule ids found in the clean fixture with `from` replaced by `to`. */
function commonWith(from: string, to: string): string[] {
  expect(clean).toContain(from);
  return [...new Set(lint(clean.replace(from, to)).map((f) => f.rule))];
}

const item = "- Fix the parser ([#7](https://example.com/o/r/pull/7))";

describe("references", () => {
  test("authors may share the reference's parentheses after a semicolon", () => {
    for (const linked of [
      "- Fix the parser ([#7](https://example.com/o/r/pull/7); Alice Meerkat)",
      "- Fix the parser ([#7](https://example.com/o/r/pull/7), [#8](https://example.com/o/r/pull/8); Alice Meerkat, Bob)",
    ])
      expect(commonWith(item, linked)).toEqual([]);
    for (const broken of [
      "- Fix the parser ([#7](https://example.com/o/r/pull/7);)",
      "- Fix the parser ([#7][missing]; Alice Meerkat)",
    ])
      expect(commonWith(item, broken)).toEqual([COMMON_RULES.reference.id]);
  });

  test("a reference group that breaks off stays broken when a sound one follows", () => {
    expect(
      commonWith(
        item,
        "- Fix the parser ([#7](https://example.com/o/r/pull/7), [#8][missing],) ([#9](https://example.com/o/r/pull/9))",
      ),
    ).toEqual([COMMON_RULES.reference.id]);
    // Ordinary parentheses that open with a link are not a reference.
    expect(
      commonWith(
        item,
        "- Fix the parser ([docs](https://example.com/docs) say why) ([#7](https://example.com/o/r/pull/7))",
      ),
    ).toEqual([]);
  });

  test("an HTML comment is not the change's text", () => {
    // At the line's start the comment is an HTML block; in emphasis, inline HTML.
    for (const hidden of [
      "- <!-- hidden --> ([#7](https://example.com/o/r/pull/7))",
      "- **<!-- hidden -->** ([#7](https://example.com/o/r/pull/7))",
    ])
      expect(commonWith(item, hidden)).toEqual([COMMON_RULES.reference.id]);
  });

  test("a reference with many entries is read in linear time", () => {
    const entries = "\t,[#1](u)".repeat(20_000);
    const started = performance.now();
    expect(commonWith(item, `- Fix the parser ([#0](u)${entries}`)).toEqual([
      COMMON_RULES.reference.id,
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("change groups", () => {
  test("a category heading is plain text", () => {
    for (const heading of [
      "### [Fixed](https://example.com/)",
      "### **Fixed**",
      "### `Fixed`",
    ])
      expect(commonWith("### Removed", heading)).toEqual([
        COMMON_RULES.category.id,
      ]);
  });

  test("every list of a group is checked, after a stray block too", () => {
    expect(
      commonWith(item, `${item}\n\nA stray paragraph.\n\n- Fix another crash`),
    ).toEqual([COMMON_RULES.list.id, COMMON_RULES.reference.id]);
  });
});

describe("the line a finding points at", () => {
  const dateLine = (text: string) =>
    lint(text).find((f) => f.rule === COMMON_RULES.date.id)?.line;

  test("a heading line inside an HTML comment is not the release's", () => {
    const text =
      "# Changelog\n\n<!--\n## hidden\n-->\n\n[1.0.0] - 2024-02-30\n---\n\n_First release._\n";
    expect(dateLine(text)).toBe(7);
  });

  test("a definition written over several lines does not stand in for the release after it", () => {
    const title = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const text = `# Changelog\n\n[meta]: /url "\n${title}\n"\n\n[1.0.0] - 2024-02-30\n---\n\n_First release._\n`;
    expect(dateLine(text)).toBe(18);
  });

  test("a setext release is found at its text, and an ATX one at its line", () => {
    const text =
      "# Changelog\n\n## 2.0.0 - 2024-02-30\n\n_Second._\n\n1.0.0 - 2024-02-31\n---\n\n_First release._\n";
    expect(
      lint(text)
        .filter((f) => f.rule === COMMON_RULES.date.id)
        .map((f) => f.line),
    ).toEqual([3, 7]);
  });
});
