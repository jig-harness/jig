/**
 * dispatch: one tick in two phases. Every repository is observed at once,
 * each under its observe lock, then acted on in turn under the act lock
 * (`tick.lock`). A tick for one repository reads and acts while another
 * tick observes a different one; a repository another tick holds is not
 * read; no tick acts while another holds the act lock, as a tick of an
 * earlier version holds it; the launches admitted are those a sequential
 * tick admitted on the same fixtures; and while the forge's budget is low
 * the optional reads are skipped. Each tick runs in a child with its own
 * home (fixtures.ts), the locks as real files in its state directory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { bootId } from "../../shared/liveness.ts";
import { processTable } from "../../shared/process-table.ts";
import { dump } from "../../shared/yaml.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  claimed,
  dispatchState,
  earlierRecord,
  exitWritten,
  waitFor,
} from "./launch-fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

/**
 * A tick over the repositories its arguments name, with `options` beside
 * them. With `block`, the runtime's answer waits until the fake's `release`
 * file appears, after writing `observing`: the tick is held in its observe
 * phase until the test lets it go.
 */
const tickScript = (options: Record<string, unknown>, block = false) => `
import { existsSync, writeFileSync } from "node:fs";
import { orcaRuntime } from ${JSON.stringify(`${DISPATCH}/lib/runtime/orca.ts`)};
import { runTick } from ${JSON.stringify(`${DISPATCH}/tick.ts`)};
const F = process.env.DISPATCH_FAKE_DIR;
const orca = orcaRuntime();
const runtime = ${block} ? {
  ...orca,
  name: orca.name,
  interactiveBinding: orca.interactiveBinding,
  sessions: async (repo, join) => {
    writeFileSync(F + "/observing", "");
    const until = Date.now() + 30000;
    while (!existsSync(F + "/release") && Date.now() < until) await Bun.sleep(25);
    return orca.sessions(repo, join);
  },
  sessionsOnce: undefined,
} : undefined;
const result = await runTick({ repos: process.argv.slice(2), followupSince: "2026-10-30T00:00:00Z", ...(runtime ? { runtime } : {}), ...${JSON.stringify(options)} });
if ("held" in result) { console.error(result.held); process.exit(3); }
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`;

let current: World | null = null;
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  current?.close();
  current = null;
});

/** A world with a quota-parked pull request, a second checkout of the same repository, and a checkout of another one. */
function fixture(): { w: World; second: string; other: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const second = join(w.root, "second");
  mkdirSync(second, { recursive: true });
  const other = join(w.root, "other");
  mkdirSync(other, { recursive: true });
  return { w, second, other };
}

function entry(w: World, name: string, script: string): string {
  const path = join(w.root, name);
  writeFileSync(path, script);
  return path;
}

/** Where a repository's observe lock lives, as `receipts.ts` names it. */
function observeLock(w: World, path: string): string {
  const digest = createHash("sha256").update(resolve(path)).digest("hex");
  return join(dispatchState(w), "observe", `${digest.slice(0, 16)}.lock`);
}

const actLock = (w: World) => join(dispatchState(w), "tick.lock");

const paths = (r: TickReceipt) => r.repos.map((repo) => repo.path);

