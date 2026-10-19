import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type Run, Scratch } from "./scratch.ts";

let s: Scratch;
const ok = (r: Run, code = 0) =>
  expectSpawnExit({ ...r, exitCode: r.code }, code);
beforeEach(() => {
  s = new Scratch();
});
afterEach(() => s.cleanup());

function stopped(kind = "merge"): void {
  const lines = "first\na\nb\nc\nd\ne\nlast\n";
  s.commit("Base", {
    "conflict.txt": "base\n",
    "clean.txt": lines,
    "stable.txt": "stable\n",
    "removed.txt": "remove\n",
    "old.txt": "rename\n",
    "ours-only.txt": "base\n",
  });
  s.git("checkout", "-q", "-b", "feature");
  s.commit("Feature", {
    "conflict.txt": "feature\n",
    "clean.txt": lines.replace("first", "feature"),
    "ours-only.txt": "feature\n",
  });
  s.git("checkout", "-q", "main");
  s.write("conflict.txt", "main\n");
  s.write("clean.txt", lines.replace("last", "main"));
  s.git("rm", "removed.txt");
  s.git("mv", "old.txt", "new.txt");
  s.commit("Main");
  s.git("checkout", "-q", "feature");
  ok(s.gitTry(kind, "main"), 1);
}
function resolve(): void {
  s.write("conflict.txt", "feature\nmain\n");
  s.git("add", "conflict.txt");
  ok(s.script("record.ts", ["conflict.txt", "combined"]));
}
function map(): void {
  ok(s.script("conflict-map.ts"));
}
function check(code = 0): Run {
  const r = s.script("check-resolution.ts", ["--json"]);
  ok(r, code);
  return r;
}

