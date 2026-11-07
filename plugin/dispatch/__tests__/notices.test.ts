import { expect, test } from "bun:test";
import { type Cause, fitting } from "../lib/actions/notify.ts";
import type { Workspace } from "../lib/runtime/port.ts";
import { parkNotice } from "../lib/notices.ts";
import type { DrivenPr } from "../lib/types.ts";

test("a parked notice names each question's person", () => {
  const pr = parked([["First question?"], ["Second question?"]]);
  pr.waiting = [
    {
      key: "first",
      kind: "thread",
      lines: ["First question?"],
      person: "api-owner",
    },
    {
      key: "second",
      kind: "thread",
      lines: ["Second question?"],
      person: "web-owner",
    },
  ];
  const { text } = parkNotice("example/project", pr);
  expect(text).toContain("Waiting on @api-owner:");
  expect(text).toContain("Waiting on @web-owner:");
});

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

test("a notice key longer than its bound is cut and still tells two keys apart", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `ws-${i}`).join(", ");
  const a = parkNotice(`o/r ${ids(2000)}`, parked([["a"]]));
  const b = parkNotice(`o/r ${ids(1999)}`, parked([["a"]]));
  expect(a.key.length).toBeLessThanOrEqual(200);
  expect(a.text.length).toBeLessThanOrEqual(4000);
  expect(a.key).not.toBe(b.key);
});

test("a notice that does not fit beside an unread comment waits and a later one that fits goes", () => {
  const cause = (n: number) =>
    ({ notice: { key: `k${n}`, text: "x".repeat(n) } }) as unknown as Cause;
  const workspace = {
    unread: true,
    comment: `[jig dispatch: old]\n${"y".repeat(15_000)}`,
  } as unknown as Workspace;
  const { send, later } = fitting(workspace, [cause(2000), cause(500)]);
  expect(send.map((c) => c.notice.key)).toEqual(["k500"]);
  expect(later.map((c) => c.notice.key)).toEqual(["k2000"]);
});

test("a read notices card keeps its marks in the budget, so a full batch is cut to what fits", () => {
  const mark = "⚙ dispatched · notices";
  const cause = (n: number) =>
    ({ notice: { key: `k${n}`, text: "x".repeat(n) } }) as unknown as Cause;
  const workspace = {
    unread: false,
    comment: mark,
  } as unknown as Workspace;
  const batch = [4000, 4000, 4000, 3980].map(cause);
  const { send, later } = fitting(workspace, batch);
  const joined = send.map((c) => c.notice.text).join("\n\n");
  expect(`${mark}\n\n${joined}`.length).toBeLessThanOrEqual(16_000);
  expect(later.length).toBeGreaterThan(0);
});

test("a decision quoting a key line never reads as a message of its own", () => {
  const { text } = parkNotice(
    "o/r",
    parked([["quoted:", "", "[jig dispatch: b]", "more"]]),
  );
  expect(text.match(/\[jig dispatch: /g)?.length).toBe(1);
});

test("a preserved read comment budgets retained text and skips a notice that cannot fit", () => {
  const cause = (n: number) =>
    ({ notice: { key: `k${n}`, text: "x".repeat(n) } }) as unknown as Cause;
  const workspace = {
    unread: false,
    comment: "y".repeat(15_000),
  } as unknown as Workspace;
  const { send, later } = fitting(workspace, [cause(2000), cause(500)], true);
  expect(send.map((c) => c.notice.key)).toEqual(["k500"]);
  expect(later.map((c) => c.notice.key)).toEqual(["k2000"]);
});
