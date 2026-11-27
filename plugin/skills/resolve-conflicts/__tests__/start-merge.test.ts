/**
 * start-merge.ts against scratch repositories and a fake forge. A pull
 * request stacked on a branch that was squash-merged into its new base merges
 * with the point where it left that branch as the merge base, so the earlier
 * branch's changes do not conflict with their own squashed copy; a conflict
 * in the pull request's own changes still stops, with the merge open and
 * the base recorded. A pull request whose base was not squash-merged, or
 * whose forge cannot be read, merges as `git merge` does.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { earlierRef, landingOf } from "../scripts/lib/earlier-base.ts";
import { type Run, Scratch } from "./scratch.ts";

/**
 * A fake `gh`: answers the retarget and landing queries from the file
 * `FAKE_FORGE` names, `{"fail": true}` refusing every call.
 */
const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const forge = JSON.parse(readFileSync(process.env.FAKE_FORGE, "utf8"));
if (forge.fail) { console.error("HTTP 401: Bad credentials"); process.exit(1); }
const query = args.find((a) => a.startsWith("query=")) ?? "";
const rateLimit = { cost: 1, remaining: 4999, resetAt: new Date().toISOString(), limit: 5000 };
const repository = query.includes("EarlierBaseRetarget")
  ? { pullRequest: { baseRefName: "main", timelineItems: { nodes: forge.retargets ?? [] } } }
  : { pullRequests: { nodes: forge.landings ?? [] } };
