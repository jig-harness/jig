/**
 * A stalled pickup whose own tree holds the work it left is relaunched once
 * per head in that tree, to push and record it (`dispatch.stalled_relaunch:
 * finish-once`); `never` relaunches nothing, a second stall at the same head
 * is a person's, and a tree no open workspace holds stays a person's.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type LaunchRecord,
  type ReadRecord,
  readRecord,
  writeRecord,
} from "../lib/launches.ts";
import type { Slots } from "../lib/accounts.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import {
  pendingRelaunch,
  relaunchRecord,
  type RelaunchContext,
  runtimeChanged,
} from "../lib/actions/pickup-relaunch.ts";
import { pickupArms } from "../lib/pickup-arms.ts";
import { type PickupInput, planPickups } from "../lib/plan-pickups.ts";
import { unarmed } from "../lib/sources/ledger-arming.ts";
import { type PickupTree, readPickupTree } from "../lib/pickup-tree.ts";
import type { Workspace } from "../lib/runtime/port.ts";
import { dispatchSection } from "../lib/section.ts";
import { pickupPassArgv } from "../lib/session.ts";
import type {
  ClaimedItem,
  DispatchSection,
  RepoTarget,
  StalledRelaunch,
} from "../lib/types.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const NOW = Date.parse("2026-11-18T08:00:00Z");
const HOUR = 3_600_000;
const PATH = "/work/w12";
const HEAD = "1".repeat(40);
const ITEM: ClaimedItem = { key: "#12", title: "task", state: "In Progress" };

/** A headless pickup of #12 in `PATH` that ended, with `result`. */
function ended(
  extra: Partial<LaunchRecord> = {},
  result: ReadRecord["result"] = "failed",
): ReadRecord {
  return {
    record: {
      id: "20261118T060000Z-aaaaaaaa",
      token: "t",
      action: "pickup",
      repo: SLUG,
      item: "#12",
      pr: null,
      headless: true,
      released: false,
      claimedItems: ["#12"],
      createdAt: "2026-11-18T06:00:00.000Z",
      workspace: { id: "w12", path: PATH },
      ...extra,
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-18T06:30:00Z", code: 0, signal: null },
      process: null,
    },
    result,
  };
}

/** The tree holds one unpushed commit at `HEAD`. */
const unpushed = (): PickupTree => ({
  kind: "read",
  head: HEAD,
  unpushed: 1,
  uncommitted: 0,
});

const clean = (): PickupTree => ({
  kind: "read",
  head: HEAD,
  unpushed: 0,
  uncommitted: 0,
});

const open: Workspace = {
  id: "w12",
  path: PATH,
  branch: "12-task",
  items: ["#12"],
  prs: [],
  agents: [],
  unverifiableTerminals: 0,
  comment: "",
  unread: null,
  name: "w12",
};

function input(
  launches: ReadRecord[],
  options: {
    relaunch?: StalledRelaunch;
    tree?: () => PickupTree;
    workspaces?: Workspace[];
    rerunsHeld?: string | null;
  } = {},
): PickupInput {
  return {
    slug: SLUG,
    section: {
      stalledAfterMs: HOUR / 2,
      blockedAfterMs: HOUR,
      stalledScope: "claimed",
      stalledRelaunch: options.relaunch ?? "finish-once",
    } as DispatchSection,
    pickups: [],
    claimed: [ITEM],
    sessions: {
      ok: true,
      source: "fake",
      workspaces: options.workspaces ?? [open],
    },
    launches,
    idleSince: new Map([["#12", NOW - 2 * HOUR]]),
    nowMs: NOW,
    trees: options.tree ?? unpushed,
    rerunsHeld: options.rerunsHeld ?? null,
  };
}

const relaunches = (plan: ReturnType<typeof planPickups>) =>
  plan.actions.filter((a) => a.relaunch !== undefined);
const stalls = (plan: ReturnType<typeof planPickups>) =>
  plan.actions.filter((a) => a.cause === "stalled");

