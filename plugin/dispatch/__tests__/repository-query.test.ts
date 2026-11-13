/**
 * dispatch: one query per repository. A tick reads which repository a
 * checkout is, its configuration, its open pull requests and their comments
 * in one query of as many pages as its pull requests need, and lists on
 * their own only the comments of a pull request with more than one page of
 * them. A query that does not read leaves each fact to its own read, as
 * before. The reads just before a launch still go to the forge one by one,
 * so a write landing after the query is what the launch acts on. The
 * follow-up markers of several merges are read in one query too, and a
 * merge whose `updatedAt` has not moved is still not read again. Each tick
 * runs in a child with its own home (fixtures.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { manualMarker } from "../lib/followup-marker.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, machineFile, terminalCreates } from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const HEAD = "feature/7-parked";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  return w;
}

/** A tick over the world's repository, `--apply` when `apply`; resolves to its receipt. */
async function tick(w: World, apply = false): Promise<TickReceipt> {
  const r = await w.dispatch(
    apply
      ? ["--apply", "--json"]
      : ["--followup-since", "2026-10-30T00:00:00Z", "--json"],
  );
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** Forget the `gh` calls so far, so the next tick's are counted alone. */
const resetCalls = (w: World) =>
  rmSync(join(w.dir, "gh-calls.log"), { force: true });

/** Every `gh` call the fake answered so far, one line each. */
function ghCalls(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

const queries = (w: World, name = "DispatchRepository") =>
  ghCalls(w).filter((c) => c.includes(`query ${name}`)).length;

/** The comment listings of pull request `pr` among the calls. */
const listings = (w: World, pr: number) =>
  ghCalls(w).filter((c) => c.includes(`/issues/${pr}/comments?per_page=100`))
    .length;

const forgeDetail = (r: TickReceipt) =>
  r.repos[0]?.records.find((x) => x.record === "forge")?.detail ?? "";

/** PR #7's drive stopped `16`, which a re-arm acts on. */
const stopped = (generation = 3) =>
  ledgerComment(701, { ...stoppedLedger(7, 16), generation });

describe("one query per repository", () => {
  it("reads the repository, its configuration, its open pull requests and their comments in one call", async () => {
    const w = fixture();
    w.setPrs("open", [openPr(7, HEAD), openPr(8, "feature/8")]);
    w.setComments(7, [stopped()]);
    w.setComments(8, []);
    const receipt = await tick(w);
    expect(receipt.repos[0]?.actions).toEqual([
      expect.objectContaining({ stage: "rearm", target: "PR #7" }),
    ]);
    expect(queries(w)).toBe(1);
    const calls = ghCalls(w);
    expect(calls.filter((c) => c.startsWith("repo view"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("pr list"))).toEqual([]);
    expect(calls.filter((c) => c.includes("/contents/"))).toEqual([]);
    expect(listings(w, 7) + listings(w, 8)).toBe(0);
    // Its launch claims were read from the query's comments too.
    expect(receipt.repos[0]?.shared?.ops).toContainEqual({
      op: "list",
      target: "PR #7",
      ok: true,
    });
    expect(forgeDetail(receipt)).toContain(
      "2 open pull request(s) (one repository query: 1 page(s), 1 point(s))",
    );
  });

  it("pages through the open pull requests", async () => {
    const w = fixture();
    w.setPrs(
      "open",
      Array.from({ length: 60 }, (_, i) => openPr(100 + i, `feature/${i}`)),
    );
    const receipt = await tick(w);
    expect(queries(w)).toBe(2);
    expect(forgeDetail(receipt)).toContain(
      "60 open pull request(s) (one repository query: 2 page(s), 2 point(s))",
    );
  });

  it("lists on its own a pull request with more comments than one page, and reads all of them", async () => {
    const w = fixture();
    w.setPrs("open", [openPr(7, HEAD)]);
    // The ledger is the 101st comment: only the full listing holds it.
    const chatter = Array.from({ length: 100 }, (_, i) =>
      forgeComment(1000 + i, `comment ${i}`, "someone", "NONE"),
    );
    w.setComments(7, [...chatter, stopped()]);
    const receipt = await tick(w);
    expect(listings(w, 7)).toBe(1);
    expect(receipt.repos[0]?.actions).toEqual([
      expect.objectContaining({ stage: "rearm", target: "PR #7" }),
    ]);
    expect(forgeDetail(receipt)).toContain(
      "1 with more comments than one page holds, listed on their own",
    );
  });

  it("reads each fact on its own when the query does not read", async () => {
    const w = fixture();
    w.setPrs("open", [openPr(7, HEAD)]);
    w.setComments(7, [stopped()]);
    writeFileSync(join(w.dir, "repository-query-fail"), "");
    const receipt = await tick(w);
    expect(receipt.repos[0]?.refused).toBeNull();
    expect(receipt.repos[0]?.actions).toEqual([
      expect.objectContaining({ stage: "rearm", target: "PR #7" }),
    ]);
    const calls = ghCalls(w);
    expect(calls.filter((c) => c.startsWith("repo view"))).toHaveLength(1);
    expect(
      calls.filter((c) => c.includes("/contents/.config/jig.yaml")),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("pr list"))).toHaveLength(1);
    expect(listings(w, 7)).toBe(1);
    expect(forgeDetail(receipt)).toContain(
      "the repository query did not read, so each was read on its own",
    );
  });
});

/** The forge record of a tick that fails on the repository's pull requests. */
async function failedForge(w: World) {
  const r = await w.dispatch([
    "--followup-since",
    "2026-10-30T00:00:00Z",
    "--json",
  ]);
  expectSpawnExit(r, 1);
  const receipt = JSON.parse(r.stdout) as TickReceipt;
  const forge = receipt.repos[0]?.records.find((x) => x.record === "forge");
  expect(forge?.ok).toBe(false);
  return forge;
}

describe("a page the forge times out", () => {
  /** A world of `count` open pull requests whose query times out on a page above `limit`. */
  function heavy(count: number, limit: number): World {
    const w = fixture();
    w.setPrs(
      "open",
      Array.from({ length: count }, (_, i) => openPr(100 + i, `feature/${i}`)),
    );
    writeFileSync(join(w.dir, "query-times-out-above"), String(limit));
    return w;
  }

  /** The page sizes the repository's query was asked for, in order. */
  const pageSizes = (w: World) =>
    ghCalls(w)
      .filter((c) => c.includes("query DispatchRepository"))
      .map((c) => Number(/\bfirst=(\d+)/.exec(c)?.[1]));

  it("is asked for again at half its size until it answers, and the repository is read whole in smaller pages", async () => {
    const w = heavy(25, 10);
    const receipt = await tick(w);
    expect(pageSizes(w)).toEqual([50, 25, 12, 6, 6, 6, 6, 6]);
    expect(ghCalls(w).filter((c) => c.startsWith("pr list"))).toEqual([]);
    expect(forgeDetail(receipt)).toContain(
      "25 open pull request(s) (one repository query: 5 page(s), 6 pull request(s) a page where the forge timed out on more, 5 point(s))",
    );
  });

  it("begins the next tick at the size that answered", async () => {
    const w = heavy(25, 10);
    await tick(w);
    resetCalls(w);
    const receipt = await tick(w);
    expect(pageSizes(w)).toEqual([6, 6, 6, 6, 6]);
    expect(forgeDetail(receipt)).toContain("25 open pull request(s)");
  });

  it("leaves the pull requests to the listing when a page of one times out, their checks read in a query of their own", async () => {
    const w = heavy(3, 0);
    const receipt = await tick(w);
    expect(pageSizes(w)).toEqual([50, 25, 12, 6, 3, 1]);
    const calls = ghCalls(w);
    const listing = calls.filter((c) => c.startsWith("pr list"));
    expect(listing).toHaveLength(1);
    expect(listing[0]).not.toContain("statusCheckRollup");
    expect(queries(w, "DispatchChecks")).toBe(1);
    expect(forgeDetail(receipt)).toContain(
      "3 open pull request(s) (the repository query did not read, so each was read on its own: the forge timed out: gh api graphql exited 1: gh: HTTP 504: We couldn't respond to your request in time. (at a page of 1, shrunk from 50))",
    );
  });

  it("is named beside the listing's own failure when neither reads", async () => {
    const w = heavy(3, 0);
    writeFileSync(join(w.dir, "checks-query-fail"), "");
    // A repository whose pull requests cannot be read fails the tick.
    const forge = await failedForge(w);
    expect(forge?.detail).toContain(
      "the pull requests cannot be read: the repository query did not read (the forge timed out: gh api graphql exited 1: gh: HTTP 504",
    );
    expect(forge?.detail).toContain(
      "and the listing on its own did not either: the open pull requests' checks did not read: the forge timed out: gh api graphql exited 1: gh: HTTP 502",
    );
  });
});

describe("a checks query that answers without its pull requests", () => {
  it("is an unreadable listing, not one whose checks are all unknown", async () => {
    const w = fixture();
    w.setPrs("open", [openPr(7, HEAD)]);
    writeFileSync(join(w.dir, "repository-query-fail"), "");
    writeFileSync(join(w.dir, "checks-query-empty"), "");
    const forge = await failedForge(w);
    expect(forge?.detail).toContain(
      "the checks query answered without the repository",
    );
  });

  it("is unreadable when one pull request's alias is null beside a valid one", async () => {
    const w = fixture();
    w.setPrs("open", [openPr(7, HEAD), openPr(8, HEAD)]);
    writeFileSync(join(w.dir, "repository-query-fail"), "");
    writeFileSync(join(w.dir, "checks-query-null-alias"), "8");
    const forge = await failedForge(w);
    expect(forge?.detail).toContain(
      "the checks query answered without pull request 8",
    );
  });
});

describe("the reads before a launch", () => {
  /** PR #7 stopped `16` as the query reads it, its workspace there, account a billing it; the forge's listing as `listed` holds it. */
  function launchable(listed: unknown[]): World {
    const w = fixture();
    w.setPrs("open", [openPr(7, HEAD)]);
    writeFileSync(
      join(w.dir, "batch-comments-7.json"),
      JSON.stringify([stopped()]),
    );
    w.setComments(7, listed);
    const ws = join(w.root, "ws-7");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
    machineFile(w, [account(w, "a", "a@example.com")]);
    return w;
  }

  it("go to the forge: a ledger written after the query is what the launch reads", async () => {
    // Another driver's round moved the ledger on after the query.
    const w = launchable([stopped(4)]);
    const receipt = await tick(w, true);
    const [launch] = receipt.repos[0]?.launches ?? [];
    expect(launch).toMatchObject({ target: "PR #7", outcome: "waits" });
    expect(launch?.detail).toContain("changed since the plan read it");
    expect(terminalCreates(w)).toEqual([]);
    expect(listings(w, 7)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("launch when the forge still says what the query read", async () => {
    const w = launchable([stopped()]);
    const receipt = await tick(w, true);
    const [launch] = receipt.repos[0]?.launches ?? [];
    expect(launch).toMatchObject({ target: "PR #7", outcome: "launched" });
    expect(terminalCreates(w)).toHaveLength(1);
    writeFileSync(join(w.dir, "claude-exit"), "");
  }, 60_000);
});

describe("the merges' follow-up markers", () => {
  /** PRs #9 and #10 merged, each carrying a person's follow-up marked done. */
  function settled(): World {
    const w = fixture();
    w.setConfig(`${CONFIG}dispatch:\n  followup_command: /followup\n`);
    const post = (pr: number) => ({
      pr,
      writer: { host: "sha256:0123456789abcdef" },
    });
    w.setPrs(
      "merged",
      [9, 10].map((n) => ({
        ...mergedPr(n, `feature/${n}-done`, "2026-10-31T12:00:00Z"),
        updatedAt: "2026-10-31T13:00:00Z",
      })),
    );
    for (const n of [9, 10])
      w.setComments(n, [
        forgeComment(n * 100 + 1, manualMarker(true, post(n))),
      ]);
    return w;
  }

  const done = (r: TickReceipt) =>
    (r.repos[0]?.quiet ?? [])
      .filter((q) => q.class === "followup-done")
      .map((q) => q.target);

  it("are read in one query, and a merge whose updatedAt has not moved is not read again", async () => {
    const w = settled();
    const first = await tick(w);
    expect(done(first)).toEqual(["PR #9", "PR #10"]);
    expect(queries(w, "DispatchComments")).toBe(1);
    expect(listings(w, 9) + listings(w, 10)).toBe(0);
    expect(forgeDetail(first)).toContain(
      "the others' comments read in one query: 1 page(s), 1 point(s)",
    );

    resetCalls(w);
    const second = await tick(w);
    expect(done(second)).toEqual(["PR #9", "PR #10"]);
    expect(queries(w, "DispatchComments")).toBe(0);
    expect(listings(w, 9) + listings(w, 10)).toBe(0);
    expect(forgeDetail(second)).toContain("(2 unchanged since a tick read");
  });

  it("are listed one by one when the query does not read", async () => {
    const w = settled();
    writeFileSync(join(w.dir, "comments-query-fail"), "");
    const receipt = await tick(w);
    expect(done(receipt)).toEqual(["PR #9", "PR #10"]);
    expect(listings(w, 9)).toBe(1);
    expect(listings(w, 10)).toBe(1);
    expect(forgeDetail(receipt)).toContain(
      "the comments query did not read, so each was listed on its own",
    );
  });
});
