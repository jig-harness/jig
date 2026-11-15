import { expect, test } from "bun:test";
import type { Cause } from "../lib/actions/notify.ts";
import { fitting } from "../lib/runtime/orca-card.ts";
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

test("a later disputed park stays visible beside an overflowing earlier decision", () => {
  const pr = parked([["x".repeat(8000)], ["Second question?"]]);
  const second = pr.waiting?.[1];
  if (second === undefined) throw new Error("missing park fixture");
  second.disputed = [
    {
      author: "owner",
      at: "2026-11-02T10:00:00Z",
      url: "u",
      body: "approve",
      choice: { option: "Keep", recommended: true, form: "approve" },
    },
    {
      author: "maintainer",
      at: "2026-11-02T11:00:00Z",
      url: "v",
      body: "wait for the migration",
    },
  ];
  const { text } = parkNotice("example/project", pr);
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("Disputed");
  expect(text).toContain("@owner");
  expect(text).toContain("Keep");
  expect(text).toContain("@maintainer");
  expect(text).toContain("wait for the migration");
  expect(text.indexOf("Disputed")).toBeLessThan(text.indexOf("x".repeat(20)));
});

test("many disputes keep the notice bounded and point to omitted answers", () => {
  const pr = parked(Array.from({ length: 30 }, () => ["x".repeat(8000)]));
  for (const park of pr.waiting ?? [])
    park.disputed = [
      {
        author: "owner",
        at: "2026-11-02T10:00:00Z",
        url: "u",
        body: "approve",
      },
      {
        author: "maintainer",
        at: "2026-11-02T11:00:00Z",
        url: "v",
        body: "wait",
      },
    ];
  const { text } = parkNotice("example/project", pr);
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("more disputed decisions");
  expect(text).toContain("read their answers on the pull request");
  expect(text).toContain("answer <key>");
  expect(text.endsWith(pr.url)).toBe(true);
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

test("a conflict park has its own notice identity even when its ledger did not change", () => {
  const pr = parked([["decision"]]);
  const original = parkNotice("o/r", pr);
  pr.evidence = {
    ...pr.evidence,
    mergeable: "CONFLICTING",
    headSha: "h",
    baseSha: "b",
  };
  const conflict = parkNotice("o/r", pr);
  expect(conflict.key).not.toBe(original.key);
  expect(conflict.text).toContain("also conflicts with its base");
  pr.evidence.baseSha = "next";
  expect(parkNotice("o/r", pr).key).not.toBe(conflict.key);
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

test("long decision details keep later recipients visible", () => {
  const pr = parked([["x".repeat(4000)], ["Second question?"]]);
  pr.waiting = [
    {
      key: "first",
      kind: "thread",
      lines: ["x".repeat(4000)],
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
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("@web-owner");
  expect(text).toContain("answer <key>");
});