it.each(["claimed-carried", "claimed-merged"] as const)(
  "honors a %s pull request when the original pickup dependency clears",
  (classed) => {
    const source = ended({}, "waits");
    const pr = { number: 18, url: `https://github.com/${SLUG}/pull/18` };
    const plan = planPickups({
      ...input([source], { tree: clean }),
      conditionalHolds: [
        {
          item: ITEM.key,
          by: "pickup",
          at: "2026-11-18T07:00:00Z",
          title: ITEM.title,
          url: null,
          condition: { kind: "pr-merged", pr: 42 },
          resumeRecord: source.record.id,
          settled: "cleared",
        },
      ],
      prOpen: {
        prs: [],
        prOpen: () => null,
        owner: true,
        pickup: true,
        links: () => false,
        carried: {
          carriers: () => (classed === "claimed-carried" ? [pr] : []),
          drive: () => ({ kind: "driving" }),
          merged: () => (classed === "claimed-merged" ? [pr] : []),
        },
      },
    });
    expect(relaunches(plan)).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ class: classed, target: ITEM.key }),
    );
  },
);

describe("a stalled pickup's relaunch", () => {
  it("relaunches a stalled pickup whose tree holds an unpushed commit once, in that tree, and raises a need on a second stall at the same head", () => {
    const first = planPickups(input([ended()]));
    expect(stalls(first)).toEqual([]);
    expect(relaunches(first)).toEqual([
      expect.objectContaining({
        stage: "pickup",
        target: "#12",
        relaunch: {
          record: "20261118T060000Z-aaaaaaaa",
          workspace: { id: "w12", path: PATH, branch: "12-task" },
          head: HEAD,
        },
      }),
    ]);

    const relaunched = ended({
      id: "20261118T070000Z-bbbbbbbb",
      createdAt: "2026-11-18T07:00:00.000Z",
      relaunchOf: "20261118T060000Z-aaaaaaaa",
      relaunchHead: HEAD,
    });
    const second = planPickups(input([ended(), relaunched]));
    expect(relaunches(second)).toEqual([]);
    expect(stalls(second).map((a) => a.reason)).toEqual([
      expect.stringContaining(
        "relaunched once at that head (launch record 20261118T070000Z-bbbbbbbb)",
      ),
    ]);
  });

  it("relaunches a workspace whose runtime reports no branch, keeping it empty", () => {
    const plan = planPickups(
      input([ended()], { workspaces: [{ ...open, branch: "" }] }),
    );
    expect(relaunches(plan).map((a) => a.relaunch?.workspace)).toEqual([
      { id: "w12", path: PATH, branch: "" },
    ]);
  });

  it("relaunches again once the tree moved to another head", () => {
    const relaunched = ended({
      id: "20261118T070000Z-bbbbbbbb",
      createdAt: "2026-11-18T07:00:00.000Z",
      relaunchOf: "20261118T060000Z-aaaaaaaa",
      relaunchHead: "2".repeat(40),
    });
    expect(
      relaunches(planPickups(input([ended(), relaunched]))).map(
        (a) => a.relaunch?.record,
      ),
    ).toEqual(["20261118T070000Z-bbbbbbbb"]);
  });

  it("relaunches nothing under never, and raises the stall as before", () => {
    const plan = planPickups(input([ended()], { relaunch: "never" }));
    expect(relaunches(plan)).toEqual([]);
    expect(stalls(plan).map((a) => a.target)).toEqual(["#12"]);
  });

  it("raises the stall with the tree named where no open workspace holds it", () => {
    const plan = planPickups(input([ended()], { workspaces: [] }));
    expect(relaunches(plan)).toEqual([]);
    expect(stalls(plan).map((a) => a.reason)).toEqual([
      expect.stringContaining("no open workspace on this host holds that tree"),
    ]);
  });

  it("leaves a clean tree whose pass recorded a result to the stall need", () => {
    const plan = planPickups(input([ended()], { tree: clean }));
    expect(relaunches(plan)).toEqual([]);
    expect(stalls(plan).map((a) => a.target)).toEqual(["#12"]);
  });

  it("relaunches a pass that recorded no result whatever its tree holds", () => {
    const plan = planPickups(input([ended({}, null)], { tree: clean }));
    expect(relaunches(plan).map((a) => a.target)).toEqual(["#12"]);
  });

  it("waits for the host's health check before it relaunches", () => {
    const plan = planPickups(
      input([ended()], { rerunsHeld: "jig doctor dispatch fails" }),
    );
    expect(relaunches(plan)).toEqual([]);
    expect(stalls(plan)).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({
        target: "#12",
        why: expect.stringContaining("waits while jig doctor dispatch fails"),
      }),
    );
  });

  it("relaunches a pass whose result the host could not write once the health check passes, rather than asking a person", () => {
    const unwritten = { ...ended({}, null), unwritten: "2026-11-18T06:30:00Z" };
    const plan = planPickups({
      ...input([unwritten], { tree: clean }),
      idleSince: new Map([["#12", NOW]]),
    });
    expect(relaunches(plan).map((a) => a.target)).toEqual(["#12"]);
    expect(plan.actions.filter((a) => a.cause === "pickup-question")).toEqual(
      [],
    );
  });

  it("relaunches no pass that recorded done, which handed its item on", () => {
    const plan = planPickups(input([ended({}, "done")]));
    expect(relaunches(plan)).toEqual([]);
  });

  it("relaunches no batch's pickup", () => {
    const batch = ended({
      batchItems: [{ key: "#12", person: "p" }],
    } as Partial<LaunchRecord>);
    expect(relaunches(planPickups(input([batch])))).toEqual([]);
  });
});

