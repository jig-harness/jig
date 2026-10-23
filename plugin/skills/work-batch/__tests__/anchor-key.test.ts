/**
 * Which issue an anchor names, under each tracker's key shape: a bare number
 * names a GitHub issue only when no catalog area or repository path has that
 * name.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  numberKeys,
  teamKeys,
} from "../../do-item/scripts/lib/tracker/keys.ts";
import { run } from "../scripts/candidates.ts";
import { anchorIssueKey } from "../scripts/lib/anchor-key.ts";
import { catalog, fakeTracker, issue, policy } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "work-batch-anchor-"));
mkdirSync(join(root, "2024"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const github = numberKeys("owner/name");

describe("anchorIssueKey", () => {
  it("reads a GitHub issue by number, #number or address", () => {
    for (const input of [
      "12",
      "#12",
      "https://github.com/owner/name/issues/12",
    ])
      expect(anchorIssueKey(input, catalog(), root, github)).toBe("#12");
  });

  it("lets a path of the same name win over a bare number, never over #number", () => {
    expect(anchorIssueKey("2024", catalog(), root, github)).toBeNull();
    expect(anchorIssueKey("#2024", catalog(), root, github)).toBe("#2024");
  });

  it("reads a bare number as no issue under a team-keyed tracker", () => {
    for (const keys of [teamKeys("ENG"), null])
      expect(anchorIssueKey("12", catalog(), root, keys)).toBeNull();
  });

  it("keeps any team's key, as given, and an area name, as an area", () => {
    expect(anchorIssueKey("eng-1", catalog(), root, teamKeys("ENG"))).toBe(
      "eng-1",
    );
    expect(anchorIssueKey("OPS-1", catalog(), root, null)).toBe("OPS-1");
    expect(anchorIssueKey("billing", catalog(), root, github)).toBeNull();
  });
});

describe("run, anchored on a GitHub issue number", () => {
  it("proposes the batch around that issue", async () => {
    const tracker = fakeTracker([issue("#1"), issue("#2")]);
    const P = policy();
    const opts = {
      limit: P.maxItems,
      budget: P.pointBudget,
      claimed: new Set<string>(),
    };
    const p = await run(tracker, catalog(), P, "1", opts, root, github);
    expect(p.anchor).toMatchObject({ kind: "issue", input: "#1" });
    expect(p.candidates.map((c) => c.identifier)).toEqual(["#1", "#2"]);
  });
});
