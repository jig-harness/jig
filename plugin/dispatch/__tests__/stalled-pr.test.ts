/**
 * dispatch and a stalled pickup's finished work: a claimed item with no
 * running session whose launch's branch has an open pull request linking it
 * moves to `pr_open` with a fixed comment, and raises no stall need; a pull
 * request from a branch no launch of this host worked on moves nothing; and
 * open pull requests that did not read leave the item where it is.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { bodyLinker } from "../../skills/do-item/scripts/lib/linked-pr.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { applyPrOpenMoves } from "../lib/actions/pr-open-moves.ts";
import {
  type LaunchRecord,
  type ReadRecord,
  readRecord,
} from "../lib/launches.ts";
import { type PickupInput, planPickups } from "../lib/plan-pickups.ts";
import type { SessionsReport } from "../lib/runtime/port.ts";
import type { StalledPrInput } from "../lib/stalled-pr.ts";
import type {
  ClaimedItem,
  DispatchSection,
  PrOpenMove,
  RepoReport,
} from "../lib/types.ts";
import type { PrLinkText } from "../lib/work-links.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, openPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const NOW = Date.parse("2026-11-13T08:00:00Z");
const HOUR = 3_600_000;
const PATH = "/work/example-repo-12";
const BRANCH = "12-issue-12";
const URL = `https://github.com/${SLUG}/pull/31`;

/** The ended pickup of #12 this host launched, in the workspace at `PATH`. */
const launch: ReadRecord = {
  record: {
    id: "20261113T060000Z-abcdef12",
    action: "pickup",
    repo: SLUG,
    item: "#12",
    pr: null,
    released: false,
    workspace: { id: "repo-1::12", path: PATH },
    claimedItems: ["#12"],
  } as unknown as LaunchRecord,
  state: {
    kind: "ended",
    exit: { at: "2026-11-13T07:00:00Z", code: 0, signal: null },
    process: null,
  },
  result: null,
};

/** The runtime's answer: the launch's workspace on its branch, no agent running. */
const sessions: SessionsReport = {
  ok: true,
  source: "fake",
  workspaces: [
    {
      id: "repo-1::12",
      path: PATH,
      branch: BRANCH,
      items: ["#12"],
      prs: [31],
      agents: [],
      unverifiableTerminals: 0,
      comment: "",
      unread: null,
      name: "",
    },
  ],
};

function pr(head: string, body = "Closes #12"): PrLinkText {
  return {
    number: 31,
    url: URL,
    headRefName: head,
    body,
    crossRepository: false,
    closing: [],
  };
}

function prOpen(
  prs: PrLinkText[] | null,
  over: Partial<StalledPrInput> = {},
): StalledPrInput {
  return {
    prs,
    prOpen: "PR Open",
    owner: true,
    links: (body, key) =>
      bodyLinker(key, {
        repository: SLUG,
        keySource: "(?<![\\w&#])#[1-9]\\d*(?!\\w)",
        trackerRepository: SLUG,
      })(body),
    ...over,
  };
}

function input(
  stalled: StalledPrInput | undefined,
  state = "In Progress",
): PickupInput {
  const claimed: ClaimedItem[] = [{ key: "#12", title: "issue 12", state }];
  return {
    slug: SLUG,
    section: {
      stalledAfterMs: HOUR / 2,
      blockedAfterMs: HOUR,
    } as DispatchSection,
    pickups: [],
    claimed,
    sessions,
    launches: [launch],
    idleSince: new Map([["#12", NOW - 2 * HOUR]]),
    nowMs: NOW,
    ...(stalled === undefined ? {} : { prOpen: stalled }),
  };
}

/** A tracker holding #12 in `state`, recording its moves and comments; `fail` makes every call throw. */
function fakeTracker(state: string, fail = false) {
  const moves: string[][] = [];
  const comments: string[][] = [];
  const refuse = () => {
    if (fail) throw new Error("tracker unreachable");
  };
  const tracker = {
    async getIssue(key: string) {
      refuse();
      return {
        identifier: key,
        state: { id: "s", name: state, type: "started" },
      };
    },
    async transition(key: string, to: string) {
      refuse();
      moves.push([key, to]);
    },
    async postComment(key: string, body: string) {
      refuse();
      comments.push([key, body]);
    },
  } as unknown as Tracker;
  return { tracker, moves, comments };
}

