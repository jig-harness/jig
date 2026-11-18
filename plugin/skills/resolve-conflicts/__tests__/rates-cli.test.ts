/**
 * history.ts --rates: the conflict rates of a scratch repository's merged
 * pull requests, read through a fake forge. A pull request whose branch
 * merged its base with a conflict counts as conflicted for every path it
 * changed; one the replay saw merge cleanly counts as clean; a commit pushed
 * straight to the branch belongs to no pull request. A listing the forge
 * refuses, or one cut at its bound, writes nothing, and a rates file already
 * there is kept.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { isoFromMs } from "../../../shared/time.ts";
import { Scratch } from "./scratch.ts";

let s: Scratch;
let forgeFile: string;

/**
 * A fake `gh`: the merged pull request listing from the file `FAKE_FORGE`
 * names. `{"fail": true}` refuses; `{"endless": true}` answers every page in
 * full, each pull request updated now, so the listing never reaches the
 * window's start.
 */
const FAKE_GH = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FORGE + ".calls", args.slice(0, 2).join(" ") + "\\n");
const forge = JSON.parse(readFileSync(process.env.FAKE_FORGE, "utf8"));
if (forge.fail) { console.error("HTTP 401: Bad credentials"); process.exit(1); }
const field = (name) => { const at = args.findIndex((a, i) => (args[i - 1] === "-F" || args[i - 1] === "-f") && a.startsWith(name + "=")); return at < 0 ? null : args[at].slice(name.length + 1); };
const first = Number(field("first"));
const after = field("after");
const start = after === null ? 0 : Number(after);
const now = new Date().toISOString();
const nodes = forge.endless
  ? Array.from({ length: first }, (_, i) => ({ ...forge.template, number: start + i + 1, updatedAt: now, mergedAt: now }))
  : forge.nodes.slice(start, start + first);
