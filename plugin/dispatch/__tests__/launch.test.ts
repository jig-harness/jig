/**
 * dispatch --apply: re-arms and takeovers launched within each account's
 * cap, through the wrapper, over the fake forge and a fake `orca` whose
 * terminals run their command, with a fake drive in place of `drive.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { processTable } from "../../shared/process-table.ts";
import { bootId } from "../lib/launches.ts";
import { writeWall } from "../lib/walls.ts";
import type { TickReceipt } from "../receipts.ts";
import {
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
  driveRuns,
  earlierRecord,
  exitWritten,
  machineFile,
  recordIds,
  dispatchState,
  terminalCreates,
  waitFor,
} from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const HEAD = "feature/7-parked";
const PASS = [
  "--bots-only",
  "--",
  "claude",
  "-p",
  "/jig:drive-pr --bots-only 7",
];

let current: World | null = null;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
  current?.close();
  current = null;
});

/** A quota-parked PR #7 whose workspace exists, and accounts a and b. */
function fixture(): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, HEAD)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  return { w, ws };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

describe("jig dispatch --apply launches re-arms within account caps", () => {
  it("re-arms a drive quota-parked on account a on account b, in one tick", async () => {
    const { w, ws } = fixture();
    const a = account(w, "a", "a@example.com");
    const b = account(w, "b", "b@example.com");
    machineFile(w, [a, b]);
    earlierRecord(w, { id: "20261030T200000Z-aaaaaaaa", account: "a" });
    claimed(
      w,
      "20261030T200000Z-aaaaaaaa",
      {
        host: hostname(),
        bootId: bootId(),
        pid: 1,
        start: "x",
        claimedAt: "2026-10-30T20:00:00.000Z",
      },
      16,
    );
    writeWall(
      { account: "a", resetAt: "2099-01-01T00:00:00.000Z", source: "test" },
      dispatchState(w),
    );
    // The latest record bills b, so the turn comes to a first: only the wall keeps it off a.
    earlierRecord(w, {
      id: "20261030T203000Z-eeeeeeee",
      account: "b",
      pr: 8,
      createdAt: "2026-10-30T20:30:00.000Z",
    });
    claimed(
      w,
      "20261030T203000Z-eeeeeeee",
      {
        host: hostname(),
        bootId: bootId(),
        pid: 1,
        start: "x",
        claimedAt: "2026-10-30T20:30:00.000Z",
      },
      0,
    );
    w.env.CLAUDE_CODE_OAUTH_TOKEN = "a-token-for-another-account";

    const receipt = await tick(w);
    const [launched] = launches(receipt);
    expect(launched?.outcome).toBe("launched");
    expect(launched?.account).toBe("b");
    await waitFor("the drive", () => driveRuns(w).length === 1);
    const [run] = driveRuns(w);
    expect(run?.argv).toEqual(["7", ...PASS]);
    expect(run?.configDir).toBe(b.dir);
    expect(run?.token).toBeNull();
    expect(realpathSync(run?.cwd ?? "")).toBe(realpathSync(ws));
    await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));
  });

  it("launches no second pass for a drive whose driver is live, and records its exit 11", async () => {
    const { w } = fixture();
    machineFile(w, [account(w, "a", "a@example.com")]);
    writeFileSync(join(w.dir, "drive-exit"), "11");
    const first = await tick(w);
    const record = launches(first)[0]?.record ?? "";
    expect(launches(first)[0]?.outcome).toBe("launched");
    await waitFor("the exit", () => exitWritten(w, record));

    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(second.repos[0]?.quiet).toContainEqual({
      target: "PR #7",
      class: "refused",
      why: `launch record ${record} ended 11, drive.ts's refusal, on these same ledger facts; it is not launched again until they change`,
    });
    expect(terminalCreates(w)).toHaveLength(1);
  });

  it("takes over a silent driver this machine started, in the replaced record's slot", async () => {
    const { w } = fixture();
    const ledger = stoppedLedger(7, undefined);
    w.setComments(7, [
      ledgerComment(701, {
        ...ledger,
        driver: {
          ...ledger.driver,
          state: "running",
          heartbeat: "2026-10-30T22:00:00.000Z",
        },
      }),
    ]);
    machineFile(w, [{ ...account(w, "a", "a@example.com"), max: 1 }]);
    const wedged = Bun.spawn(["sleep", "120"]);
    cleanups.push(() => wedged.kill());
    const row = (await processTable())?.find((r) => r.pid === wedged.pid);
    earlierRecord(w, { id: "20261030T210000Z-bbbbbbbb", account: "a" });
    claimed(w, "20261030T210000Z-bbbbbbbb", {
      host: hostname(),
      bootId: bootId(),
      pid: wedged.pid,
      start: row?.start ?? "",
      claimedAt: "2026-10-30T21:00:00.000Z",
    });

    const receipt = await tick(w);
    const [launched] = launches(receipt);
    expect(launched).toMatchObject({
      action: "takeover",
      outcome: "launched",
      account: "a",
    });
    await waitFor("the drive", () => driveRuns(w).length === 1);
    expect(driveRuns(w)[0]?.argv).toEqual(["7", "--take-over", ...PASS]);
    await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));
  });

  it("launches nothing while a record is pending", async () => {
    const { w } = fixture();
    machineFile(w, [account(w, "a", "a@example.com")]);
    writeFileSync(join(w.dir, "orca-terminal-noop"), "");
    expect(launches(await tick(w))[0]?.outcome).toBe("launched");
    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(second.repos[0]?.running[0]?.reason).toContain("is pending");
    expect(terminalCreates(w)).toHaveLength(1);
  });

  it("retries a lost launch answer only under its own record and key", async () => {
    const { w } = fixture();
    machineFile(w, [account(w, "a", "a@example.com")], {
      runtime_timeout: "2s",
    });
    writeFileSync(join(w.dir, "orca-terminal-hang"), "");
    const first = launches(await tick(w))[0];
    expect(first?.outcome).toBe("lost");
    rmSync(join(w.dir, "orca-terminal-hang"));

    const second = launches(await tick(w));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      outcome: "retried",
      record: first?.record,
    });
    expect(recordIds(w)).toEqual([first?.record ?? ""]);
    const commands = terminalCreates(w).map(
      (a) => a[a.indexOf("--command") + 1],
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
    await waitFor("the exit", () => exitWritten(w, first?.record ?? ""));
  });

  it("starts nothing when the account's directory resolves to another identity", async () => {
    const { w } = fixture();
    const b = account(w, "b", "someone-else@example.com");
    machineFile(w, [{ ...b, identity: "b@example.com" }]);
    const [refused] = launches(await tick(w));
    expect(refused?.outcome).toBe("refused");
    expect(refused?.detail).toBe(
      `identity check: ${b.dir} resolves to someone-else@example.com, not b@example.com`,
    );
    expect(terminalCreates(w)).toEqual([]);
    expect(recordIds(w)).toEqual([]);
  });

  it("waits, naming every account's slots, when no account is free", async () => {
    const { w } = fixture();
    machineFile(w, [account(w, "a", "a@example.com")]);
    writeWall(
      { account: "a", resetAt: "2099-01-01T00:00:00.000Z", source: "test" },
      dispatchState(w),
    );
    const [waiting] = launches(await tick(w));
    expect(waiting).toMatchObject({
      outcome: "waits",
      detail:
        "no account has a free slot: a 0/2 (walled until 2099-01-01T00:00:00.000Z)",
    });
  });
});
