/**
 * drive-pr suite: the resolution receipt a re-arm leaves for each park it
 * unparks. `unpark --stdin` writes it in the mutation that removes the park,
 * the state keeps the newest few, and the ledger carries them redacted,
 * reads them back, seeds them into another clone and cuts them first.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  gitCleanEnv,
  park,
  scratchClean,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { state } from "./drive-loop-harness.ts";
import { fixtureStateTree } from "./scoped-state-dir.ts";
import { refusal } from "../scripts/lib/state/unpark.ts";
import {
  type ConsumedVerdict,
  keptReceipts,
  parkOccurrence,
  parseConsumed,
  receiptsFor,
  RESOLVED_PARKS_KEPT,
  type ResolutionReceipt,
} from "../scripts/lib/state/resolution-receipt.ts";
import {
  ledgerFromState,
  parseLedger,
  renderLedger,
  seedFromLedger,
} from "../scripts/lib/state/ledger.ts";
import { freshState, type DriveState } from "../scripts/lib/state/schema.ts";

useDrivePrSuite();

const ANSWER = {
  author: "ana",
  at: "2026-11-10T10:00:00.000Z",
  url: "https://example.test/pr/999#issuecomment-1",
  body: "answer PRRT_a: approve [3fa9c2d1e0b4]",
  bodyHash: "h",
  choice: {
    option: "Keep",
    recommended: true,
    form: "approve" as const,
    digest: "3fa9c2d1e0b4",
  },
};

function receipt(
  key: string,
  over: Partial<ResolutionReceipt> = {},
): ResolutionReceipt {
  return {
    key,
    kind: "thread",
    reason: "Keep the flag?",
    parkedAt: "2026-11-10T09:00:00.000Z",
    outcome: "answered",
    answers: [],
    resolvedAt: "2026-11-10T11:00:00.000Z",
    ...over,
  };
}

async function unparkWith(
  stateDir: string,
  keys: string[],
  consumed: ConsumedVerdict[],
): Promise<void> {
  const proc = Bun.spawn(
    scriptArgv(
      join(SCRIPTS, "drive-state.ts"),
      "unpark",
      "999",
      "--stdin",
      ...keys.flatMap((k) => ["--key", k]),
    ),
    {
      cwd: fixtureStateTree(stateDir),
      env: {
        ...gitCleanEnv(),
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
      },
      stdin: new TextEncoder().encode(JSON.stringify(consumed)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expectSpawnExit({ stdout, stderr, exitCode }, 0);
}

async function stored(stateDir: string): Promise<DriveState> {
  return JSON.parse((await state(stateDir, ["get", "999"])).stdout);
}

describe("unpark --stdin leaves a resolution receipt", () => {
  it("writes each removed park's receipt in the same mutation, without the answers' bodies", async () => {
    const { stateDir } = writeFixture({}, scratchClean.dir);
    await park(stateDir, "PRRT_a", "thread");
    await park(stateDir, "PRRT_b", "thread");
    const parks = (await stored(stateDir)).parked;
    await unparkWith(
      stateDir,
      ["PRRT_a", "PRRT_b"],
      [
        { key: "PRRT_a", answers: [ANSWER] },
        { key: "PRRT_b", provisional: true, answers: [] },
      ],
    );
    const after = await stored(stateDir);
    expect(after.parked).toEqual([]);
    const got = after.resolvedParks ?? [];
    expect(got.map((r) => [r.key, r.outcome, r.parkedAt])).toEqual([
      ["PRRT_a", "answered", parks[0]?.at ?? "a park time"],
      ["PRRT_b", "provisional", parks[1]?.at ?? "a park time"],
    ]);
    expect(got[0]?.answers[0]).not.toHaveProperty("body");
    expect(got[0]?.answers[0]?.choice?.option).toBe("Keep");
    expect(got[0]?.answeredAt).toBe(ANSWER.at);
    expect(got[0]?.class).toBe(parks[0]?.class);
  });

  it("writes none without --stdin, as a person's hand unpark", async () => {
    const { stateDir } = writeFixture({}, scratchClean.dir);
    await park(stateDir, "PRRT_a", "thread");
    const done = await state(stateDir, ["unpark", "999", "--key", "PRRT_a"]);
    expectSpawnExit({ ...done, stderr: null }, 0);
    expect((await stored(stateDir)).resolvedParks).toBeUndefined();
  });

  it("refuses a verdict list that leaves a removed park uncovered", () => {
    const parked = [
      { key: "a", kind: "thread" as const, round: 1, reason: "q", at: "t" },
      { key: "b", kind: "thread" as const, round: 1, reason: "q", at: "t" },
    ];
    expect(
      refusal(parked, ["a", "b"], [], false, [{ key: "a", answers: [] }]),
    ).toContain("b");
    expect(
      refusal(parked, ["a", "b"], [], false, [
        { key: "a", answers: [] },
        { key: "b", answers: [] },
      ]),
    ).toBeNull();
    expect(refusal(parked, ["a", "b"], [], false, null)).toBeNull();
  });

  it("refuses verdicts that do not read, unparking nothing", async () => {
    expect(parseConsumed("not json")).toBeString();
    expect(parseConsumed(JSON.stringify([{ key: "a" }]))).toBeString();
    expect(
      parseConsumed(JSON.stringify([{ key: "a", answers: [] }])),
    ).toBeString();
    expect(
      parseConsumed(
        JSON.stringify([{ key: "a", provisional: true, answers: [] }]),
      ),
    ).toEqual([{ key: "a", provisional: true, answers: [] }]);
  });
});

describe("receipts", () => {
  it("name no occurrence for a park with no time, nor one no verdict names", () => {
    const parked = [
      { key: "a", kind: "thread" as const, reason: "q", round: 1 },
      {
        key: "b",
        kind: "thread" as const,
        reason: "q",
        round: 1,
        at: "2026-11-10T09:00:00.000Z",
      },
    ];
    expect(
      receiptsFor(parked, [{ key: "a", answers: [] }], "2026-11-10T11:00:00Z"),
    ).toEqual([]);
  });

  it("keep the newest few", () => {
    const many = Array.from({ length: RESOLVED_PARKS_KEPT + 3 }, (_, i) =>
      receipt(`k${i}`),
    );
    const kept = keptReceipts(many.slice(0, 5), many.slice(5));
    expect(kept).toHaveLength(RESOLVED_PARKS_KEPT);
    expect(kept.at(-1)?.key).toBe(`k${RESOLVED_PARKS_KEPT + 2}`);
  });

  it("keep a whole fresh batch, however many it is", () => {
    const fresh = Array.from({ length: RESOLVED_PARKS_KEPT + 2 }, (_, i) =>
      receipt(`f${i}`),
    );
    const kept = keptReceipts([receipt("old")], fresh);
    expect(kept.map((r) => r.key)).toEqual(fresh.map((r) => r.key));
    const mixed = keptReceipts(
      Array.from({ length: RESOLVED_PARKS_KEPT }, (_, i) => receipt(`o${i}`)),
      [receipt("n1"), receipt("n2")],
    );
    expect(mixed).toHaveLength(RESOLVED_PARKS_KEPT);
    expect(mixed.slice(-2).map((r) => r.key)).toEqual(["n1", "n2"]);
  });

  it("tell two occurrences of one key apart by the time each was parked", () => {
    const a = parkOccurrence("o/r", 7, {
      key: "k",
      digest: "3fa9c2d1e0b4",
      parkedAt: "2026-11-10T09:00:00.000Z",
    });
    const b = parkOccurrence("o/r", 7, {
      key: "k",
      digest: "3fa9c2d1e0b4",
      parkedAt: "2026-11-10T09:30:00.000Z",
    });
    expect(a).not.toBe(b);
  });
});

describe("the ledger carries the receipts", () => {
  const driver = {
    actor: "agent@host",
    clone: "clone",
    state: "stopped" as const,
    heartbeat: "2026-11-10T11:00:00.000Z",
  };
  const withReceipts = (receipts: ResolutionReceipt[]): DriveState => ({
    ...freshState(999),
    resolvedParks: receipts,
  });

  it("redacts the question and the note, reads back and seeds another clone", () => {
    const r = receipt("PRRT_a", {
      reason: "Tell ana@example.test?",
      answers: [
        {
          author: ANSWER.author,
          at: ANSWER.at,
          url: ANSWER.url,
          choice: { ...ANSWER.choice, note: "cc ana@example.test" },
        },
      ],
    });
    const ledger = ledgerFromState(withReceipts([r]), {
      generation: 3,
      driver,
      narrative: [],
      claims: [],
    });
    const rendered = renderLedger(ledger);
    if ("error" in rendered) throw new Error(rendered.error);
    const parsed = parseLedger(rendered.body);
    if (parsed?.kind !== "ledger") throw new Error("the ledger did not read");
    const back = parsed.ledger.resolvedParks ?? [];
    expect(back[0]?.reason).toBe("Tell <redacted>?");
    expect(back[0]?.answers[0]?.choice?.note).toBe("cc <redacted>");
    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state.resolvedParks?.map((x) => x.key)).toEqual(["PRRT_a"]);
  });

  it("cuts the receipts first when the ledger nears the forge's limit", () => {
    const ledger = ledgerFromState(
      withReceipts([receipt("PRRT_a", { reason: "x".repeat(4000) })]),
      { generation: 3, driver, narrative: [], claims: [] },
    );
    const whole = renderLedger(ledger);
    if ("error" in whole) throw new Error(whole.error);
    const cut = renderLedger(ledger, Buffer.byteLength(whole.body) - 100);
    if ("error" in cut) throw new Error(cut.error);
    expect(cut.ledger.cut).toEqual(["the resolved parks"]);
    expect(cut.ledger.resolvedParks).toEqual([]);
  });

  it("remembers a receipt loss through reseeding and the next render", () => {
    const lost: DriveState = {
      ...withReceipts([receipt("PRRT_a")]),
      resolvedParksLost: true,
    };
    const ledger = ledgerFromState(lost, {
      generation: 3,
      driver,
      narrative: [],
      claims: [],
    });
    expect(ledger.cut).toEqual(["the older resolved parks"]);
    const rendered = renderLedger(ledger);
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.ledger.cut).toEqual(["the older resolved parks"]);
    const parsed = parseLedger(rendered.body);
    if (parsed?.kind !== "ledger") throw new Error("the ledger did not read");
    const seeded = seedFromLedger(freshState(999), parsed.ledger);
    if ("error" in seeded) throw new Error(seeded.error);
    expect(seeded.state.resolvedParksLost).toBe(true);
    const again = renderLedger(
      ledgerFromState(seeded.state, {
        generation: 4,
        driver,
        narrative: [],
        claims: [],
      }),
    );
    if ("error" in again) throw new Error(again.error);
    expect(again.ledger.cut).toEqual(["the older resolved parks"]);
  });
});
