/**
 * drive-pr suite: the findings a review-object reviewer puts only in its
 * review's body (`lib/review-body.ts`), read in CodeRabbit's format. The
 * fixtures keep the markup of CodeRabbit's real reviews, one per layout it
 * has used, with neutral paths and prose.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintOf } from "../scripts/lib/finding-fingerprint.ts";
import {
  parseCodeRabbitBody,
  type ReviewBodyEntry,
  reviewBodyReport,
} from "../scripts/lib/review-body.ts";
import type { ReviewObject } from "../scripts/lib/status/review-object.ts";

const LOGIN = "coderabbitai[bot]";
const COMMIT = "a".repeat(40);

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dir, "fixtures", "coderabbit", `${name}.md`),
    "utf8",
  );
}

/** `text` with `insert` as lines after its first. */
function afterFirstLine(text: string, insert: string): string {
  const at = text.indexOf("\n") + 1;
  return `${text.slice(0, at)}${insert}\n${text.slice(at)}`;
}

function where(entries: ReviewBodyEntry[]) {
  return entries.map(({ section, path, lines }) => ({ section, path, lines }));
}

function review(id: number, body: string, commit = COMMIT): ReviewObject {
  return { id, commit, submittedAt: "2026-11-11T09:04:00Z", body };
}

function report(
  reviews: ReviewObject[],
  addressedAt: (commit: string) => Set<string> = () => new Set(),
) {
  return reviewBodyReport({
    pr: 7,
    login: LOGIN,
    format: "coderabbit",
    reviews,
    addressedAt,
  });
}

describe("parseCodeRabbitBody", () => {
  it("reads an outside-diff comment in the caution callout and a nitpick group", () => {
    const parsed = parseCodeRabbitBody(fixture("current-outside-diff"));
    expect(parsed.declared).toEqual({ "outside-diff": 1, nitpick: 1 });
    expect(where(parsed.entries)).toEqual([
      { section: "outside-diff", path: "src/report/format.ts", lines: "34" },
      { section: "nitpick", path: "src/report/format.test.ts", lines: "31-31" },
    ]);
  });

  it("keeps an entry's header and prose, and none of its nested blocks or markers", () => {
    const [outside, nitpick] = parseCodeRabbitBody(
      fixture("current-outside-diff"),
    ).entries;
    expect(outside?.text).toStartWith("**<picture>");
    expect(outside?.text).toContain(
      "**Keep sentences that contain abbreviations.**",
    );
    expect(outside?.text).toEndWith("handles abbreviations.");
    expect(nitpick?.text).toEndWith("assert the heading element specifically.");
    for (const e of [outside, nitpick]) {
      expect(e?.text).not.toContain("Prompt for AI Agents");
      expect(e?.text).not.toContain("cr-comment");
      expect(e?.text).not.toContain("<dd>");
    }
  });

  it("reads the pipe-fields layout, without its suggested fix", () => {
    const { entries, declared } = parseCodeRabbitBody(
      fixture("pipe-fields-outside-diff"),
    );
    expect(declared).toEqual({ "outside-diff": 1 });
    expect(where(entries)).toEqual([
      { section: "outside-diff", path: "docs/setup.md", lines: "277" },
    ]);
    expect(entries[0]?.text).not.toContain("```diff");
  });

  it("reads two duplicate comments on one line as two entries", () => {
    const { entries, declared } = parseCodeRabbitBody(fixture("duplicate"));
    expect(declared).toEqual({ duplicate: 2 });
    expect(where(entries)).toEqual([
      { section: "duplicate", path: "package.json", lines: "55-55" },
      { section: "duplicate", path: "package.json", lines: "55-55" },
    ]);
    expect(entries[1]?.text).toContain("set -eu");
  });

  it("reads every section of the grouped layout and skips the review details", () => {
    const { entries, declared } = parseCodeRabbitBody(
      fixture("grouped-sections"),
    );
    expect(declared).toEqual({
      "outside-diff": 2,
      duplicate: 1,
      nitpick: 1,
    });
    expect(where(entries)).toEqual([
      { section: "outside-diff", path: "package.json", lines: "50-50" },
      { section: "outside-diff", path: "package.json", lines: "1-116" },
      { section: "duplicate", path: "src/routes.ts", lines: "134-135" },
      { section: "nitpick", path: "src/routes.ts", lines: "5-317" },
    ]);
  });

  it("reads the line-range-hint layout, without the tool context", () => {
    const { entries } = parseCodeRabbitBody(fixture("line-range-hint"));
    expect(where(entries)).toEqual([
      { section: "nitpick", path: "server/app.py", lines: "195-195" },
      { section: "nitpick", path: "server/app.py", lines: "150-150" },
    ]);
    expect(entries[0]?.text).not.toContain("imported but unused");
  });

  it("reads a follow-up entry under its severity group", () => {
    const { entries, declared, ids } = parseCodeRabbitBody(
      fixture("follow-up"),
    );
    expect(declared).toEqual({ "follow-up": 1 });
    expect(ids).toEqual(["000000000000000000000006"]);
    expect(entries[0]?.id).toBe("000000000000000000000006");
    expect(where(entries)).toEqual([
      { section: "follow-up", path: "src/store/drafts.ts", lines: "608" },
    ]);
  });

  it("does not read a file group named like a section as a heading", () => {
    const { declared } = parseCodeRabbitBody(
      "<details>\n<summary>Nitpick comments (1)</summary><blockquote>\n\n<details>\n<summary>docs/follow-up (1)</summary><blockquote>\n\n`3-3`: **Name it.**\n\n</blockquote></details>\n\n</blockquote></details>\n",
    );
    expect(declared).toEqual({ nitpick: 1 });
  });

  it("reads no findings from a body with no finding sections", () => {
    const parsed = parseCodeRabbitBody(
      "**Actionable comments posted: 2**\n\n<details>\n<summary>Additional comments (1)</summary><blockquote>\n\n`3-3`: **Looks right.**\n\n</blockquote></details>\n",
    );
    expect(parsed).toEqual({ entries: [], declared: {}, ids: [] });
  });

  it("keeps reading past a shorter fence inside a longer one", () => {
    const body = fixture("grouped-sections").replace(
      "Sort the segments alphabetically.",
      "Sort the segments alphabetically.\n\n````md\n```\n````",
    );
    const { declared, entries } = parseCodeRabbitBody(body);
    expect(declared.nitpick).toBe(1);
    expect(where(entries).at(-1)).toEqual({
      section: "nitpick",
      path: "src/routes.ts",
      lines: "5-317",
    });
  });
});

