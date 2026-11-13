import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSON_ACTS } from "../lib/answer.ts";

const README = join(import.meta.dir, "..", "..", "README.md");
const LEAD = "with the act that settles it, one of ";
const END = "; and `needAct`";

/** The acts the README's `waitsOn` row names, in its order. */
function documentedActs(): string[] {
  const row = readFileSync(README, "utf8")
    .split("\n")
    .find((line) => line.startsWith("| `waitsOn` |"));
  if (row === undefined) throw new Error("README.md has no `waitsOn` row");
  const start = row.indexOf(LEAD);
  const end = row.indexOf(END, start);
  if (start < 0 || end < 0)
    throw new Error(
      `the \`waitsOn\` row does not list its acts between "${LEAD}" and "${END}"`,
    );
  return [...row.slice(start + LEAD.length, end).matchAll(/`([^`]+)`/g)].map(
    (m) => m[1] ?? "",
  );
}

it("the README's `waitsOn` row lists every person act, in PersonAct's order", () => {
  expect(documentedActs()).toEqual([...PERSON_ACTS]);
});
