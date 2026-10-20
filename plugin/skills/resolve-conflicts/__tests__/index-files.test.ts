/**
 * readIndexFile against real scratch repositories: the file a read opens in
 * the index, links followed through the index's own entries and `/` the only
 * separator.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { readIndexFile } from "../scripts/lib/index-files.ts";
import { CONFIG_BASE, mergeConflict, Scratch } from "./scratch.ts";

let s: Scratch;
beforeEach(() => {
  s = new Scratch();
});
afterEach(() => s.cleanup());

function read(path: string) {
  return readIndexFile(s.root, path);
}

describe("readIndexFile", () => {
  it("reads the staged content, not the working tree's", () => {
    s.commit("Add a file", { "a.txt": "committed\n" });
    s.write("a.txt", "edited\n");
    expect(read("a.txt")).toEqual({ found: "file", text: "committed\n" });
    s.git("add", "a.txt");
    expect(read("a.txt")).toEqual({ found: "file", text: "edited\n" });
  });

  it("is absent for a file that is only on disk or in no directory", () => {
    s.commit("Add a file", { "a.txt": "x\n" });
    s.write("b.txt", "untracked\n");
    expect(read("b.txt")).toEqual({ found: "absent" });
    expect(read("missing/inside")).toEqual({ found: "absent" });
  });

  it("reads through directories only", () => {
    s.commit("Add files", { "a.txt": "x\n", "policy.yaml": "p\n" });
    symlinkSync("a.txt/../policy.yaml", `${s.root}/through-file`);
    symlinkSync("missing/../policy.yaml", `${s.root}/through-missing`);
    s.git("add", "through-file", "through-missing");
    expect(read("a.txt/inside")).toEqual({
      found: "unreadable",
      reason: "a.txt/inside reads through a.txt, which is not a directory",
    });
    expect(read("a.txt/../policy.yaml")).toMatchObject({ found: "unreadable" });
    expect(read("through-file")).toMatchObject({ found: "unreadable" });
    expect(read("missing/../policy.yaml")).toEqual({ found: "absent" });
    expect(read("through-missing")).toEqual({ found: "absent" });
  });

  it("cannot read a directory, named or reached through a link", () => {
    s.commit("Add a directory", { ".config/jig.yaml/inner": "x\n" });
    symlinkSync(".config/jig.yaml", `${s.root}/to-dir`);
    s.git("add", "to-dir");
    expect(read(".config/jig.yaml")).toEqual({
      found: "unreadable",
      reason: ".config/jig.yaml is a directory",
    });
    expect(read("to-dir")).toMatchObject({ found: "unreadable" });
    expect(read(".config/jig.yaml/.")).toMatchObject({ found: "unreadable" });
  });

  it("keeps a trailing `/` or `.` a requirement for a directory", () => {
    s.commit("Add a file", { "policy.yaml": "p\n" });
    symlinkSync("policy.yaml/", `${s.root}/slash-link`);
    s.git("add", "slash-link");
    for (const path of ["policy.yaml/", "policy.yaml/.", "slash-link"])
      expect(read(path)).toEqual({
        found: "unreadable",
        reason: `${path} reads through policy.yaml, which is not a directory`,
      });
    expect(read("./policy.yaml")).toEqual({ found: "file", text: "p\n" });
  });

  it("follows links through the index, directories included", () => {
    s.commit("Add files", {
      "config/nested/keep": "",
      "config/defs.yaml": "d\n",
    });
    symlinkSync("config/nested", `${s.root}/cfg`);
    symlinkSync("cfg/../defs.yaml", `${s.root}/link`);
    s.git("add", "cfg", "link");
    expect(read("link")).toEqual({ found: "file", text: "d\n" });
    expect(read("cfg/../defs.yaml")).toEqual({ found: "file", text: "d\n" });
  });

  it.skipIf(process.platform === "win32")(
    "takes a backslash as part of a name",
    () => {
      s.commit("Add files", { "dir\\name/keep": "", "target.yaml": "t\n" });
      symlinkSync("../target.yaml", `${s.root}/dir\\name/link.yaml`);
      s.git("add", "dir\\name/link.yaml");
      expect(read("dir\\name/link.yaml")).toEqual({
        found: "file",
        text: "t\n",
      });
    },
  );

  it("refuses a link that leaves the repository, loops, or reaches no regular file", () => {
    s.commit("Add a file", { "a.txt": "x\n" });
    symlinkSync("/etc/hosts", `${s.root}/abs`);
    symlinkSync("../outside", `${s.root}/up`);
    symlinkSync("loop2", `${s.root}/loop1`);
    symlinkSync("loop1", `${s.root}/loop2`);
    s.git("add", "abs", "up", "loop1", "loop2");
    expect(read("abs")).toMatchObject({ found: "unreadable" });
    expect(read("up")).toMatchObject({
      found: "unreadable",
      reason: "up leaves the repository",
    });
    expect(read("loop1")).toMatchObject({ found: "unreadable" });
    expect(read("a.txt/..")).toMatchObject({ found: "unreadable" });
  });

  it("cannot read through an index link with an empty target", () => {
    s.commit("Add a file", { "policy.yaml": "p\n" });
    const empty = s.git("hash-object", "-w", "/dev/null").trim();
    s.git("update-index", "--add", "--cacheinfo", `120000,${empty},cfg`);
    expect(read("cfg/policy.yaml")).toEqual({
      found: "unreadable",
      reason: "cfg is a link with no target",
    });
  });

  it("reports a file under a conflicted link as unmerged", () => {
    s.commit("Add targets", { "a/x.yaml": "a\n", "b/x.yaml": "b\n" });
    symlinkSync("a", `${s.root}/cfg`);
    s.commit("Link cfg to a");
    s.git("checkout", "-q", "-b", "feature");
    s.git("rm", "-q", "--cached", "cfg");
    rmSync(`${s.root}/cfg`);
    symlinkSync("b", `${s.root}/cfg`);
    s.commit("Link cfg to b");
    s.git("checkout", "-q", "main");
    s.git("rm", "-q", "--cached", "cfg");
    rmSync(`${s.root}/cfg`);
    symlinkSync("..", `${s.root}/cfg`);
    s.commit("Link cfg to the root");
    expect(s.gitTry("merge", "feature").code).not.toBe(0);
    expect(read("cfg/x.yaml")).toEqual({ found: "unmerged", path: "cfg" });
  });

  it("reports a path that is only conflict stages as unmerged", () => {
    mergeConflict(s);
    expect(read("src/config.ts")).toEqual({
      found: "unmerged",
      path: "src/config.ts",
    });
    s.write("src/config.ts", CONFIG_BASE);
    s.git("add", "src/config.ts");
    expect(read("src/config.ts")).toEqual({
      found: "file",
      text: CONFIG_BASE,
    });
  });
});