const end = start + nodes.length;
console.log(JSON.stringify({ data: {
  rateLimit: { cost: 1, remaining: 4999, resetAt: now, limit: 5000 },
  repository: {
    nameWithOwner: "acme/widgets",
    defaultBranchRef: { name: "main" },
    pullRequests: { pageInfo: { hasNextPage: forge.endless || end < forge.nodes.length, endCursor: String(end) }, nodes },
  },
} }));
`;

beforeEach(() => {
  s = new Scratch("resolve-conflicts-rates-");
  const bin = join(s.home, "bin");
  mkdirSync(bin);
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  forgeFile = join(s.home, "forge.json");
  s.env.PATH = `${bin}${delimiter}${s.env.PATH ?? ""}`;
  s.env.HOME = s.home;
  s.env.FAKE_FORGE = forgeFile;
  s.env.JIG_FORGE_BUDGET = "off";
  s.env.JIG_HOME = join(s.home, "jig-home");
  s.commit("Start", {
    "src/a.ts": "one\ntwo\nthree\n",
    "README.md": "readme\n",
  });
});
afterEach(() => s.cleanup());

const head = (ref: string) => s.git("rev-parse", ref).trim();

/** A pull request node as the forge lists it. */
function node(
  number: number,
  merge: string,
  branch: string,
  files: string[],
): Record<string, unknown> {
  const when = isoFromMs(
    Number(s.git("log", "-1", "--format=%ct", merge).trim()) * 1000,
  );
  return {
    number,
    createdAt: when,
    updatedAt: when,
    mergedAt: when,
    headRefOid: head(branch),
    baseRefName: "main",
    mergeCommit: { oid: merge },
    files: {
      pageInfo: { hasNextPage: false },
      nodes: files.map((path) => ({ path })),
    },
    commits: { totalCount: 1, nodes: [] },
    timelineItems: { nodes: [] },
  };
}

/**
 * Two pull requests changing src/a.ts: #1 merges cleanly; #2's branch merges
 * its base, which changed the same line, with a conflict, and then merges
 * cleanly. Between them a commit is pushed straight to the branch.
 */
function history(): Record<string, unknown>[] {
  s.git("checkout", "-q", "-b", "topic-1");
  s.commit("Change one", { "src/a.ts": "ONE\ntwo\nthree\n" });
  s.git("checkout", "-q", "main");
  s.git(
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge pull request #1 from acme/topic-1",
    "topic-1",
  );
  const first = head("HEAD");
  s.git("checkout", "-q", "-b", "topic-2");
  s.commit("Change three on the branch", {
    "src/a.ts": "ONE\ntwo\nTHREE (branch)\n",
  });
  s.git("checkout", "-q", "main");
  s.commit("Hotfix three", { "src/a.ts": "ONE\ntwo\nTHREE (main)\n" });
  s.git("checkout", "-q", "topic-2");
  expect(s.gitTry("merge", "-q", "--no-edit", "main").code).not.toBe(0);
  s.write("src/a.ts", "ONE\ntwo\nTHREE (both)\n");
  s.git("add", "src/a.ts");
  s.git("commit", "-q", "--no-edit");
  s.git("checkout", "-q", "main");
  s.git(
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge pull request #2 from acme/topic-2",
    "topic-2",
  );
  const second = head("HEAD");
  return [
    node(2, second, "topic-2", ["src/a.ts"]),
    node(1, first, "topic-1", ["src/a.ts"]),
  ];
}

const run = (args: string[]) => {
  const r = s.script("history.ts", ["--all", "--rates", ...args]);
  return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
};

describe("history.ts --rates", () => {
  it("writes, for each path, the merged pull requests that changed it and those that met a conflict", () => {
    writeFileSync(forgeFile, JSON.stringify({ nodes: history() }));
    const out = join(s.home, "state", "rates.json");
    const cache = join(s.home, "state", "cohort.json");
    const r = run(["--out", out, "--cohort-cache", cache]);
    expectSpawnExit(r, 0, "history.ts --rates");
    expect(r.stdout).toContain(
      "2 merged pull requests (1 conflicted, 1 clean, 0 unknown)",
    );
    const rates = JSON.parse(readFileSync(out, "utf8"));
    expect(rates.schema).toBe("merge-conflict-rates/v1");
    expect(rates.repository).toBe("acme/widgets");
    expect(rates.paths).toEqual([
      { path: "src/a.ts", merged: 2, conflicted: 1, unknown: 0 },
    ]);
    expect(
      rates.pullRequests.map((p: { number: number; observation: string }) => [
        p.number,
        p.observation,
      ]),
    ).toEqual([
      [1, "clean"],
      [2, "conflicted"],
    ]);
    // The first commit and the hotfix were pushed straight to main.
    expect(rates.commits).toMatchObject({
      firstParent: 4,
      mapped: 2,
      unknown: 2,
    });
    expect(rates.cohort.listing).toMatchObject({ pages: 1, cost: 1 });
    expect(JSON.parse(readFileSync(cache, "utf8")).schema).toBe(
      "merged-pr-cohort/v1",
    );
  });

  it("prints the rates when no file is named", () => {
    writeFileSync(forgeFile, JSON.stringify({ nodes: history() }));
    const r = run([]);
    expectSpawnExit(r, 0, "history.ts --rates");
    expect(JSON.parse(r.stdout).schema).toBe("merge-conflict-rates/v1");
  });

  it("keeps the previous file when the forge refuses the listing", () => {
    history();
    writeFileSync(forgeFile, JSON.stringify({ fail: true }));
    const out = join(s.home, "rates.json");
    writeFileSync(out, "previous\n");
    const r = run(["--out", out]);
    expectSpawnExit(r, 3, "a refused listing");
    expect(r.stderr).toContain("HTTP 401");
    expect(r.stderr).toContain(`${out} is kept as it was`);
    expect(readFileSync(out, "utf8")).toBe("previous\n");
  });

  it("keeps the previous file when the listing is cut at its bound", () => {
    const [template] = history();
    writeFileSync(forgeFile, JSON.stringify({ endless: true, template }));
    const out = join(s.home, "rates.json");
    writeFileSync(out, "previous\n");
    const cache = join(s.home, "cohort.json");
    const r = run(["--out", out, "--cohort-cache", cache]);
    expectSpawnExit(r, 3, "a cut listing");
    expect(r.stderr).toContain("bound of 1000 pull requests");
    expect(readFileSync(out, "utf8")).toBe("previous\n");
    expect(existsSync(cache)).toBe(false);
    // One listing, bounded: twenty pages of fifty.
    expect(
      readFileSync(`${forgeFile}.calls`, "utf8").trim().split("\n"),
    ).toHaveLength(20);
  });

  it("refuses --out without --rates, and --rates beside --propose-serialize", () => {
    const alone = s.script("history.ts", ["--out", "x.json"]);
    expectSpawnExit(
      { exitCode: alone.code, stdout: alone.stdout, stderr: alone.stderr },
      2,
    );
    expect(alone.stderr).toContain("--out and --cohort-cache go with --rates");
    const both = run(["--propose-serialize"]);
    expectSpawnExit(both, 2);
    expect(both.stderr).toContain(
      "choose one of --rates and --propose-serialize",
    );
  });
});
