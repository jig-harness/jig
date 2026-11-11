import { expect, test } from "bun:test";
import { type Plan, renderPlan } from "../lib/plan.ts";

const plan = (over: Partial<Plan>): Plan =>
  ({
    address: "drive@o/r#1",
    repo: "o/r",
    verb: "answer",
    writesAs: "me",
    record: "r",
    where: "w",
    reader: "x",
    undo: "u",
    notice: null,
    tick: null,
    write: async () => {
      throw new Error("not written");
    },
    ...over,
  }) as Plan;

test("a dry run prints no terminal control from a detail or an earlier answer, and keeps layout newlines", () => {
  const out = renderPlan(
    plan({
      earlier: ["theirs \u001b[2J gone"],
      detail: [["option", "Keep\u001b[2J\nCosts: \u009b1A all"]],
    }),
    true,
  );
  expect(out.includes("\u001b") || out.includes("\u009b")).toBe(false);
  expect(out).toContain("theirs  [2J gone");
  expect(out).toContain("Keep [2J\n");
  expect(out).toContain("Costs:");
});

test("a dry run prints no direction-changing character from a detail", () => {
  const out = renderPlan(
    plan({ detail: [["option", "Costs: a ‮b‬ c ⁦d⁩"]] }),
    true,
  );
  expect(/[‪-‮⁦-⁩]/.test(out)).toBe(false);
  expect(out).toContain("Costs: a  b  c  d ");
});

test("a dry run prints no terminal control from any row, the record included", () => {
  const out = renderPlan(
    plan({
      address: "drive@o/r#1\u001b[2J",
      record: "a comment: answer F_\u001b[2J: approve",
      where: "w\u009b1A",
      reader: "x\u001b[H",
      undo: "u\u001b[3J",
      notice: "n\u001b[2J",
    }),
    true,
  );
  expect(out.includes("\u001b") || out.includes("\u009b")).toBe(false);
  expect(out).toContain("answer F_ [2J: approve");
});