describe("a tick for one repository beside a sweep", () => {
  it("reads and acts on its repository while another tick observes a different one, and leaves a repository another tick holds alone", async () => {
    const { w, second, other } = fixture();
    const blocking = entry(w, "blocking.ts", tickScript({}, true));
    const plain = entry(w, "plain.ts", tickScript({ actLockWaitMs: 1000 }));
    let sweepDone = false;
    const sweep = w.dispatch([w.repo], blocking).then((r) => {
      sweepDone = true;
      return r;
    });
    await waitFor("the sweep to observe", () =>
      existsSync(join(w.dir, "observing")),
    );
    // Observing: the sweep holds its repository's observe lock, not the act lock.
    expect(existsSync(observeLock(w, w.repo))).toBe(true);
    expect(existsSync(actLock(w))).toBe(false);

    const wake = await w.dispatch([other], plain);
    expectSpawnExit(wake, 0);
    expect(paths(JSON.parse(wake.stdout) as TickReceipt)).toEqual([other]);
    expect(sweepDone).toBe(false);

    // Another checkout of the repository the sweep observes: the repository is held, whichever checkout names it.
    const sibling = await w.dispatch([second], plain);
    expectSpawnExit(sibling, 3);
    expect(sibling.stderr).toContain("observe/");
    expect(sweepDone).toBe(false);

    // The repository the sweep holds: a tick for it reads nothing and ends as one that found it held.
    const same = await w.dispatch([w.repo], plain);
    expectSpawnExit(same, 3);
    expect(same.stderr).toContain(observeLock(w, w.repo));
    expect(sweepDone).toBe(false);

    writeFileSync(join(w.dir, "release"), "");
    const swept = await sweep;
    expectSpawnExit(swept, 0);
    expect(paths(JSON.parse(swept.stdout) as TickReceipt)).toEqual([w.repo]);
    expect(existsSync(observeLock(w, w.repo))).toBe(false);
    expect(existsSync(actLock(w))).toBe(false);
  }, 60_000);

  it("names the repositories another tick holds on its receipt, and still acts on the rest", async () => {
    const { w, other } = fixture();
    const blocking = entry(w, "blocking.ts", tickScript({}, true));
    const plain = entry(w, "plain.ts", tickScript({ actLockWaitMs: 1000 }));
    const sweep = w.dispatch([w.repo], blocking);
    await waitFor("the sweep to observe", () =>
      existsSync(join(w.dir, "observing")),
    );
    const both = await w.dispatch([w.repo, other], plain);
    expectSpawnExit(both, 0);
    const receipt = JSON.parse(both.stdout) as TickReceipt;
    expect(paths(receipt)).toEqual([other]);
    expect(receipt.busy?.map((b) => b.path)).toEqual([w.repo]);
    writeFileSync(join(w.dir, "release"), "");
    expectSpawnExit(await sweep, 0);
  }, 60_000);
});

describe("the act lock", () => {
  it("is never taken while another process holds tick.lock, as a tick of an earlier version does for its whole run", async () => {
    const { w } = fixture();
    mkdirSync(dispatchState(w), { recursive: true });
    // An earlier version's tick: tick.lock holding a live pid, with no identity beside it.
    writeFileSync(actLock(w), String(process.pid));
    const plain = entry(w, "plain.ts", tickScript({ actLockWaitMs: 1000 }));
    const held = await w.dispatch([w.repo], plain);
    expectSpawnExit(held, 3);
    expect(held.stderr).toContain(actLock(w));
    expect(readFileSync(actLock(w), "utf8")).toBe(String(process.pid));
    // It read, and wrote no receipt; its observe lock is given up.
    expect(existsSync(join(dispatchState(w), "receipts"))).toBe(false);
    expect(existsSync(observeLock(w, w.repo))).toBe(false);

    // Released, the next tick acts.
    rmSync(actLock(w));
    const free = await w.dispatch([w.repo], plain);
    expectSpawnExit(free, 0);
  }, 60_000);
});

/** A quota-parked drive's ledger. */
const parked = (n: number): Ledger => stoppedLedger(n, 16);

/** The launches of a tick, by repository path, target, account and outcome. */
const admitted = (r: TickReceipt, w: World, second: string) =>
  r.repos.flatMap((repo) =>
    (repo.launches ?? []).map((l) => [
      repo.path === w.repo ? "first" : repo.path === second ? "second" : "?",
      l.target,
      l.account ?? null,
      l.outcome,
      l.detail,
    ]),
  );