describe("staged content provenance", () => {
  it("accepts automatic combinations, deletions and renames", () => {
    stopped();
    map();
    resolve();
    check();
  });
  for (const timing of ["before", "after"]) {
    it(`rejects an unrelated staged addition made ${timing} mapping`, () => {
      stopped();
      if (timing === "after") map();
      s.write("unrelated.txt", "unrelated\n");
      s.git("add", "unrelated.txt");
      if (timing === "before") map();
      resolve();
      expect(check(1).stdout).toContain("outside this operation");
    });
  }
  it("rejects an unrelated staged deletion", () => {
    stopped();
    map();
    resolve();
    s.git("rm", "stable.txt");
    expect(check(1).stdout).toContain("stable.txt");
  });
  it("requires a recorded decision for an edit to an automatically merged file", () => {
    stopped();
    map();
    resolve();
    s.write("clean.txt", `${s.read("clean.txt")}manual\n`);
    s.git("add", "clean.txt");
    expect(check(1).stdout).toContain("no decision recorded");
    ok(s.script("record.ts", ["clean.txt", "combined"]));
    check();
  });
  it("checks modes as well as blobs", () => {
    stopped();
    map();
    resolve();
    s.git("update-index", "--chmod=+x", "clean.txt");
    expect(check(1).stdout).toContain("clean.txt");
  });
  it("rejects restoring an automatic deletion without a decision", () => {
    stopped();
    map();
    resolve();
    s.write("removed.txt", "remove\n");
    s.git("add", "removed.txt");
    expect(check(1).stdout).toContain("removed.txt");
  });
  it("rejects an unrelated staged file during a replay", () => {
    stopped("rebase");
    map();
    resolve();
    s.write("unrelated.txt", "unrelated\n");
    s.git("add", "unrelated.txt");
    expect(check(1).stdout).toContain("outside this operation");
  });
  it("refuses to record an unrelated path as a resolution", () => {
    stopped();
    map();
    s.write("unrelated.txt", "unrelated\n");
    s.git("add", "unrelated.txt");
    const r = s.script("record.ts", [
      "unrelated.txt",
      "rewritten",
      "--reason",
      "unrelated work",
    ]);
    ok(r, 2);
    expect(r.stderr).toContain("outside this operation");
  });
  it("requires a decision even when a clean file was edited before mapping", () => {
    stopped();
    s.write("clean.txt", `${s.read("clean.txt")}manual\n`);
    s.git("add", "clean.txt");
    map();
    resolve();
    expect(check(1).stdout).toContain("no decision recorded");
  });
  it("permits an explicit decision for a path changed only by ours", () => {
    stopped();
    map();
    resolve();
    s.write("ours-only.txt", "replacement\n");
    s.git("add", "ours-only.txt");
    expect(check(1).stdout).toContain("no decision recorded");
    ok(
      s.script("record.ts", [
        "ours-only.txt",
        "rewritten",
        "--reason",
        "adapt the feature",
      ]),
    );
    check();
  });
  it("requires a decision for an edit to an automatic rename destination", () => {
    stopped();
    map();
    resolve();
    s.write("new.txt", "rename\nmanual\n");
    s.git("add", "new.txt");
    expect(check(1).stdout).toContain("new.txt");
    ok(s.script("record.ts", ["new.txt", "combined"]));
    check();
  });
  it("reconstructs a cherry-pick using the incoming parent", () => {
    stopped("cherry-pick");
    map();
    resolve();
    check();
    s.write("unrelated.txt", "unrelated\n");
    s.git("add", "unrelated.txt");
    expect(check(1).stdout).toContain("outside this operation");
  });
  it("reconstructs a revert using the reverted commit as base", () => {
    s.commit("Initial", {
      "conflict.txt": "base\n",
      "clean.txt": "base\n",
    });
    s.commit("Change", { "conflict.txt": "change\n", "clean.txt": "change\n" });
    const incoming = s.git("rev-parse", "HEAD").trim();
    s.commit("Later", { "conflict.txt": "later\n" });
    ok(s.gitTry("revert", "--no-edit", incoming), 1);
    map();
    s.write("conflict.txt", "later\n");
    s.git("add", "conflict.txt");
    ok(
      s.script("record.ts", [
        "conflict.txt",
        "rewritten",
        "--reason",
        "preserve the later replacement",
      ]),
    );
    check();
  });
  it("maps the actual parents when recreating a merge during rebase", () => {
    s.commit("Base", { "conflict.txt": "base\n", "stable.txt": "stable\n" });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Feature", { "conflict.txt": "feature\n" });
    s.git("checkout", "-q", "-b", "side", "main");
    s.commit("Side", { "conflict.txt": "side\n", "clean.txt": "side\n" });
    s.git("checkout", "-q", "feature");
    ok(s.gitTry("merge", "side"), 1);
    s.commit("Combine", { "conflict.txt": "feature\nside\n" });
    const originalMerge = s.git("rev-parse", "HEAD").trim();
    s.git("checkout", "-q", "main");
    s.commit("Upstream", { "upstream.txt": "upstream\n" });
    s.git("checkout", "-q", "feature");
    ok(s.gitTry("rebase", "--rebase-merges", "main"), 1);
    const mergeHead = s.git("rev-parse", "MERGE_HEAD").trim();
    const mapped = s.script("conflict-map.ts", ["--json"]);
    ok(mapped);
    const snapshot = JSON.parse(mapped.stdout);
    expect(snapshot.operation.kind).toBe("rebase");
    expect(snapshot.sides.theirs.commit).toBe(mergeHead);
    expect(snapshot.sides.theirs.commit).not.toBe(originalMerge);
    expect(snapshot.operation.base).toBe(
      s.git("merge-base", "HEAD", mergeHead).trim(),
    );
    s.write("conflict.txt", "feature\nside\n");
    s.git("add", "conflict.txt");
    ok(s.script("record.ts", ["conflict.txt", "combined"]));
    check();
    s.write("unrelated.txt", "unrelated\n");
    s.git("add", "unrelated.txt");
    expect(check(1).stdout).toContain("outside this operation");
  });
  it("reconstructs a revert of the root commit", () => {
    const root = s.commit("Root", {
      "conflict.txt": "base\n",
      "clean.txt": "base\n",
    });
    s.commit("Later", { "conflict.txt": "later\n" });
    ok(s.gitTry("revert", "--no-edit", root), 1);
    map();
    s.git("rm", "conflict.txt");
    ok(
      s.script("record.ts", [
        "conflict.txt",
        "deleted",
        "--reason",
        "remove the root content",
      ]),
    );
    check();
  });

  for (const operation of ["cherry-pick", "revert"]) {
    it(`refuses ${operation} of a merge commit when the mainline cannot be proven`, () => {
      s.commit("Base", { "conflict.txt": "base\n", "clean.txt": "base\n" });
      s.git("checkout", "-q", "-b", "side");
      s.commit("Side", { "conflict.txt": "side\n", "clean.txt": "side\n" });
      s.git("checkout", "-q", "main");
      s.commit("Main", { "conflict.txt": "main\n", "clean.txt": "main\n" });
      ok(s.gitTry("merge", "side"), 1);
      const incoming = s.commit("Combine", {
        "conflict.txt": "combined\n",
        "clean.txt": "combined\n",
      });
      if (operation === "cherry-pick")
        s.git("checkout", "-q", "-b", "target", "side");
      s.commit("Later", { "conflict.txt": "later\n" });
      ok(s.gitTry(operation, "-m", "2", incoming), 1);
      const mapped = s.script("conflict-map.ts");
      ok(mapped, 3);
      expect(mapped.stderr).toContain("mainline");
      expect(mapped.stderr).toContain("unsupported");
    });
  }
});