describe("a relaunch's workspace branch", () => {
  const REPO: RepoTarget = {
    path: "/repos/web",
    slug: SLUG,
    defaultBranch: "main",
  };
  const SOURCE = ended({ runtime: "process", repoPath: REPO.path }).record;
  const state = { codexOptIn: { on: false } } as unknown as ApplyState;
  const slots = {
    account: { name: "a", vendor: "claude", configDir: "/home/a/.claude" },
  } as unknown as Slots;

  /** The relaunch record the planned relaunch of the stalled pickup starts. */
  function relaunchedRecord(): LaunchRecord {
    const [action] = relaunches(planPickups(input([ended()])));
    if (action?.relaunch === undefined) throw new Error("no relaunch planned");
    return relaunchRecord(state, SOURCE, action.relaunch, slots);
  }

  it("is kept by the relaunch's launch record and by a retry rebuilt from it", () => {
    const record = relaunchedRecord();
    expect(record.workspace).toEqual({
      id: "w12",
      path: PATH,
      branch: "12-task",
    });
    expect(record.relaunchOf).toBe(SOURCE.id);
    const retried = pendingRelaunch(record, SOURCE.id, {
      head: HEAD,
      workspace: record.workspace as NonNullable<LaunchRecord["workspace"]>,
    });
    expect(retried.workspace).toEqual({
      id: "w12",
      path: PATH,
      branch: "12-task",
    });
  });

  it("is compared with the runtime's branch only when the record kept one", async () => {
    const open = {
      id: "w12",
      path: PATH,
      branch: "moved",
      items: ["#12"],
      prs: [],
      agents: [],
    };
    const ctx = {
      sessions: async () => ({ ok: true, source: "t", workspaces: [open] }),
    } as unknown as RelaunchContext;
    // A record the previous version wrote has no branch: nothing to compare.
    expect(
      await runtimeChanged(ctx, "#12", { id: "w12", path: PATH }),
    ).toBeNull();
    expect(
      await runtimeChanged(ctx, "#12", {
        id: "w12",
        path: PATH,
        branch: "12-task",
      }),
    ).toContain("branch moved from 12-task to moved");
  });

  it("lets a relaunched process pickup that ends done with a drive@ handoff ask for its pull request's first drive", () => {
    const done: ReadRecord = {
      record: relaunchedRecord(),
      state: {
        kind: "ended",
        exit: { at: "2026-11-18T07:30:00Z", code: 0, signal: null },
        process: null,
      },
      result: "done",
      next: { address: `drive@${SLUG}#42` },
    };
    const pr = {
      number: 42,
      url: `https://github.com/${SLUG}/pull/42`,
      title: "task",
      headRefName: "12-task",
      headRefOid: HEAD,
      isCrossRepository: false,
    };
    const base = {
      number: 42,
      url: pr.url,
      title: pr.title,
      head: pr.headRefName,
    };
    const drive = unarmed(pr, base, {
      labels: null,
      adoption: null,
      nowMs: NOW,
      pickupArms: pickupArms([done], REPO),
    });
    expect(drive).toEqual(
      expect.objectContaining({
        class: "unarmed",
        why: expect.stringContaining(
          "its completed process pickup handed off the first drive",
        ),
        evidence: expect.objectContaining({ pickupArm: true }),
      }),
    );
  });
});