describe("admission", () => {
  it("admits, across two repositories' turns, the launches a sequential tick admitted: each account's slots and the opens' allowance in turn", async () => {
    const { w, second } = fixture();
    // Five parked drives: #7, #8 and #11 have workspaces, #9 and #10 need one opened.
    w.setPrs(
      "open",
      [7, 8, 9, 10, 11].map((n) => openPr(n, `feature/${n}`)),
    );
    for (const n of [7, 8, 9, 10, 11])
      w.setComments(n, [ledgerComment(n * 100 + 1, parked(n))]);
    w.setWorkspaces(
      [7, 8, 11].map((n) => {
        const path = join(w.root, `ws-${n}`);
        mkdirSync(path, { recursive: true });
        return { branch: `feature/${n}`, linkedPR: n, path };
      }),
    );
    const a = { ...account(w, "a", "a@example.com"), max: 2 };
    const b = { ...account(w, "b", "b@example.com"), max: 1 };
    mkdirSync(join(w.home, ".jig"), { recursive: true });
    writeFileSync(
      join(w.home, ".jig", "dispatch.yaml"),
      dump({
        repositories: [w.repo, second].map((path) => ({
          path,
          stages: ["rearm"],
        })),
        accounts: [a, b].map((x) => ({
          name: x.name,
          vendor: "claude",
          config_dir: x.dir,
          identity: x.identity,
          max_per_account: x.max,
        })),
      }),
    );
    const r = await w.dispatch(["--apply", "--json"]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(admitted(receipt, w, second)).toEqual(SEQUENTIAL);
    for (const repo of receipt.repos)
      for (const l of repo.launches ?? [])
        if (l.outcome === "launched")
          await waitFor("the exit", () => exitWritten(w, l.record ?? ""));
  }, 90_000);
});

const LAUNCHED =
  'orca terminal create: {"terminal":{"handle":"term-1"}}; the tab stays open after its run, since it is not recorded: Orca\'s answer names no terminal handle and shell PID';
const unopened = (n: number) =>
  `the workspace could not be opened: PR #${n}: cannot read origin's URLs (exit 2): error: No such remote 'origin'`;
const FULL = "no account has a free slot: a 2/2, b 1/1";

/**
 * What the tick that read and acted on each repository before reading the
 * next admitted on the fixture above: the account turn, the opens spent on
 * workspaces that fail to open, the slots filled, and the second turn left
 * waiting on them, each of its parked drives.
 */
const SEQUENTIAL = [
  ["first", "PR #7", "a", "launched", LAUNCHED],
  ["first", "PR #8", "b", "launched", LAUNCHED],
  ["first", "PR #9", "a", "refused", unopened(9)],
  ["first", "PR #10", "a", "refused", unopened(10)],
  ["first", "PR #11", "a", "launched", LAUNCHED],
  ...[7, 8, 9, 10, 11].map((n) => ["second", `PR #${n}`, null, "waits", FULL]),
];

const SERIAL_CATALOG = `areas:
  migrations:
    title: Migrations
    category: data
    paths: ["db/migrations/**"]
    workspace: []
    impliedBy: []
    deployTier: none
    serialize: true
`;

describe("a low budget", () => {
  /** Two converged drives on a serialized area, both conflicting, and a running one. */
  function serialized(): World {
    const { w } = fixture();
    w.setConfig(
      `${CONFIG}drive:\n  change_areas_catalog: .config/change-areas.yaml\n`,
    );
    w.setRepoFile(".config/change-areas.yaml", SERIAL_CATALOG);
    w.setPrs(
      "open",
      [8, 9].map((n) =>
        openPr(n, `feature/${n}`, { mergeable: "CONFLICTING" }),
      ),
    );
    for (const n of [8, 9]) {
      w.setComments(n, [
        ledgerComment(
          n * 100 + 1,
          stoppedLedger(n, 0, { verifiedSha: HEAD_SHA }),
        ),
      ]);
      w.setFiles(n, ["db/migrations/001.sql"]);
      writeFileSync(join(w.dir, `threads-${n}`), String(n - 7));
    }
    return w;
  }

  /** The `gh` calls beside the repository's own query, which reads every open pull request's threads with it whatever the budget. */
  const calls = (w: World) =>
    readFileSync(join(w.dir, "gh-calls.log"), "utf8")
      .split("\n")
      .filter((c) => !c.includes("query DispatchRepository"));

  it("reads serialization's files and threads while the budget is not low", async () => {
    const w = serialized();
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(receipt.lowBudget).toBeUndefined();
    expect(calls(w).some((c) => /pulls\/8\/files/.test(c))).toBe(true);
    expect(calls(w).some((c) => c.includes("reviewThreads"))).toBe(true);
  }, 60_000);

  it("skips them below a tenth of the limit, unplaces every drive of the serialized repository, and says so on the receipt", async () => {
    const w = serialized();
    writeFileSync(join(w.dir, "rate-remaining"), "120");
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(receipt.lowBudget).toEqual({
      remaining: 120,
      limit: 5000,
      skipped: [
        "thread samples",
        "serialization's changed files and threads",
        "the steward's linked pull requests and check histories",
      ],
    });
    expect(calls(w).some((c) => /pulls\/\d+\/files/.test(c))).toBe(false);
    expect(calls(w).some((c) => c.includes("reviewThreads"))).toBe(false);
    expect(calls(w).some((c) => c.includes("change-areas"))).toBe(false);
    const repo = receipt.repos[0];
    expect(repo?.actions).toEqual([]);
    for (const n of [8, 9])
      expect(repo?.unplaced).toContainEqual(
        expect.objectContaining({
          target: `PR #${n}`,
          reason: expect.stringContaining(
            "the forge's budget is low (120 of 5000 left",
          ),
        }),
      );
  }, 60_000);

  /** PR #7's drive, this machine's launch of it, its wrapper alive at round 2 with three unresolved threads. */
  async function runningDrive(): Promise<{ w: World; id: string }> {
    const { w } = fixture();
    const id = "20261101T080000Z-aaaaaaaa";
    const ledger = stoppedLedger(7, undefined, { round: 2 });
    w.setComments(7, [
      ledgerComment(701, {
        ...ledger,
        driver: {
          ...ledger.driver,
          state: "running",
          heartbeat: new Date().toISOString(),
        },
      } as Ledger),
    ]);
    writeFileSync(join(w.dir, "threads-7"), "3");
    const wrapper = Bun.spawn(["sleep", "120"]);
    closers.push(() => wrapper.kill());
    const row = (await processTable())?.find((r) => r.pid === wrapper.pid);
    earlierRecord(w, {
      id,
      account: "a",
      createdAt: new Date().toISOString(),
      round: 2,
    });
    claimed(w, id, {
      hostId: "",
      host: hostname(),
      bootId: bootId(),
      pid: wrapper.pid,
      start: row?.start ?? "",
      claimedAt: new Date().toISOString(),
    });
    return { w, id };
  }

  it("samples a running drive's unresolved threads while the budget is not low", async () => {
    const { w, id } = await runningDrive();
    expectSpawnExit(await w.dispatch(["--json"]), 0);
    expect(calls(w).some((c) => c.includes("reviewThreads"))).toBe(true);
    expect(
      readRecord(id, dispatchState(w))?.samples?.map((s) => s.round),
    ).toEqual([2]);
  }, 60_000);

  it("does not sample a running drive's threads below a tenth of the limit", async () => {
    const { w, id } = await runningDrive();
    writeFileSync(join(w.dir, "rate-remaining"), "120");
    expectSpawnExit(await w.dispatch(["--json"]), 0);
    expect(calls(w).some((c) => c.includes("reviewThreads"))).toBe(false);
    expect(readRecord(id, dispatchState(w))?.samples ?? []).toEqual([]);
  }, 60_000);
});
