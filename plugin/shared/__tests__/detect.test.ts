/**
 * The detector: each value it finds comes back as a fact with the field, the
 * value and the evidence it was read from, and the command lines it reads are
 * split as a shell splits them. The audit's configuration-fit tests run the
 * same detection end to end in scratch repositories.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeAreasCatalog,
  commandSegments,
  gateCommand,
  issueKeyTeam,
  stackedPulls,
  stacking,
} from "../detect.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding `files`. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "detect-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
}

describe("command lines", () => {
  test("split on operators outside quotes", () => {
    expect(
      commandSegments(`FOO=1 bun run a && echo "x && y" | wc; make b`),
    ).toEqual([
      ["FOO=1", "bun", "run", "a"],
      ["echo", "x && y"],
      ["wc"],
      ["make", "b"],
    ]);
  });
});

describe("facts", () => {
  test("the gate command names the package script and the lockfile's manager", () => {
    const dir = scratch({
      "package.json": '{"scripts":{"test":"x","check":"y"}}',
      "pnpm-lock.yaml": "",
    });
    expect(gateCommand(dir, ["package.json", "pnpm-lock.yaml"])).toEqual({
      field: "gates.command",
      value: "pnpm run check",
      evidence: [
        'package.json defines a "check" script, and pnpm-lock.yaml makes pnpm its package manager',
      ],
    });
    expect(gateCommand(scratch({}), [])).toBeNull();
  });

  test("a change-area catalog outside fixtures and templates", () => {
    expect(
      changeAreasCatalog([
        "fixtures/change-areas.yaml",
        "README.md",
        ".config/change-areas.yaml",
      ]),
    ).toEqual({
      field: "drive.change_areas_catalog",
      value: ".config/change-areas.yaml",
      evidence: [
        ".config/change-areas.yaml is tracked and named like a change-area catalog",
      ],
    });
    expect(changeAreasCatalog(["templates/change-areas.yml"])).toBeNull();
  });

  test("the issue-key team a majority of the keys carry", () => {
    const team = issueKeyTeam([
      {
        label: "the last 4 merged pull requests",
        keys: ["ENG", "ENG", "OPS", undefined],
      },
      { label: "the last 2 commit subjects on HEAD", keys: ["ENG", undefined] },
    ]);
    expect(team).toEqual({
      field: "issue_tracker.team",
      value: "ENG",
      evidence: [
        "ENG-<n> issue keys in 2 of the last 4 merged pull requests, 1 of the last 2 commit subjects on HEAD (1 key(s) of other teams)",
      ],
    });
    expect(
      issueKeyTeam([
        { label: "the last 2 merged pull requests", keys: ["ENG", "ENG"] },
      ]),
    ).toBeNull();
  });

  test("open pull requests based on another's branch are stacked", () => {
    const pulls = [
      { number: 1, baseRefName: "main", headRefName: "one" },
      { number: 2, baseRefName: "one", headRefName: "two" },
      { number: 3, baseRefName: "release", headRefName: "fix" },
    ];
    const { stacked, unresolved } = stackedPulls(pulls, "main");
    expect(stacked.map((p) => p.number)).toEqual([2]);
    expect(unresolved).toEqual([]);
    expect(stacking("main", stacked)).toMatchObject({
      field: "pull_requests.stacking",
      value: "branch",
      evidence: [expect.stringContaining("#2 → one")],
    });
  });
});
