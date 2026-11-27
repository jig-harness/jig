/**
 * drive-pr suite: the backlog entries the reviewer renders in its not-blocking
 * section, which the divergence stop leaves out of its count while
 * convergence still counts them.
 */
import { describe, expect, it } from "bun:test";
import { fingerprintOf } from "../scripts/lib/finding-fingerprint.ts";
import { classify } from "../scripts/summary-findings.ts";

const classifyBeyondThisPr = (
  entries: Array<{
    fingerprint: string;
    path: string;
    line: number | null;
    comment: string;
    reason?: string;
    blocking?: boolean;
  }>,
  renderedLines: string[],
  prefixLines: string[] = [],
) =>
  classify({
    pr: 1,
    stickyCommentId: 9,
    stickyBody: [
      ...prefixLines,
      `<details><summary>🗂️ <b>Beyond this PR</b> — ${entries.length} finding(s) for triage (not posted inline)</summary>`,
      "",
      "Held out of the inline threads so this PR can converge — **not blocking**.",
      ...renderedLines,
      "</details>",
      `<!-- ai-review-backlog: ${Buffer.from(JSON.stringify(entries)).toString("base64")} -->`,
    ].join("\n"),
    anchoredKeys: [],
    addressedFingerprints: new Set(),
  });

describe("the entries the reviewer renders as not blocking", () => {
  // The reviewer's blob and its section both abbreviate a long comment, and
  // its fingerprint hashes the full text, so no rendered field reproduces it.
  const abbreviated = (path: string, line: number, lead: string) => ({
    fingerprint: fingerprintOf(path, line, `${lead} and the rest of it.`),
    path,
    line,
    comment: `${lead}…`,
    reason: "delta-round-deferred",
  });
  const rendering = (e: { path: string; line: number; comment: string }) =>
    `- \`${e.path}:${e.line}\` — 🟡 **medium** · 🏷️ category: correctness (correctness · in-change) — ${e.comment}`;

  it("names an abbreviated entry the section renders, while convergence still counts it", () => {
    const entries = [
      abbreviated("a.md", 3, "The first held finding"),
      abbreviated("b.md", 9, "The second held finding"),
    ];
    const r = classifyBeyondThisPr(entries, entries.map(rendering));
    expect(r.ignoredBacklog).toEqual([]);
    expect(r.unaddressed.map((f) => f.fingerprint).sort()).toEqual(
      entries.map((e) => e.fingerprint).sort(),
    );
    expect([...r.notBlockingBacklog].sort()).toEqual(
      entries.map((e) => e.fingerprint).sort(),
    );
  });

  it("never names an entry flagged blocking, one the section does not render, or an ambiguous rendering", () => {
    const flagged = {
      ...abbreviated("a.md", 3, "Flagged blocking"),
      blocking: true,
    };
    const hidden = abbreviated("b.md", 9, "Not in the section");
    const twinA = abbreviated("c.md", 4, "The same lead");
    const twinB = {
      ...abbreviated("c.md", 4, "The same lead"),
      fingerprint: fingerprintOf("c.md", 4, "The same lead, another one."),
    };
    const shown = abbreviated("d.md", 1, "Shown once");
    // One bullet that reads as either of two entries renders only one.
    const tail = abbreviated("g.md", 7, "A tail");
    const longer = abbreviated("g.md", 7, "A lead — A tail");
    longer.comment = `A lead — ${tail.comment}`;
    const r = classifyBeyondThisPr(
      [flagged, hidden, twinA, twinB, shown, tail, longer],
      [flagged, twinA, twinB, shown, longer].map(rendering),
    );
    expect(r.notBlockingBacklog).toEqual([shown.fingerprint]);
  });

  it("never names an entry a fresh body bullet raises again", () => {
    const text = "Raised again on this head.";
    const entry = {
      fingerprint: fingerprintOf("e.md", 2, text),
      path: "e.md",
      line: 2,
      comment: text,
    };
    const carried = abbreviated("f.md", 5, "Carried forward");
    const r = classifyBeyondThisPr(
      [entry, carried],
      [rendering(entry), rendering(carried)],
      [`- \`e.md:2\` — ${text}`],
    );
    expect(r.notBlockingBacklog).toEqual([carried.fingerprint]);
  });
});