console.log(JSON.stringify({ data: { rateLimit, repository } }));
`;

let s: Scratch;
let forgeFile: string;

beforeEach(() => {
  s = new Scratch("resolve-conflicts-start-merge-");
  const bin = join(s.home, "bin");
  mkdirSync(bin);
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  forgeFile = join(s.home, "forge.json");
  s.env.PATH = `${bin}${delimiter}${s.env.PATH ?? ""}`;
  s.env.HOME = s.home;
  s.env.FAKE_FORGE = forgeFile;
  s.env.JIG_FORGE_BUDGET = "off";
  s.env.JIG_HOME = join(s.home, "jig-home");
  delete s.env.DRIVE_PR_TARGET;
});
afterEach(() => s.cleanup());

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const file = (edits: Record<number, string> = {}) =>
  `${LINES.map((line, i) => edits[i + 1] ?? line).join("\n")}\n`;
const rev = (ref: string) => s.git("rev-parse", ref).trim();

interface Report {
  outcome: string;
  mode: string;
  mergeBase: string | null;
  earlierBase: { ref: string; pr: number; tip: string } | null;
  detection: string | null;
  conflicts: string[];
}

function startMerge(code: number, ...extra: string[]): Report {
  const r: Run = s.script("start-merge.ts", [
    "--base",
    "main",
    "--remote",
    "origin",
    "--pr",
    "7",
    "--json",
    ...extra,
  ]);
  expectSpawnExit({ ...r, exitCode: r.code }, code);
  return JSON.parse(r.stdout);
}

function forge(value: unknown): void {
  writeFileSync(forgeFile, JSON.stringify(value));
}

/** The forge's record of #7 retargeted from `stack` onto main after #6 landed `stack`. */
function retargetedAfter(landed: string, tip: string): void {
  forge({
    retargets: [
      {
        previousRefName: "stack",
        currentRefName: "main",
        createdAt: "2026-11-01T00:00:00Z",
      },
    ],
    landings: [
      {
        number: 6,
        headRefOid: tip,
        mergedAt: "2026-11-01T00:00:00Z",
        mergeCommit: { oid: landed },
      },
    ],
  });
}

/**
 * main holds the file; `stack` (pull request #6) changes line 2 in two
 * commits; `feature` (#7), built on `stack`, changes line 2 again and adds a
 * file; main then changes line 18 and squash-merges `stack`. Returns the
 * squashed commit and `stack`'s tip.
 */
function stackedOnSquashed(featureEdits: Record<number, string> = {}): {
  landed: string;
  tip: string;
} {
  s.commit("Add the file", { "f.txt": file() });
  s.git("checkout", "-q", "-b", "stack");
  s.commit("Stack: first", { "f.txt": file({ 2: "stack 2" }) });
  const tip = s.commit("Stack: second", {
    "f.txt": file({ 2: "stack 2", 3: "stack 3" }),
  });
  s.git("checkout", "-q", "-b", "feature");
  s.commit("Feature", {
    "f.txt": file({ 2: "feature 2", 3: "stack 3", ...featureEdits }),
    "g.txt": "feature\n",
  });
  s.git("checkout", "-q", "main");
  s.commit("Main work", { "f.txt": file({ 18: "main 18" }) });
  s.git("merge", "-q", "--squash", "stack");
  const landed = s.commit("Stack (#6)");
  s.git("update-ref", "refs/remotes/origin/main", "main");
  s.git("checkout", "-q", "feature");
  return { landed, tip };
}

describe("a pull request whose base was squash-merged", () => {
  it("merges without the echo conflicts, recording the merge base", () => {
    const { landed, tip } = stackedOnSquashed();
    // git's own merge base sees the squashed changes on both sides.
    expect(
      s.gitTry("merge-tree", "--write-tree", "HEAD", "origin/main").code,
    ).toBe(1);
    retargetedAfter(landed, tip);
    const feature = rev("HEAD");

    const r = startMerge(0);

    expect(r.outcome).toBe("merged");
    expect(r.mode).toBe("earlier-base");
    expect(r.mergeBase).toBe(tip);
    expect(r.earlierBase).toMatchObject({ ref: "stack", pr: 6, tip });
    expect(s.git("log", "-1", "--format=%P").trim()).toBe(
      `${feature} ${rev("main")}`,
    );
    expect(s.read("f.txt")).toBe(
      file({ 2: "feature 2", 3: "stack 3", 18: "main 18" }),
    );
    expect(s.read("g.txt")).toBe("feature\n");
    const message = s.git("log", "-1", "--format=%B");
    expect(message).toContain("Merge remote-tracking branch 'origin/main'");
    expect(message).toContain(`Merge-base: ${tip}`);
    expect(s.git("status", "--porcelain")).toBe("");
  });

  it("stops on a conflict in the pull request's own changes, the merge open and its base mapped", () => {
    const { landed, tip } = stackedOnSquashed({ 18: "feature 18" });
    retargetedAfter(landed, tip);

    const r = startMerge(9);

    expect(r.outcome).toBe("conflicts");
    expect(r.mode).toBe("earlier-base");
    expect(r.conflicts).toEqual(["f.txt"]);
    expect(rev("MERGE_HEAD")).toBe(rev("main"));
    const merged = s.read("f.txt");
    expect(merged).toContain("<<<<<<< HEAD");
    expect(merged).toContain(">>>>>>> origin/main");
    // Only line 18 conflicts: line 2's echo merged.
    expect(merged.match(/<<<<<<< /g)?.length).toBe(1);
    expect(merged).toContain("feature 2");

    const map = s.script("conflict-map.ts", ["--json"]);
    expectSpawnExit({ ...map, exitCode: map.code }, 0);
    expect(s.snapshot().operation).toMatchObject({ base: tip });

    s.git("merge", "--abort");
    expect(s.git("status", "--porcelain")).toBe("");
  });

  it("concludes a conflict beside an echo in another file through record and check", () => {
    s.commit("Add the files", { "f.txt": file(), "e.txt": "echo\n" });
    s.git("checkout", "-q", "-b", "stack");
    const tip = s.commit("Stack", { "e.txt": "stack\n" });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", {
      "e.txt": "feature\n",
      "f.txt": file({ 18: "feature 18" }),
    });
    s.git("checkout", "-q", "main");
    s.commit("Main work", { "f.txt": file({ 18: "main 18" }) });
    s.git("merge", "-q", "--squash", "stack");
    const landed = s.commit("Stack (#6)");
    s.git("update-ref", "refs/remotes/origin/main", "main");
    s.git("checkout", "-q", "feature");
    retargetedAfter(landed, tip);

    expect(startMerge(9).conflicts).toEqual(["f.txt"]);
    expect(s.read("e.txt")).toBe("feature\n");
    const map = s.script("conflict-map.ts", ["--json"]);
    expectSpawnExit({ ...map, exitCode: map.code }, 0);
    s.write("f.txt", file({ 18: "feature 18\nmain 18" }));
    s.git("add", "f.txt");
    const recorded = s.script("record.ts", [
      "f.txt",
      "combined",
      "--reason",
      "keeps both sides' line 18",
    ]);
    expectSpawnExit({ ...recorded, exitCode: recorded.code }, 0);
    const check = s.script("check-resolution.ts", ["--commit-message"]);
    expectSpawnExit({ ...check, exitCode: check.code }, 0);
    expect(check.stdout).toContain(`Merge-base: ${tip}`);
  });

  it("merges as git does when the earlier base's last commit cannot be fetched", () => {
    const { landed } = stackedOnSquashed();
    retargetedAfter(landed, "0".repeat(40));

    const r = startMerge(9);

    expect(r.mode).toBe("git");
    expect(r.detection).toContain("could not be fetched");
    expect(r.earlierBase).toMatchObject({ ref: "stack", pr: 6 });
  });

  it("merges as git does when the forge cannot be read", () => {
    stackedOnSquashed();
    forge({ fail: true });

    const r = startMerge(9);

    expect(r.mode).toBe("git");
    expect(r.detection).toContain("forge could not say");
    expect(r.conflicts).toEqual(["f.txt"]);
  });
});

describe("a pull request whose base was not squash-merged", () => {
  it("merges as before when it was never retargeted", () => {
    s.commit("Add the file", { "f.txt": file() });
    s.git("checkout", "-q", "-b", "feature");
    const feature = s.commit("Feature", { "f.txt": file({ 2: "feature 2" }) });
    s.git("checkout", "-q", "main");
    s.commit("Main work", { "f.txt": file({ 18: "main 18" }) });
    s.git("update-ref", "refs/remotes/origin/main", "main");
    s.git("checkout", "-q", "feature");
    const expected = s
      .git("merge-tree", "--write-tree", "HEAD", "origin/main")
      .trim();
    forge({ retargets: [] });

    const r = startMerge(0);

    expect(r).toMatchObject({
      outcome: "merged",
      mode: "git",
      mergeBase: null,
    });
    expect(r.detection).toContain("was not retargeted");
    expect(s.git("log", "-1", "--format=%P").trim()).toBe(
      `${feature} ${rev("main")}`,
    );
    expect(rev("HEAD^{tree}")).toBe(expected);
  });

  it("merges as before when the earlier base landed with a merge commit", () => {
    s.commit("Add the file", { "f.txt": file() });
    s.git("checkout", "-q", "-b", "stack");
    const tip = s.commit("Stack", { "f.txt": file({ 2: "stack 2" }) });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", { "f.txt": file({ 2: "feature 2" }) });
    s.git("checkout", "-q", "main");
    s.commit("Main work", { "f.txt": file({ 18: "main 18" }) });
    s.git("merge", "-q", "--no-ff", "--no-edit", "stack");
    s.git("update-ref", "refs/remotes/origin/main", "main");
    s.git("checkout", "-q", "feature");
    retargetedAfter(rev("main"), tip);

    const r = startMerge(0);

    expect(r).toMatchObject({ outcome: "merged", mode: "git" });
    expect(r.detection).toContain("already excludes them");
    expect(s.read("f.txt")).toBe(file({ 2: "feature 2", 18: "main 18" }));
  });

  it("stops on a real conflict as git merge does, with git's own base", () => {
    s.commit("Add the file", { "f.txt": file() });
    const base = rev("HEAD");
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", { "f.txt": file({ 2: "feature 2" }) });
    s.git("checkout", "-q", "main");
    s.commit("Main work", { "f.txt": file({ 2: "main 2" }) });
    s.git("update-ref", "refs/remotes/origin/main", "main");
    s.git("checkout", "-q", "feature");
    forge({ retargets: [] });

    const r = startMerge(9);

    expect(r).toMatchObject({ outcome: "conflicts", mode: "git" });
    expect(s.read("f.txt")).toContain("||||||| ");
    const map = s.script("conflict-map.ts", ["--json"]);
    expectSpawnExit({ ...map, exitCode: map.code }, 0);
    expect(s.snapshot().operation).toMatchObject({ base });
  });
});

describe("refusals", () => {
  it("refuses while another operation is open, touching nothing", () => {
    const { landed, tip } = stackedOnSquashed({ 18: "feature 18" });
    retargetedAfter(landed, tip);
    startMerge(9);
    const merged = s.read("f.txt");

    const r = startMerge(3);

    expect(r.outcome).toBe("refused");
    expect(r.detection).toBeNull();
    expect(s.read("f.txt")).toBe(merged);
  });

  it("refuses staged changes before merging with the earlier base", () => {
    const { landed, tip } = stackedOnSquashed();
    retargetedAfter(landed, tip);
    s.write("g.txt", "staged\n");
    s.git("add", "g.txt");

    const r = startMerge(3);

    expect(r).toMatchObject({ outcome: "refused", mode: "earlier-base" });
    expect(
      s.gitTry("rev-parse", "--verify", "--quiet", "MERGE_HEAD").code,
    ).toBe(1);
  });
});

describe("reading the forge's answers", () => {
  const oid = (digit: string) => digit.repeat(40);
  const timeline = (nodes: unknown[]) => ({
    data: { repository: { pullRequest: { timelineItems: { nodes } } } },
  });

  it("takes the latest retarget onto the base", () => {
    expect(
      earlierRef(
        timeline([
          { previousRefName: "a", currentRefName: "main" },
          { previousRefName: "main", currentRefName: "b" },
          { previousRefName: "b", currentRefName: "main" },
        ]),
        "main",
      ),
    ).toBe("b");
    expect(earlierRef(timeline([]), "main")).toBeNull();
    expect(earlierRef({ data: null }, "main")).toBeNull();
  });

  it("takes the most recently merged landing that names both commits", () => {
    const answer = {
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 3,
                headRefOid: oid("a"),
                mergedAt: "2026-10-01T00:00:00Z",
                mergeCommit: { oid: oid("1") },
              },
              {
                number: 4,
                headRefOid: oid("b"),
                mergedAt: "2026-11-01T00:00:00Z",
                mergeCommit: { oid: oid("2") },
              },
              {
                number: 5,
                headRefOid: oid("c"),
                mergedAt: "2026-12-01T00:00:00Z",
                mergeCommit: null,
              },
            ],
          },
        },
      },
    };
    expect(landingOf(answer)).toEqual({
      pr: 4,
      tip: oid("b"),
      landed: oid("2"),
    });
    expect(landingOf({ data: {} })).toBeNull();
    const nodes = answer.data.repository.pullRequests.nodes;
    const notAnId = {
      data: {
        repository: {
          pullRequests: {
            nodes: nodes.map((node) =>
              node.number === 4 ? { ...node, headRefOid: "HEAD~1" } : node,
            ),
          },
        },
      },
    };
    expect(landingOf(notAnId)).toEqual({
      pr: 3,
      tip: oid("a"),
      landed: oid("1"),
    });
  });
});