function reportWith(moves: PrOpenMove[]): RepoReport {
  return { prOpenMoves: moves } as unknown as RepoReport;
}

describe("a stalled pickup whose launch opened a pull request", () => {
  it("moves the item to pr_open with the fixed comment, and raises no stall need", async () => {
    const plan = planPickups(input(prOpen([pr(BRANCH)])));
    expect(plan.actions).toEqual([]);
    expect(plan.moves).toEqual([
      {
        target: "#12",
        pr: 31,
        url: URL,
        branch: BRANCH,
        record: launch.record.id,
        from: "In Progress",
        to: "PR Open",
      },
    ]);

    const fake = fakeTracker("In Progress");
    const report = reportWith(plan.moves);
    await applyPrOpenMoves(report, fake.tracker);
    expect(fake.moves).toEqual([["#12", "pr_open"]]);
    expect(fake.comments).toHaveLength(1);
    const [, body] = fake.comments[0] ?? [];
    expect(body).toContain("The dispatcher moved this item to PR Open");
    expect(body).toContain(`pull request #31 (${URL})`);
    expect(body).toContain(`<!-- do-item-pr: ${URL} -->`);
    expect(report.prOpenMoves?.[0]).toMatchObject({ outcome: "moved" });
  });

  it("moves nothing for a pull request naming the item from a branch no launch worked on", () => {
    const plan = planPickups(input(prOpen([pr("12-someone-elses-fix")])));
    expect(plan.moves).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#12", cause: "stalled" }),
    ]);
    expect(plan.actions[0]?.evidence.pullRequest).toBeUndefined();
  });

  it("moves nothing for a pull request from the launch's branch that does not link the item", () => {
    const plan = planPickups(input(prOpen([pr(BRANCH, "Refs #13")])));
    expect(plan.moves).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#12", cause: "stalled" }),
    ]);
  });

  it("leaves the item as it is when the open pull requests did not read, and says so", () => {
    const plan = planPickups(input(prOpen(null)));
    expect(plan.moves).toEqual([]);
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#12", cause: "stalled" }),
    ]);
    expect(plan.actions[0]?.reason).toContain(
      "the open pull requests' descriptions did not read this tick",
    );
  });

  it("frames the stall need with the pull request named where the repository names no pr_open state", () => {
    const plan = planPickups(input(prOpen([pr(BRANCH)], { prOpen: null })));
    expect(plan.moves).toEqual([]);
    const [need] = plan.actions;
    expect(need).toMatchObject({ target: "#12", cause: "stalled" });
    expect(need?.evidence.pullRequest).toBe(URL);
    expect(need?.reason).toContain("pull request #31");
    expect(need?.reason).toContain("names no pr_open state, so nothing moved");
  });

  it("moves nothing on a host that does not own the repository", () => {
    const plan = planPickups(input(prOpen([pr(BRANCH)], { owner: false })));
    expect(plan.moves).toEqual([]);
    expect(plan.actions[0]?.reason).toContain(
      "only the host that owns the repository moves an item to pr_open",
    );
  });

  it("does not watch an item already in pr_open as stalled while its launch's pull request is open", () => {
    const plan = planPickups(input(prOpen([pr(BRANCH)]), "PR Open"));
    expect(plan.moves).toEqual([]);
    expect(plan.actions).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#12", class: "claimed-pr-open" }),
    );
  });

  it("moves nothing for a pull request from a fork, or one whose head repository is not read", () => {
    for (const crossRepository of [true, undefined]) {
      const { crossRepository: _, ...rest } = pr(BRANCH);
      const fork =
        crossRepository === undefined ? rest : { ...rest, crossRepository };
      const plan = planPickups(input(prOpen([fork])));
      expect(plan.moves).toEqual([]);
      expect(plan.actions).toHaveLength(1);
    }
  });

  it("reads no launch record that no longer holds the item", () => {
    const released = { ...input(prOpen([pr(BRANCH)])) };
    released.launches = [
      { ...launch, record: { ...launch.record, released: true } },
    ];
    expect(planPickups(released).moves).toEqual([]);
  });

  it("moves an idle item before dispatch.stalled_after, since its work is finished", () => {
    const early = { ...input(prOpen([pr(BRANCH)])), idleSince: new Map() };
    const plan = planPickups(early);
    expect(plan.moves).toHaveLength(1);
    expect(plan.quiet).toEqual([]);
  });
});

