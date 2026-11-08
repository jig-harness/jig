/**
 * dispatch: what one tick reads once. Each pull request's comments are
 * listed at most once per tick and shared between its ledger and its launch
 * claims; the host's login, budget and Orca listings are read once whatever
 * the number of repositories; a merge whose `updatedAt` has not moved keeps
 * the markers the tick before read, and a new marker on it, which moves its
 * `updatedAt`, is seen at the next tick; a write the tick makes on a merge
 * drops what was kept of it. Each tick runs in a child with its own home
 * (fixtures.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  LAUNCH_CLAIM,
  launchClaim,
} from "../../shared/records/launch-claims.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { manualMarker } from "../lib/followup-marker.ts";
import { recordExit } from "../lib/launches.ts";
import { closeStateDb, existingStateDb, stateDb } from "../lib/state.ts";
import {
  keptClaims,
  keptMarkers,
  MERGE_REREAD_MS,
  type MergeRead,
  readMergeReads,
} from "../lib/merge-reads.ts";
import { tickComments, type Listing } from "../lib/tick-comments.ts";
import { tickReads } from "../lib/tick-reads.ts";
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
import {
  account,
  dispatchState,
  earlierRecord,
  machineFile,
} from "./launch-fixtures.ts";
import { applyTick, orcaCalls } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

/** Who posts the markers this suite seeds: on PR #9, from one host. */
const POST = { pr: 9, writer: { host: "sha256:0123456789abcdef" } };

