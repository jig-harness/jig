/**
 * dispatch: the re-drives per change a repository asks for
 * (`dispatch.redrive.stalled`, `.conflict`, `.ci`), capped by the host's
 * `redrive_max`. A stall and a spent CI-repair budget are re-driven that many
 * times per head commit, a stop on a conflict that many times per pair of
 * head and base head; `0` hands such a stop to a person at once.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { ReadRecord } from "../lib/launches.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { NOT_SETTLED_DEFAULTS } from "../lib/not-settled-config.ts";
import {
  type RedriveCounts,
  redriveAllowanceOf,
  withRedrives,
} from "../lib/redrive-config.ts";
import { dispatchSection } from "../lib/section.ts";
import { classifyLedger, type PrFacts } from "../lib/sources/ledgers.ts";
import { settleOwnDrives } from "../lib/tick-shared.ts";
import type { DrivenPr } from "../lib/types.ts";
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
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const WINDOW = 240 * 60_000;
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);

describe("the re-drive allowance's configuration", () => {
  const section = (redrive: unknown) =>
    dispatchSection({ dispatch: { redrive } });

  it("reads each kind as a whole number, 0 or more, one when absent", () => {
    const read = section({ stalled: 2, ci: 0 });
    expect(read.ok && read.value.redrive).toEqual({
      stalled: 2,
      conflict: 1,
      ci: 0,
    });
    const none = dispatchSection({});
    expect(none.ok && none.value.redrive).toBeUndefined();
    for (const bad of [-1, 1.5, "two"])
      expect(section({ conflict: bad })).toMatchObject({
        ok: false,
        failure: {
          reason: "dispatch.redrive.conflict must be a whole number, 0 or more",
        },
      });
    expect(section({ stall: 2 })).toMatchObject({
      ok: false,
      failure: { reason: expect.stringContaining("unknown key(s): stall") },
    });
  });

  it("reads the host's redrive_max, one when absent", () => {
    const max = (body: string) => {
      const read = parseMachineConfigText(body, "dispatch.yaml");
      return read.ok ? read.value.redriveMax : read.failure.reason;
    };
    expect(max("")).toBe(1);
    expect(max("redrive_max: 3\n")).toBe(3);
    expect(max("redrive_max: 0\n")).toBe(0);
    expect(max("redrive_max: -1\n")).toContain(
      "redrive_max must be a whole number, 0 or more",
    );
  });

  it("caps what the repository asks for at the host's redrive_max", () => {
    const asked = { redrive: { stalled: 3, conflict: 0, ci: 2 } };
    expect(redriveAllowanceOf(asked, { redriveMax: 2 })).toEqual({
      stalled: 2,
      conflict: 0,
      ci: 2,
    });
    expect(redriveAllowanceOf(asked, null)).toEqual({
      stalled: 1,
      conflict: 0,
      ci: 1,
    });
    expect(redriveAllowanceOf({}, { redriveMax: 0 })).toEqual({
      stalled: 0,
      conflict: 0,
      ci: 0,
    });
    expect(redriveAllowanceOf({}, { redriveMax: 5 })).toEqual({
      stalled: 1,
      conflict: 1,
      ci: 1,
    });
  });
});

/** A drive of PR #7 stopped `exit`, as the tick reads it beside `forge`. */
function drive(exit: number, forge: PrFacts): DrivenPr {
  const ledger = stoppedLedger(7, exit);
  return {
    number: 7,
    url: `https://github.com/${SLUG}/pull/7`,
    title: "Pull request 7",
    head: "feature/7",
    ...classifyLedger(ledger, NOW, WINDOW, undefined, forge),
    evidence: {
      generation: ledger.generation,
      exit,
      heartbeat: ledger.driver.heartbeat,
      mergeable: forge.mergeable,
    },
  };
}

