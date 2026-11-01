import { expect, test } from "bun:test";
import { listsOwn, readBack } from "../lib/followup-marker.ts";
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

const TICK = { kind: "tick", record: "r1" } as const;

test("a read-back that lacks the posted marker does not list it", () => {
  const other = { id: 5, trusted: true, run: TICK } as FollowupMarker;
  expect(listsOwn([other], 7, TICK)).toBe(false);
  expect(
    listsOwn(
      [other, { id: 7, trusted: true, run: TICK } as FollowupMarker],
      7,
      TICK,
    ),
  ).toBe(true);
});

test("a posted marker edited to another body is not the claim", () => {
  const edited = {
    id: 7,
    trusted: true,
    run: { kind: "unreadable", reason: "x" },
  } as FollowupMarker;
  const other = {
    id: 7,
    trusted: true,
    run: { kind: "tick", record: "r2" },
  } as FollowupMarker;
  expect(listsOwn([edited], 7, TICK)).toBe(false);
  expect(listsOwn([other], 7, TICK)).toBe(false);
  expect(readBack([edited], 7, TICK).kind).toBe("altered");
});

test("a notice key longer than its bound is cut and still tells two keys apart", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `ws-${i}`).join(", ");
  const a = parkNotice(`o/r ${ids(2000)}`, parked([["a"]]));
  const b = parkNotice(`o/r ${ids(1999)}`, parked([["a"]]));
  expect(a.key.length).toBeLessThanOrEqual(200);
  expect(a.text.length).toBeLessThanOrEqual(4000);
  expect(a.key).not.toBe(b.key);
});
