/**
 * record-labels.test.ts — a thread record's severity and category: from the
 * code scanning alert behind a code-scanning thread, else from the finding's
 * own comment.
 */
import { describe, expect, it } from "bun:test";
import {
  categoryOfRecord,
  severityOfRecord,
} from "../scripts/lib/record-labels.ts";

const labels = (rec: object) => [severityOfRecord(rec), categoryOfRecord(rec)];

describe("record labels", () => {
  const scanned = (codeScanning: unknown) => ({
    comments: [{ author: "github-advanced-security", body: "## Tool / Rule" }],
    codeScanning,
  });

  it("reads a code-scanning thread's labels from its alert", () => {
    expect(labels(scanned({ severity: "high", category: "security" }))).toEqual(
      ["high", "security"],
    );
  });

  it("reads an unreadable alert as unknown", () => {
    expect(
      labels(scanned({ severity: "unknown", category: "unknown" })),
    ).toEqual(["unknown", "unknown"]);
  });

  it("refuses a value outside Jig's vocabulary", () => {
    expect(labels(scanned({ severity: "severe", category: "{tier}" }))).toEqual(
      ["unknown", "unknown"],
    );
  });

  it("reads any other thread from its first comment", () => {
    expect(
      labels({
        comments: [
          {
            author: "shadow-review",
            body: "🟠 **high** · 🏷️ category: data-integrity",
          },
        ],
      }),
    ).toEqual(["unknown", "data-integrity"]);
  });
});
