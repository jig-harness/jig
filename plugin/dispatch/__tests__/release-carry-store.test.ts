/**
 * A release answer an earlier version persisted in the carry store is
 * passed over, and a session-framed carry beside it is still handed on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb } from "../lib/state.ts";
import {
  claimAnswer,
  type CarriedAnswer,
  takeCarried,
} from "../lib/station-answer-store.ts";

const SLUG = "example-org/web";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-carry-store-"));
  roots.push(dir);
  return dir;
}

describe("a release carry an earlier version persisted", () => {
  it("is passed over, and a session-framed carry beside it is still handed on", () => {
    const dir = root();
    const carry = (option: string): CarriedAnswer => ({
      question: "q?",
      option,
      recommended: false,
      changes: "",
      costs: "",
      by: "maintainer",
      url: `https://github.com/${SLUG}/pull/12#issuecomment-1`,
    });
    const row = (digest: string, answer: string, option: string) => ({
      repo: SLUG,
      target: "PR #12",
      key: `pickup-${digest}`,
      digest,
      answer,
      author: "maintainer",
      option,
    });
    claimAnswer(row("d1", "a 1", "Other"), carry("Other"), dir);
    claimAnswer(
      row("d2", "b 2", "Release the claim"),
      carry("Release the claim"),
      dir,
    );
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)?.option).toBe("Other");
    expect(takeCarried(SLUG, "PR #12", "r-2", dir)).toBeNull();
  });

  it("hands on a session-framed option that shares the release option's name", () => {
    const dir = root();
    const digest = "d3";
    claimAnswer(
      {
        repo: SLUG,
        target: "PR #12",
        key: `pickup-${digest}`,
        digest,
        answer: "c 3",
        author: "maintainer",
        option: "Release the claim",
      },
      {
        question: "q?",
        option: "Release the claim",
        recommended: false,
        changes: "",
        costs: "",
        by: "maintainer",
        url: `https://github.com/${SLUG}/pull/12#issuecomment-3`,
        step: "session",
      },
      dir,
    );
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)?.option).toBe(
      "Release the claim",
    );
  });
});