/** This machine's `n`th ended re-drive of PR #7 for `pr`'s change. */
function redrove(pr: DrivenPr, exit: number, n: number): ReadRecord {
  return {
    record: {
      version: 1,
      id: `20261107T11000${n}Z-aaaaaaaa`,
      token: "t",
      action: "rearm",
      repo: SLUG,
      repoPath: "/repo",
      pr: 7,
      item: null,
      account: "a",
      vendor: "claude",
      configDir: "/config-a",
      wallBackoffMs: 0,
      replaces: null,
      facts: `generation ${n}`,
      createdAt: `2026-11-07T11:00:0${n}.000Z`,
      workspace: null,
      attempts: [],
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
      redrive: pr.stale ?? null,
    },
    state: {
      kind: "ended",
      exit: { at: `2026-11-07T11:30:0${n}.000Z`, code: exit, signal: null },
      process: null,
    },
    result: null,
  };
}

/** Another host's ended re-drive claim on PR #7 for `change`. */
function claim(change: string): SharedClaim {
  const at = new Date(NOW - 60_000).toISOString();
  return {
    id: 1,
    stage: "drive",
    login: "drive-bot",
    createdAt: at,
    trusted: true,
    says: {
      ok: true,
      value: {
        pr: 7,
        attempt: 1,
        at,
        run: "tick",
        action: "rearm",
        record: "launch-1",
        host: "host-1",
        owner: true,
        facts: "generation 1",
        change,
        conflictStop: false,
        end: { state: "ended", at, exit: null, outcome: null },
        legacy: false,
      },
    },
  };
}

const allow = (counts: Partial<RedriveCounts>): RedriveCounts => ({
  stalled: 1,
  conflict: 1,
  ci: 1,
  ...counts,
});

/** The class PR #7 reads as once `records` and `claims` settle it under `allowance`. */
function settled(
  pr: DrivenPr,
  records: ReadRecord[],
  allowance: RedriveCounts,
  claims: SharedClaim[] = [],
): DrivenPr | undefined {
  const read = new Map([[7, { ok: true as const, value: claims }]]);
  return settleOwnDrives(
    [pr],
    records,
    read,
    "this-host",
    NOT_SETTLED_DEFAULTS,
    allowance,
  )[0];
}

describe("the re-drives allowed per change", () => {
  const mergeable = { head: HEAD, mergeable: "MERGEABLE" };
  for (const [exit, kind, forge] of [
    [14, "stalled", mergeable],
    [21, "ci", mergeable],
    [9, "conflict", { ...mergeable, base: { oid: BASE } }],
  ] as const) {
    it(`re-drives a stop ${exit} as many times as dispatch.redrive.${kind} allows at one change`, () => {
      const pr = drive(exit, forge);
      expect(pr.class).toBe("stale");
      const twice = allow({ [kind]: 2 });
      const one = [redrove(pr, exit, 1)];
      const two = [...one, redrove(pr, exit, 2)];
      expect(settled(pr, one, twice)?.class).toBe("stale");
      const spent = settled(pr, two, twice);
      expect(spent?.class).toBe("needs-person");
      expect(spent?.why).toContain(
        "already re-drove it for this change, the last of 2 re-drives there",
      );
      // Once, the default.
      expect(settled(pr, one, allow({}))?.class).toBe("needs-person");
      // None: a person's at once, with no re-drive made.
      const none = settled(pr, [], allow({ [kind]: 0 }));
      expect(none?.class).toBe("needs-person");
      expect(none?.why).toContain(
        `no re-drive of it is allowed (dispatch.redrive.${kind}, capped by this host's redrive_max, is 0)`,
      );
      // The allowance of another kind leaves it re-driven once.
      const other = kind === "stalled" ? "ci" : "stalled";
      expect(settled(pr, one, allow({ [other]: 2 }))?.class).toBe(
        "needs-person",
      );
    });
  }

  it("counts this host's re-drives and another host's together", () => {
    const pr = drive(14, mergeable);
    const change = pr.stale?.change ?? "";
    const twice = allow({ stalled: 2 });
    expect(settled(pr, [], twice, [claim(change)])?.class).toBe("stale");
    const spent = settled(pr, [redrove(pr, 14, 1)], twice, [claim(change)]);
    expect(spent?.class).toBe("needs-person");
    expect(spent?.why).toContain(
      "this host and another already re-drove it 2 times for this change, the most its repository allows",
    );
  });

  it("leaves a stop re-driven once per change whatever the allowance says", () => {
    const deadline = drive(15, { head: HEAD, mergeable: "MERGEABLE" });
    expect(deadline.class).toBe("stale");
    expect(
      withRedrives([deadline], allow({ stalled: 0, conflict: 0, ci: 0 })),
    ).toEqual([deadline]);
  });
});

