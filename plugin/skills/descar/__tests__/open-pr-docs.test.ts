import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  CensusError,
  docsPrefix,
  openPrDocs,
  PR_LIST_LIMIT,
  type RunResult,
  type Runner,
} from "../scripts/open-pr-docs.ts";

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: "" });
const err = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });

function runner(opts: {
  branch?: RunResult;
  view?: RunResult;
  list?: RunResult;
  top?: RunResult;
}): Runner & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((command: string, args: string[]) => {
    calls.push(`${command} ${args.slice(0, 2).join(" ")}`);
    if (command === "git" && args[0] === "rev-parse")
      return opts.top ?? ok(`${process.cwd()}\n`);
    if (command === "git") return opts.branch ?? ok("feature/x\n");
    if (args[1] === "view") return opts.view ?? ok("7\n");
    return opts.list ?? ok("[]");
  }) as Runner & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const pr = (number: number, paths: string[], changedFiles = paths.length) => ({
  number,
  changedFiles,
  files: paths.map((path) => ({ path })),
});

describe("open-pr-docs", () => {
  it("lists docs paths changed by other pull requests, unique and sorted", () => {
    const list = ok(
      JSON.stringify([
        pr(3, ["docs/b.md", "src/a.ts", "docs/a.md"]),
        pr(4, ["docs/a.md"]),
      ]),
    );
    expect(openPrDocs("docs", runner({ list }))).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
  });

  it("leaves out the current pull request's own documents", () => {
    const list = ok(
      JSON.stringify([pr(7, ["docs/mine.md"]), pr(3, ["docs/theirs.md"])]),
    );
    expect(openPrDocs("docs", runner({ list }))).toEqual(["docs/theirs.md"]);
  });

  it("treats a branch without a pull request as having none", () => {
    const view = err('no pull requests found for branch "feature/x"');
    const list = ok(JSON.stringify([pr(7, ["docs/a.md"])]));
    expect(openPrDocs("docs", runner({ view, list }))).toEqual(["docs/a.md"]);
  });

  it("aborts on any other failure to resolve the current pull request", () => {
    expect(() => openPrDocs("docs", runner({ view: err("HTTP 401") }))).toThrow(
      CensusError,
    );
  });

  it("counts every pull request as another one in detached HEAD", () => {
    const r = runner({
      branch: ok("\n"),
      list: ok(JSON.stringify([pr(7, ["docs/a.md"])])),
    });
    expect(openPrDocs("docs", r)).toEqual(["docs/a.md"]);
    expect(r.calls.some((call) => call.startsWith("gh pr view"))).toBe(false);
  });

  it("aborts when the open pull requests cannot be listed", () => {
    expect(() =>
      openPrDocs(
        "docs",
        runner({ list: { status: null, stdout: "", stderr: "" } }),
      ),
    ).toThrow(/could not list open pull requests/);
  });

  it("aborts when another pull request's file list is truncated", () => {
    const list = ok(JSON.stringify([pr(3, ["docs/a.md"], 150)]));
    expect(() => openPrDocs("docs", runner({ list }))).toThrow(/#3/);
  });

  it("does not abort when only the current pull request is truncated", () => {
    const list = ok(
      JSON.stringify([pr(7, ["docs/a.md"], 150), pr(3, ["docs/b.md"])]),
    );
    expect(openPrDocs("docs", runner({ list }))).toEqual(["docs/b.md"]);
  });

  it("aborts when the open pull request list reaches the limit", () => {
    const prs = Array.from({ length: PR_LIST_LIMIT }, (_, i) =>
      pr(i + 100, ["src/a.ts"]),
    );
    expect(() =>
      openPrDocs("docs", runner({ list: ok(JSON.stringify(prs)) })),
    ).toThrow(/incomplete census/);
  });

  it("aborts on output it cannot parse", () => {
    expect(() => openPrDocs("docs", runner({ list: ok("not json") }))).toThrow(
      CensusError,
    );
  });

  it("honours another docs root", () => {
    const list = ok(JSON.stringify([pr(3, ["doc/a.md", "docs/b.md"])]));
    expect(openPrDocs("doc/", runner({ list }))).toEqual(["doc/a.md"]);
  });

  it("aborts on a parseable entry without a valid file count", () => {
    for (const entry of [
      { number: 3, files: [] },
      { number: 3, changedFiles: null, files: [] },
      { number: 3, changedFiles: -1, files: [] },
      { number: 3, changedFiles: 1.5, files: [{ path: "docs/a.md" }] },
    ]) {
      const list = ok(JSON.stringify([entry]));
      expect(() => openPrDocs("docs", runner({ list }))).toThrow(/malformed/);
    }
  });

  it("aborts on a parseable entry without an integer number or string paths", () => {
    for (const entry of [
      { changedFiles: 0, files: [] },
      { number: "3", changedFiles: 0, files: [] },
      { number: 3, changedFiles: 1, files: [{ path: 4 }] },
      { number: 3, changedFiles: 1, files: [{}] },
      { number: 3, changedFiles: 1, files: "docs/a.md" },
      null,
    ]) {
      const list = ok(JSON.stringify([entry]));
      expect(() => openPrDocs("docs", runner({ list }))).toThrow(/malformed/);
    }
  });

  it("aborts when the repository root cannot be found", () => {
    expect(() =>
      openPrDocs("docs", runner({ top: err("not a git repository") })),
    ).toThrow(/repository root/);
  });

  it("matches gh's repository-relative paths for a ./ docs root", () => {
    const list = ok(JSON.stringify([pr(3, ["docs/a.md", "src/b.ts"])]));
    expect(openPrDocs("./docs", runner({ list }))).toEqual(["docs/a.md"]);
  });
});

describe("docsPrefix", () => {
  const top = "/repo";
  it("normalizes relative roots to a repository-relative prefix", () => {
    expect(docsPrefix("docs", top, top)).toBe("docs/");
    expect(docsPrefix("./docs", top, top)).toBe("docs/");
    expect(docsPrefix("docs/", top, top)).toBe("docs/");
    expect(docsPrefix("docs//guides/", top, top)).toBe("docs/guides/");
    expect(docsPrefix("docs\\guides", top, top)).toBe("docs/guides/");
  });

  it("resolves a relative root against the working directory", () => {
    expect(docsPrefix("guides", top, join(top, "docs"))).toBe("docs/guides/");
  });

  it("accepts an absolute root inside the repository", () => {
    expect(docsPrefix(join(top, "docs"), top, "/elsewhere")).toBe("docs/");
  });

  it("treats the repository root as the whole repository", () => {
    expect(docsPrefix(".", top, top)).toBe("");
    expect(docsPrefix("", top, top)).toBe("");
    expect(docsPrefix(top, top, top)).toBe("");
  });

  it("rejects a root outside the repository", () => {
    for (const dir of ["..", "../docs", "/other/docs", "/repository"])
      expect(() => docsPrefix(dir, top, top)).toThrow(/outside the repository/);
  });
});