let current: World | null = null;
afterEach(() => {
  // A follow-up pass the tick started ends.
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  return w;
}

/** A report-only tick over `repos` (the world's repository when none), exiting `exit`. */
async function report(
  w: World,
  repos: string[] = [],
  exit = 0,
): Promise<TickReceipt> {
  const r = await w.dispatch([
    ...repos.flatMap((p) => ["--repo", p]),
    "--followup-since",
    "2026-10-30T00:00:00Z",
    "--json",
  ]);
  expectSpawnExit(r, exit);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** Every `gh` call the fake answered so far, one line each. */
function ghCalls(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

/** Forget the `gh` calls so far, so the next tick's are counted alone. */
function resetCalls(w: World): void {
  rmSync(join(w.dir, "gh-calls.log"), { force: true });
  rmSync(join(w.dir, "orca-calls.log"), { force: true });
}

/** The comment listings of pull request `pr` among the calls. */
const listings = (w: World, pr: number) =>
  ghCalls(w).filter((c) => c.includes(`/issues/${pr}/comments?per_page=100`))
    .length;

/** PR #9 merged, its `updatedAt` as given, carrying a person's follow-up marked done. */
function settledMerge(w: World, updatedAt: string): void {
  w.setPrs("merged", [
    { ...mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"), updatedAt },
  ]);
  w.setComments(9, [forgeComment(901, manualMarker(true, POST))]);
}

describe("one tick lists each pull request's comments once", () => {
  it("shares one listing between a drive's ledger and its launch claims", async () => {
    const w = fixture();
    w.setPrs("open", [openPr(7, "feature/7-parked")]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
    const receipt = await report(w);
    expect(receipt.repos[0]?.actions).toEqual([
      expect.objectContaining({ stage: "rearm", target: "PR #7" }),
    ]);
    // The repository's query read them; no listing of its own was made.
    expect(listings(w, 7)).toBe(0);
    expect(
      ghCalls(w).filter((c) => c.includes("query DispatchRepository")),
    ).toHaveLength(1);
    // The claims were still read, from those comments.
    expect(receipt.repos[0]?.shared?.ops).toContainEqual({
      op: "list",
      target: "PR #7",
      ok: true,
    });
  });

  it("reads the login, the budget and Orca's listings once for every repository", async () => {
    const w = fixture();
    const second = join(w.root, "second");
    mkdirSync(second, { recursive: true });
    const receipt = await report(w, [w.repo, second]);
    expect(receipt.repos).toHaveLength(2);
    const calls = ghCalls(w);
    expect(calls.filter((c) => c === "api user --jq .login")).toHaveLength(1);
    expect(calls.filter((c) => c === "api rate_limit")).toHaveLength(1);
    expect(orcaCalls(w, "repo", "list")).toHaveLength(1);
    expect(orcaCalls(w, "worktree", "ps")).toHaveLength(1);
    // Each repository's report still carries the budget and its runtime read.
    for (const repo of receipt.repos) {
      expect(repo.shared?.budget).toMatchObject({ limit: 5000 });
      expect(repo.records).toContainEqual(
        expect.objectContaining({ record: "runtime", ok: true }),
      );
    }
  });

  it("fails each repository's runtime record alike when Orca's host-wide listing fails", async () => {
    const w = fixture();
    const second = join(w.root, "second");
    mkdirSync(second, { recursive: true });
    rmSync(join(w.dir, "orca-repos.json"));
    // A record that does not read makes the tick's exit 1.
    const receipt = await report(w, [w.repo, second], 1);
    const runtime = receipt.repos.map((r) =>
      r.records.find((x) => x.record === "runtime"),
    );
    expect(runtime).toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false }),
    ]);
    expect(runtime[0]?.detail).toBe(runtime[1]?.detail);
    expect(orcaCalls(w, "repo", "list")).toHaveLength(1);
  });
});

describe("a merge whose updatedAt has not moved", () => {
  it("is not read again, and a new marker on it is seen at the next tick", async () => {
    const w = fixture();
    settledMerge(w, "2026-10-31T13:00:00Z");
    const first = await report(w);
    expect(first.repos[0]?.quiet).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-done" }),
    );
    expect(listings(w, 9)).toBe(1);

    resetCalls(w);
    const second = await report(w);
    expect(listings(w, 9)).toBe(0);
    expect(second.repos[0]?.quiet).toEqual(first.repos[0]?.quiet);
    expect(second.repos[0]?.records).toContainEqual(
      expect.objectContaining({
        record: "forge",
        detail: expect.stringContaining("(1 unchanged since a tick read"),
      }),
    );

    // A second run's marker: the comment moves the pull request's updatedAt.
    resetCalls(w);
    w.setComments(9, [
      forgeComment(901, manualMarker(true, POST)),
      forgeComment(902, manualMarker(false, POST)),
    ]);
    w.setPrs("merged", [
      {
        ...mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"),
        updatedAt: "2026-10-31T14:00:00Z",
      },
    ]);
    const third = await report(w);
    expect(listings(w, 9)).toBe(1);
    expect(third.repos[0]?.unplaced).toContainEqual(
      expect.objectContaining({
        target: "PR #9",
        reason: expect.stringContaining("2 trusted follow-up markers"),
      }),
    );
  });

  it("is read every tick when the listing gives no updatedAt", async () => {
    const w = fixture();
    w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
    w.setComments(9, [forgeComment(901, manualMarker(true, POST))]);
    await report(w);
    resetCalls(w);
    await report(w);
    expect(listings(w, 9)).toBe(1);
  });

  it("is read again when its comments were listed before the merged listing was observed", async () => {
    const w = fixture();
    // Listed as open first (its comments read then), merged by the time the
    // merged listing is read: those comments predate the newer updatedAt.
    w.setPrs("open", [openPr(9, "feature/9-done")]);
    settledMerge(w, "2026-10-31T13:00:00Z");
    await report(w);
    // The open listing reads PR #9's comments every tick, so the count of
    // merges kept unchanged is what shows whether the first tick kept them.
    const second = await report(w);
    expect(second.repos[0]?.records).toContainEqual(
      expect.objectContaining({
        record: "forge",
        detail: expect.stringContaining("(0 unchanged since a tick read"),
      }),
    );
  });

  it("is read again after the tick posts a marker on it", async () => {
    const w = fixture();
    w.setPrs("merged", [
      {
        ...mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"),
        updatedAt: "2026-10-31T13:00:00Z",
      },
    ]);
    w.setComments(9, []);
    const ws = join(w.root, "ws-9");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/9-done", linkedPR: 9, path: ws }]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["followup"], {
      followup_since: "2026-10-30T00:00:00Z",
    });
    const launched = await applyTick(w, false);
    expect(launched.repos[0]?.launches).toEqual([
      expect.objectContaining({ action: "followup", outcome: "launched" }),
    ]);
    const db = existingStateDb(dispatchState(w));
    expect(
      db
        ?.query("SELECT pr FROM merge_reads WHERE repo = ? AND pr = 9")
        .all(SLUG),
    ).toEqual([]);
  });
});