const CONFIG = (stalled: number) => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  redrive:
    stalled: ${stalled}
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** The ledger as a drive that just stalled wrote it, its tree measured clean, its heartbeat now. */
function stall(generation: number): Ledger {
  const ledger = stoppedLedger(7, 14, {
    events: [
      {
        at: new Date().toISOString(),
        round: generation,
        kind: "stop",
        cause: "14",
        leftWork: false,
      },
    ],
  });
  return {
    ...ledger,
    generation,
    driver: { ...ledger.driver, heartbeat: new Date().toISOString() },
  };
}

/** PR #7, whose drive stalled, in a repository asking for `stalled` re-drives on a host allowing `max`. */
function fixture(stalled: number, max: number): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG(stalled));
  withOrigin(w);
  w.setPrs("open", [openPr(7, "feature/7", { mergeable: "MERGEABLE" })]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setComments(7, [ledgerComment(701, stall(3))]);
  w.setWorkspaces([{ branch: "feature/7", linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], { redrive_max: max }, [
    "rearm",
    "notify",
  ]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notified = (r: TickReceipt) =>
  (r.repos[0]?.notifications ?? []).map((n) => [n.target, n.cause, n.outcome]);

/** Run one tick that re-drives PR #7, which stalls again at the same head as generation `next`. */
async function redrive(w: World, next: number): Promise<string> {
  writeFileSync(join(w.dir, "drive-exit"), "14");
  const [launched] = launches(await tick(w));
  expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  const record = launched?.record ?? "";
  await waitFor("the exit", () => exitWritten(w, record));
  w.setComments(7, [ledgerComment(701, stall(next))]);
  return record;
}

describe("jig dispatch --apply re-drives a stall as often as its repository asks, within the host's cap", () => {
  it("re-drives a stall twice at one head with stalled: 2 and redrive_max: 2, then tells a person", async () => {
    const w = fixture(2, 2);
    await redrive(w, 4);
    const second = await redrive(w, 5);
    expect(driveRuns(w)).toHaveLength(2);

    const third = await tick(w);
    expect(launches(third)).toEqual([]);
    expect(notified(third)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(third.repos[0]?.actions[0]?.notice?.text).toContain(
      `launch record ${second} already re-drove it for this change, the last of 2 re-drives there, and ended 14: only a person settles it until its head moves`,
    );
  }, 240_000);

  it("re-drives it once with stalled: 2 when the host's redrive_max is 1", async () => {
    const w = fixture(2, 1);
    const record = await redrive(w, 4);

    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(notified(second)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(second.repos[0]?.actions[0]?.notice?.text).toContain(
      `launch record ${record} already re-drove it for this change and ended 14`,
    );
    expect(driveRuns(w)).toHaveLength(1);
  }, 180_000);

  it("hands a stall to a person at once with stalled: 0", async () => {
    const w = fixture(0, 2);
    const first = await tick(w);
    expect(launches(first)).toEqual([]);
    expect(notified(first)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(first.repos[0]?.actions[0]?.notice?.text).toContain(
      "no re-drive of it is allowed (dispatch.redrive.stalled, capped by this host's redrive_max, is 0): only a person settles it until its head moves",
    );
    expect(driveRuns(w)).toHaveLength(0);
  }, 180_000);
});
