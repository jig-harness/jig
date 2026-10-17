/**
 * A YAML anchor reaches only within its own file, so a probe list several
 * criteria files share (the CI providers, the hook managers, the dependency
 * updaters) is a copy in each. Every copy must equal the first, or a
 * provider added to one file's list is missed by the probes of the others.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CRITERIA_DIR } from "../scripts/lib/criteria.ts";

/** The anchor's value as text: the lines below it, indented deeper, dedented. */
function anchoredBlock(lines: string[], at: number): string {
  const line = lines[at] ?? "";
  const column = line.search(/\S/);
  const block: string[] = [];
  for (const next of lines.slice(at + 1)) {
    if (next.trim() === "") continue;
    if (next.search(/\S/) <= column) break;
    block.push(next);
  }
  const indent = Math.min(...block.map((l) => l.search(/\S/)));
  return block.map((l) => l.slice(indent)).join("\n");
}

/** Every anchor each criteria file defines, by name, with its value's text. */
function anchors(): Map<string, { file: string; block: string }[]> {
  const found = new Map<string, { file: string; block: string }[]>();
  for (const file of readdirSync(CRITERIA_DIR).filter((f) =>
    f.endsWith(".yaml"),
  )) {
    const lines = readFileSync(join(CRITERIA_DIR, file), "utf8").split("\n");
    lines.forEach((line, at) => {
      const name = /&([\w-]+)\s*$/.exec(line)?.[1];
      if (name === undefined) return;
      const copies = found.get(name) ?? [];
      copies.push({ file, block: anchoredBlock(lines, at) });
      found.set(name, copies);
    });
  }
  return found;
}

describe("probe lists shared across criteria files", () => {
  const shared = [...anchors()].filter(([, copies]) => copies.length > 1);

  test("some list is shared, so this test checks something", () => {
    expect(shared.map(([name]) => name)).toContain("ci-config");
  });

  for (const [name, copies] of shared)
    test(`every copy of &${name} equals the first`, () => {
      const [first, ...rest] = copies;
      for (const copy of rest)
        expect({ file: copy.file, block: copy.block }).toEqual({
          file: copy.file,
          block: first?.block ?? "",
        });
    });
});
