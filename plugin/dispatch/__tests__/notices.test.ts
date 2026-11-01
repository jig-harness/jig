import { expect, test } from "bun:test";
import { listsOwn } from "../lib/followup-marker.ts";
import { parkNotice } from "../lib/notices.ts";
import type { DrivenPr, FollowupMarker } from "../lib/types.ts";

function parked(lines: string[][]): DrivenPr {
  return {
    number: 9,
    title: "t",
    url: "https://example.test/pull/9",
    why: "w",
    evidence: { generation: 3 },
    waiting: lines.map((l, i) => ({ kind: "thread", key: `k${i}`, lines: l })),
  } as unknown as DrivenPr;
}

test("a park message cut to its bound keeps the answer instructions and the URL", () => {
  const long = ["x".repeat(2500)];
  const { text } = parkNotice("o/r", parked([long, long, long]));
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("answer <key>");
  expect(text.endsWith("https://example.test/pull/9")).toBe(true);
});

test("a read-back that lacks the posted marker does not list it", () => {
  const other = { id: 5, trusted: true } as FollowupMarker;
  expect(listsOwn([other], 7)).toBe(false);
  expect(listsOwn([other, { id: 7, trusted: true } as FollowupMarker], 7)).toBe(
    true,
  );
});