describe("dispatch.stalled_relaunch", () => {
  const read = (value?: string) => {
    const section = dispatchSection({
      dispatch: {
        identity: "factory-bot",
        ...(value === undefined ? {} : { stalled_relaunch: value }),
      },
    });
    return section.ok ? section.value.stalledRelaunch : section.failure.reason;
  };

  it("is finish-once by default, takes never, and refuses anything else", () => {
    expect(read()).toBe("finish-once");
    expect(read("never")).toBe("never");
    expect(read("always")).toContain(
      "dispatch.stalled_relaunch must be finish-once or never",
    );
  });
});

describe("the pickup pass's prompt", () => {
  const record = {
    id: "20261118T060000Z-aaaaaaaa",
    token: "0".repeat(32),
    action: "pickup",
    repo: SLUG,
    pr: null,
    item: "#12",
    vendor: "claude",
    model: null,
    effort: null,
    sessionId: null,
    servedPerson: "person",
  } as unknown as LaunchRecord;
  const prompt = (r: LaunchRecord) => pickupPassArgv(r, []).at(-1) ?? "";

  it("tells every pass to push its branch and record its result before it ends", () => {
    expect(prompt(record)).toContain(
      "Before this pass ends, for any reason, push the branch whenever it holds committed work",
    );
    expect(prompt(record)).toContain(
      "and record how the pickup ended with one of the result commands below",
    );
  });

  it("gives a relaunch the fixed push-and-record prompt, with no second claim", () => {
    const text = prompt({
      ...record,
      relaunchOf: "20261118T050000Z-cccccccc",
      relaunchHead: HEAD,
    });
    expect(text).toContain(
      "This pass finishes the stalled pickup 20261118T050000Z-cccccccc of #12",
    );
    expect(text).toContain("make no second claim");
    expect(text).not.toContain("Claim this served assignment");
    expect(text).toContain("dispatch result 20261118T060000Z-aaaaaaaa");
  });
});

describe("a pickup's tree", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    return r.stdout.toString().trim();
  }

  it("reads unpushed commits and uncommitted edits, and no untracked scratch", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-pickup-tree-"));
    dirs.push(root);
    const origin = join(root, "origin.git");
    const tree = join(root, "tree");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, tree);
    writeFileSync(join(tree, "a.txt"), "a\n");
    git(tree, "add", "a.txt");
    git(tree, "commit", "-q", "-m", "first");
    git(tree, "push", "-q", "origin", "HEAD:main");
    git(tree, "fetch", "-q", "origin");
    writeFileSync(join(tree, "scratch.json"), "{}\n");
    expect(readPickupTree(tree)).toEqual({
      kind: "read",
      head: git(tree, "rev-parse", "HEAD"),
      unpushed: 0,
      uncommitted: 0,
    });
    writeFileSync(join(tree, "a.txt"), "b\n");
    git(tree, "commit", "-q", "-am", "second");
    writeFileSync(join(tree, "a.txt"), "c\n");
    expect(readPickupTree(tree)).toEqual({
      kind: "read",
      head: git(tree, "rev-parse", "HEAD"),
      unpushed: 1,
      uncommitted: 1,
    });
  });

  it("says why a path that is no tree did not read", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-pickup-tree-"));
    dirs.push(root);
    expect(readPickupTree(join(root, "gone")).kind).toBe("unread");
  });
});