describe("a merge whose drive launches on this host all ended", () => {
  /** Another host's open launch claim on PR #9, saying that host owns the repository. */
  const otherClaim = () =>
    forgeComment(
      905,
      claimBody(
        LAUNCH_CLAIM,
        launchClaim(
          {
            stage: "drive",
            pr: 9,
            run: "tick",
            action: "rearm",
            record: "20261105T010000Z-cccccccc",
            host: "sha256:cccccccccccccccc",
            owner: true,
            facts: "generation 3, exit 16",
            writer: { host: "sha256:cccccccccccccccc" },
          },
          1,
          new Date(Date.now() - 600_000).toISOString(),
        ),
      ),
      "drive-bot",
    );

  it("has its launch claims read once, and a new claim on it is seen at the next tick", async () => {
    const w = fixture();
    settledMerge(w, "2026-10-31T13:00:00Z");
    // A re-arm of this host's on PR #9 that ended, with no claim of its own on the pull request: its end is never settled.
    const id = "20261106T120000Z-aaaaaaaa";
    earlierRecord(w, {
      id,
      account: "a",
      pr: 9,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    recordExit(
      id,
      {
        at: new Date(Date.now() - 1_800_000).toISOString(),
        code: 0,
        signal: null,
      },
      dispatchState(w),
    );
    const first = await report(w);
    expect(listings(w, 9)).toBe(1);
    expect(first.repos[0]?.shared?.ops).toContainEqual({
      op: "list",
      target: "PR #9",
      ok: true,
    });

    resetCalls(w);
    const second = await report(w);
    expect(listings(w, 9)).toBe(0);
    expect(second.repos[0]?.shared?.owners).toEqual([]);

    // Another host claims a launch on it: the comment moves its updatedAt.
    resetCalls(w);
    w.setComments(9, [
      forgeComment(901, manualMarker(true, POST)),
      otherClaim(),
    ]);
    w.setPrs("merged", [
      {
        ...mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"),
        updatedAt: "2026-10-31T14:00:00Z",
      },
    ]);
    const third = await report(w);
    expect(listings(w, 9)).toBe(1);
    expect(third.repos[0]?.shared?.owners).toEqual(["sha256:cccccccccccccccc"]);

    // While that host's claim has no end, its claims are read every tick.
    resetCalls(w);
    await report(w);
    expect(listings(w, 9)).toBe(1);
  });
});

describe("a kept merge read", () => {
  const kept: MergeRead = {
    updatedAt: "2026-10-31T13:00:00Z",
    readAtMs: 1_000_000,
    login: "dispatcher",
    markers: [],
    claims: null,
  };
  const same = { updatedAt: kept.updatedAt };

  it("stands while the updatedAt is the same and it is younger than the cadence", () => {
    expect(keptMarkers(kept, same, kept.readAtMs + 1, "dispatcher")).toEqual(
      [],
    );
    expect(
      keptMarkers(
        kept,
        { updatedAt: "2026-10-31T14:00:00Z" },
        1_000_001,
        "dispatcher",
      ),
    ).toBeNull();
    expect(keptMarkers(kept, {}, 1_000_001, "dispatcher")).toBeNull();
    expect(
      keptMarkers(kept, same, kept.readAtMs + MERGE_REREAD_MS, "dispatcher"),
    ).toBeNull();
  });

  it("does not stand for another forge login, or when either login is unknown", () => {
    expect(keptMarkers(kept, same, 1_000_001, "someone-else")).toBeNull();
    expect(keptMarkers(kept, same, 1_000_001, null)).toBeNull();
    expect(
      keptMarkers({ ...kept, login: null }, same, 1_000_001, "dispatcher"),
    ).toBeNull();
    const withClaims = {
      ...kept,
      claims: { readAtMs: 1_000_000, claims: [] },
    };
    expect(keptClaims(withClaims, same, 1_000_001, "dispatcher")).toEqual([]);
    expect(keptClaims(withClaims, same, 1_000_001, "someone-else")).toBeNull();
  });

  it("reads only rows whose markers and claims have their complete shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-reads-"));
    try {
      const marker = {
        id: 1,
        login: "a",
        createdAt: "2026-10-31T13:00:00Z",
        trusted: true,
      };
      const put = (pr: number, markers: unknown) =>
        stateDb(root)
          .query(
            "INSERT INTO merge_reads (repo, pr, updated_at, read_at_ms, login, markers) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            SLUG,
            pr,
            kept.updatedAt,
            1,
            "dispatcher",
            JSON.stringify(markers),
          );
      put(1, [{ ...marker, run: { kind: "manual", done: false } }]);
      put(2, [{ ...marker, run: { kind: "manual", done: "false" } }]);
      put(3, [{ ...marker, run: { kind: "tick" } }]);
      put(4, [{ ...marker, run: { kind: "other" } }]);
      put(5, [{ ...marker, run: { kind: "unreadable", reason: "x" } }]);
      expect([...readMergeReads(SLUG, root).keys()].sort()).toEqual([1, 5]);
      stateDb(root)
        .query(
          "UPDATE merge_reads SET claims = ?, claims_read_at_ms = 1 WHERE pr = 1",
        )
        .run(
          JSON.stringify([
            {
              id: 2,
              stage: "drive",
              login: "a",
              createdAt: "t",
              trusted: true,
              says: { ok: true, value: {} },
            },
          ]),
        );
      expect(readMergeReads(SLUG, root).get(1)?.claims).toBeNull();
    } finally {
      closeStateDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the tick's comment listings", () => {
  it("fill one listing per pull request for readers at once, and a write drops it", async () => {
    const asked: number[] = [];
    const written: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const comments = tickComments({
      list: async ({ number }): Promise<Listing> => {
        asked.push(number);
        await gate;
        return { ok: true, value: [{ id: number }] };
      },
      written: (_repo, pr) => written.push(pr),
    });
    const both = Promise.all([comments.read(SLUG, 7), comments.read(SLUG, 7)]);
    release();
    const [a, b] = await both;
    expect(a).toEqual({ ok: true, value: [{ id: 7 }] });
    expect(b).toBe(a);
    expect(asked).toEqual([7]);
    expect(comments.startedAt(SLUG, 7)).toBeGreaterThan(0);
    expect(comments.startedAt(SLUG, 8)).toBeNull();
    comments.forget(SLUG, 7);
    expect(comments.startedAt(SLUG, 7)).toBeNull();
    await comments.read(SLUG, 7);
    expect(asked).toEqual([7, 7]);
    expect(written).toEqual([7]);
  });
});

describe("the tick's shared reads", () => {
  it("make the runtime's sessions reader on first use, so a throwing factory is the read's failure", async () => {
    const runtime = {
      sessionsOnce: () => {
        throw new Error("no reader");
      },
    } as unknown as Parameters<typeof tickReads>[0];
    const reads = tickReads(runtime);
    await expect(reads.sessions({} as never, {} as never)).rejects.toThrow(
      "no reader",
    );
  });
});