describe("--apply of a move to pr_open", () => {
  const move: PrOpenMove = {
    target: "#12",
    pr: 31,
    url: URL,
    branch: BRANCH,
    record: launch.record.id,
    from: "In Progress",
    to: "PR Open",
  };

  it("leaves an item the tracker cannot read as it is, and reports it", async () => {
    const fake = fakeTracker("In Progress", true);
    const report = reportWith([move]);
    await applyPrOpenMoves(report, fake.tracker);
    expect(fake.moves).toEqual([]);
    expect(fake.comments).toEqual([]);
    expect(report.prOpenMoves?.[0]).toMatchObject({ outcome: "refused" });
    expect(report.prOpenMoves?.[0]?.detail).toContain("tracker unreachable");
  });

  it("waits when the item left the state the plan read it in", async () => {
    const fake = fakeTracker("Done");
    const report = reportWith([move]);
    await applyPrOpenMoves(report, fake.tracker);
    expect(fake.moves).toEqual([]);
    expect(report.prOpenMoves?.[0]).toMatchObject({ outcome: "waits" });
  });

  it("waits when the tick has run out of time", async () => {
    const fake = fakeTracker("In Progress");
    const report = reportWith([move]);
    await applyPrOpenMoves(report, fake.tracker, () => "out of time");
    expect(fake.moves).toEqual([]);
    expect(report.prOpenMoves?.[0]).toMatchObject({
      outcome: "waits",
      detail: "out of time",
    });
  });
});

describe("jig dispatch and a stalled pickup's pull request", () => {
  let current: World | null = null;
  afterEach(() => {
    if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
    current?.close();
    current = null;
  });

  /** Issue #12 picked up by a pass that ended after claiming it, its workspace left on its branch with no agent, and `prs` open. */
  async function ended(body: string, head = BRANCH): Promise<World> {
    const w = world();
    current = w;
    w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
  states:
    pr_open: PR Open
dispatch:
  identity: factory-bot
`);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
    const [launched] = (await applyTick(w, false)).repos[0]?.launches ?? [];
    const id = String(launched?.record);
    const path = readRecord(id, dispatchState(w))?.workspace?.path ?? "";
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
    writeFileSync(join(w.dir, "claude-exit"), "0");
    await waitFor("the exit", () => exitWritten(w, id));
    w.setWorkspaces([{ branch: BRANCH, path, agents: [] }]);
    w.setPrs("open", [{ ...openPr(31, head), body, isCrossRepository: false }]);
    return w;
  }

  async function report(w: World): Promise<TickReceipt> {
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    return JSON.parse(r.stdout) as TickReceipt;
  }

  it("plans the move to pr_open from the tick's own reads, and no stall need", async () => {
    const w = await ended("Closes #12");
    const repo = (await report(w)).repos[0];
    expect(repo?.prOpenMoves).toEqual([
      expect.objectContaining({
        target: "#12",
        pr: 31,
        branch: BRANCH,
        to: "PR Open",
      }),
    ]);
    expect(repo?.actions.filter((a) => a.target === "#12")).toEqual([]);
  });

  it("plans nothing for a pull request naming the item from a branch no launch worked on", async () => {
    const w = await ended("Closes #12", "12-another-fix");
    const repo = (await report(w)).repos[0];
    expect(repo?.prOpenMoves).toBeUndefined();
  });
});