describe("reviewBodyReport", () => {
  it("reports each entry as a review-body finding with the reviewer's severity", () => {
    const r = report([review(1, fixture("current-outside-diff"))]);
    expect(r.total).toBe(2);
    expect(r.declaredUnanchored).toBe(2);
    const [outside] = r.findings;
    expect(outside).toMatchObject({
      source: "review-body",
      path: "src/report/format.ts",
      line: 34,
      severity: "low",
      addressed: false,
    });
    const text = parseCodeRabbitBody(fixture("current-outside-diff")).entries[0]
      ?.text;
    expect(outside?.fingerprint).toBe(
      fingerprintOf("src/report/format.ts", "34", text ?? ""),
    );
    const piped = report([review(1, fixture("pipe-fields-outside-diff"))]);
    expect(piped.findings[0]?.severity).toBe("low");
  });

  it("reads every review, newest first, and counts a repeated entry once", () => {
    const r = report([
      review(1, fixture("current-actionable")),
      review(2, fixture("current-outside-diff")),
    ]);
    expect(r.findings.map((f) => f.path)).toEqual([
      "src/report/format.ts",
      "src/report/format.test.ts",
    ]);
  });

  it("dates each finding against the newest review that carries it", () => {
    const older = "b".repeat(40);
    const body = fixture("current-actionable");
    const fp = report([review(1, body)]).findings[0]?.fingerprint ?? "";
    expect(fp).not.toBe("");
    const reviews = [review(1, body, older), review(2, body)];
    const asked: string[] = [];
    // Answered as of the older review's commit only: the newest review
    // raises the finding again, so the answer no longer holds.
    const stale = report(reviews, (commit) => {
      asked.push(commit);
      return new Set(commit === older ? [fp] : []);
    });
    expect(asked).toEqual([COMMIT]);
    expect(stale.total).toBe(1);
    expect(stale.findings[0]?.addressed).toBe(false);
    // Answered as of the newest review's commit: it holds.
    const current = report(
      reviews,
      (commit) => new Set(commit === older ? [] : [fp]),
    );
    expect(current.findings[0]?.addressed).toBe(true);
  });

  it("marks an answered finding addressed and leaves the rest open", () => {
    const first = report([review(1, fixture("grouped-sections"))]);
    const answered = first.findings[0]?.fingerprint ?? "";
    const r = report(
      [review(1, fixture("grouped-sections"))],
      () => new Set([answered]),
    );
    expect(r.unaddressed).toHaveLength(3);
    expect(r.unaddressed.map((f) => f.fingerprint)).not.toContain(answered);
  });

  it("reports a marked entry under a heading it does not know as unaccounted", () => {
    const body = fixture("follow-up").replace("Follow-up (1)", "Later (1)");
    const r = report([review(42, body)]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      source: "unaccounted",
      fingerprint: `unaccounted-${COMMIT.slice(0, 12)}-42-unread-1`,
    });
    expect(r.findings[0]?.text).toContain("marks 1 comment(s)");
  });

  it("reports an id no entry took, though a split entry makes up the count", () => {
    const body = fixture("duplicate")
      .replace(
        "**Check the runtime floor for the build tool.**",
        "**Check the runtime floor for the build tool.**\n\n`12`: see the floor above.",
      )
      .replace(
        "`55-55`: _⚠️ Potential issue_ | _🟠 Major_",
        "55: _⚠️ Potential issue_ | _🟠 Major_",
      );
    const r = report([review(43, body)]);
    const slots = r.findings.filter((f) => f.source === "unaccounted");
    expect(slots.map((f) => f.fingerprint)).toEqual([
      `unaccounted-${COMMIT.slice(0, 12)}-43-unread-1`,
    ]);
  });

  it("reports an entry it cannot read as an unaccounted finding of that review", () => {
    const body = fixture("duplicate").replace(
      "`55-55`: _⚠️ Potential issue_ | _🟠 Major_",
      "55: _⚠️ Potential issue_ | _🟠 Major_",
    );
    const r = report([review(41, body)]);
    // The heading's shortfall and the unread id are separate obligations: the
    // two are not known to name the same entry.
    expect(r.total).toBe(3);
    const slots = r.unaddressed.filter((f) => f.source === "unaccounted");
    expect(slots.map((f) => f.fingerprint)).toEqual([
      `unaccounted-${COMMIT.slice(0, 12)}-41-duplicate-2`,
      `unaccounted-${COMMIT.slice(0, 12)}-41-unread-1`,
    ]);
    expect(slots[0]?.text).toContain("declares 2 duplicate comment(s)");
  });

  it("takes no entry id from fenced code", () => {
    const body = afterFirstLine(
      fixture("current-actionable"),
      "\n```\n<!-- cr-comment:v1:deadbeef -->\n```",
    );
    const r = report([review(44, body)]);
    expect(r.findings.filter((f) => f.source === "unaccounted")).toEqual([]);
  });

  it("does not read a tag quoted as inline code as layout", () => {
    const body = fixture("current-outside-diff").replace(
      "The separator treats",
      "Escape `<details>` and `</details>` here. The separator treats",
    );
    expect(body).not.toBe(fixture("current-outside-diff"));
    const quoted = parseCodeRabbitBody(body);
    const plain = parseCodeRabbitBody(fixture("current-outside-diff"));
    expect(where(quoted.entries)).toEqual(where(plain.entries));
    expect(quoted.entries[0]?.text).toContain("Escape `<details>`");
    expect(quoted.entries[0]?.id).toBe(plain.entries[0]?.id);
  });

  it("does not read inline code as a fence opener", () => {
    const plain = parseCodeRabbitBody(fixture("current-actionable"));
    const body = afterFirstLine(
      fixture("current-actionable"),
      "```` ``` ```` is an inline example.\n",
    );
    const parsed = parseCodeRabbitBody(body);
    expect(where(parsed.entries)).toEqual(where(plain.entries));
    expect(parsed.ids).toEqual(plain.ids);
    expect(parsed.declared).toEqual(plain.declared);
  });

  it("matches a code span's closing run by length", () => {
    const body = fixture("current-outside-diff").replace(
      "The separator treats",
      "Replace ``<details>`` with ``</details>`` to fix nesting. The separator treats",
    );
    const quoted = parseCodeRabbitBody(body);
    expect(quoted.entries[0]?.text).toContain("Replace ``<details>`` with");
    expect(quoted.entries[0]?.id).toBe(
      parseCodeRabbitBody(fixture("current-outside-diff")).entries[0]?.id,
    );
  });

  it("takes no entry id from a marker quoted in prose", () => {
    const body = fixture("current-outside-diff").replace(
      "The separator treats",
      "Do not emit `<!-- cr-comment:v1:deadbeef -->` here. The separator treats",
    );
    const parsed = parseCodeRabbitBody(body);
    expect(parsed.ids).not.toContain("deadbeef");
    expect(parsed.entries[0]?.id).not.toBe("deadbeef");
    expect(parsed.entries[0]?.text).toContain("Do not emit");
  });
});