describe("a stalled pickup's relaunch, through the tick", () => {
  const BRANCH = "12-issue-12";
  let current: World | null = null;
  afterEach(() => {
    if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
    current?.close();
    current = null;
  });

  function commit(cwd: string, file: string): void {
    for (const args of [
      ["add", file],
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "work",
      ],
    ]) {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    }
  }

  /** A dry tick, to start or read the idle clock. */
  async function plan(w: World): Promise<TickReceipt> {
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    return JSON.parse(r.stdout) as TickReceipt;
  }

  /** Past `dispatch.stalled_after` (1s) since the idle clock started at `since`. */
  const past = (since: number) =>
    waitFor("dispatch.stalled_after", () => Date.now() - since > 1_500);

  it("relaunches the pickup once in the tree its pass left an unpushed commit in, and raises a need on a second stall at that head", async () => {
    const w = world();
    current = w;
    w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  stalled_after: 1s
`);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
    const [launched] = (await applyTick(w, false)).repos[0]?.launches ?? [];
    const id = String(launched?.record);
    const source = readRecord(id, dispatchState(w));
    const path = source?.workspace?.path ?? "";
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
    writeFileSync(join(w.dir, "claude-exit"), "0");
    await waitFor("the exit", () => exitWritten(w, id));
    w.setWorkspaces([{ branch: BRANCH, path, agents: [] }]);
    writeFileSync(join(path, "work.txt"), "work\n");
    commit(path, "work.txt");

    // A source whose run was already ended and cleaned up must not hand that state on.
    const stored = readRecord(id, dispatchState(w));
    if (stored !== null)
      writeRecord(
        { ...stored, runEndedAt: "2026-11-18T06:30:00.000Z" },
        dispatchState(w),
      );
    let since = Date.now();
    await plan(w);
    await past(since);
    const relaunched = (await applyTick(w, false)).repos[0];
    const [launch] = relaunched?.launches ?? [];
    expect(launch).toEqual(
      expect.objectContaining({ target: "#12", outcome: "launched" }),
    );
    expect(relaunched?.actions.filter((a) => a.cause === "stalled")).toEqual(
      [],
    );
    const again = String(launch?.record);
    const record = readRecord(again, dispatchState(w));
    expect(record).toEqual(
      expect.objectContaining({
        relaunchOf: id,
        workspace: expect.objectContaining({ path, branch: BRANCH }),
      }),
    );
    expect(record?.runEndedAt).toBeUndefined();
    await waitFor("the relaunch", () => claudeRuns(w).length === 2);
    const run = claudeRuns(w)[1];
    expect(run?.cwd).toBe(path);
    expect(run?.argv.at(-1)).toContain(
      `This pass finishes the stalled pickup ${id} of #12`,
    );
    await waitFor("the relaunch's exit", () => exitWritten(w, again));

    since = Date.now();
    await plan(w);
    await past(since);
    const second = (await plan(w)).repos[0];
    expect(second?.actions.filter((a) => a.relaunch !== undefined)).toEqual([]);
    expect(
      second?.actions.filter((a) => a.cause === "stalled").map((a) => a.reason),
    ).toEqual([
      expect.stringContaining(
        `relaunched once at that head (launch record ${again})`,
      ),
    ]);
  }, 120_000);
});
