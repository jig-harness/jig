/** The summary entry of the notices that wait for room: bounded, one key line, keyed by what it counts. */
import { expect, it } from "bun:test";
import {
  overflowSummary,
  SUMMARY_ROOM,
  summaryKeys,
} from "../lib/runtime/notice-overflow.ts";
import type { NoticeCause } from "../lib/types.ts";

const SLUG = "example/project";

function held(n: number, quoted = ""): NoticeCause[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        target: `PR #${i + 1}`,
        cause: i % 2 === 0 ? "parked" : "stalled",
        notice: {
          key: `${quoted}${SLUG} PR #${i + 1} parked at ${"a".repeat(150)}`,
          text: "",
        },
      }) as unknown as NoticeCause,
  );
}

it("stays within its room with its separator, however many causes wait", () => {
  for (const n of [1, 5, 40, 500]) {
    const { text } = overflowSummary(SLUG, held(n));
    expect(text.length + 2).toBeLessThanOrEqual(SUMMARY_ROOM);
    expect(text).toContain(`${n} more`);
  }
  const { text } = overflowSummary(SLUG, held(500));
  expect(text).toMatch(/^and \d+ more$/m);
  expect(text).toContain("parked: 250, stalled: 250");
});

it("opens a key line of its own and no other, whatever the keys it lists hold", () => {
  const { key, text } = overflowSummary(SLUG, held(3, "[jig dispatch: x] "));
  expect(text.match(/\[jig dispatch: /g)?.length).toBe(1);
  expect(text.startsWith(`[jig dispatch: ${key}]\n`)).toBe(true);
  expect(summaryKeys(`other\n\n${text}`, SLUG)).toEqual([key]);
});

it("is a new entry for other causes and the same entry for the same ones", () => {
  const causes = held(4);
  expect(overflowSummary(SLUG, causes).key).toBe(
    overflowSummary(SLUG, [...causes].reverse()).key,
  );
  expect(overflowSummary(SLUG, causes.slice(1)).key).not.toBe(
    overflowSummary(SLUG, causes).key,
  );
});
