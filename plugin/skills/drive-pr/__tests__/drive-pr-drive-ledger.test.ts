/**
 * drive-pr suite: drive.ts and the drive ledger on the pull request —
 * seeding a clone from it, yielding to a newer generation, refusing a
 * version it does not read, ignoring an untrusted ledger, refusing to drive
 * beside another clone's driver, the cross-clone takeover claim, and a driver
 * standing down at a round boundary on a newer claim. The stub forge's
 * comments are `issue-comments.json` in the fixture directory.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Ledger,
  ledgerFromState,
  renderClaim,
  renderLedger,
} from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import {
  type Fixture,
  makeScratchRepo,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";

useDrivePrSuite();

const LEDGER_ON = { env: { DRIVE_PR_LEDGER: "on" } };
const PASS = ["--no-head-sync", "--", "sh", "-c", ": pass for 999"];
const OTHER_ACTOR = "wt-0123456789abcdef";
const SHA = "a91d4f7c05444444444444444444444444444444";

function ledger(
  generation: number,
  round: number,
  driver: Partial<Ledger["driver"]> = {},
): Ledger {
  return ledgerFromState(
    {
      ...freshState(999),
      rounds: round,
      phase: "pass",
      lastCountedHead: SHA,
      parked: [
        {
          key: "PRRT_parked",
          kind: "thread",
          reason: "Choose the schema: a person decides.",
          round: 1,
          at: "2026-10-01T10:00:00.000Z",
        },
      ],
      held: [
        {
          key: "PRRT_held",
          kind: "thread",
          outcome: "accepted",
          round: round,
          actor: OTHER_ACTOR,
          commentUrl: "https://example.invalid/held",
          verifiedSha: SHA,
        },
      ],
    },
    {
      generation,
      driver: {
        actor: OTHER_ACTOR,
        account: null,
        clone: "clone-elsewhere",
        heartbeat: new Date().toISOString(),
        state: "stopped",
        exit: 8,
        ...driver,
      },
      narrative: ["The previous driver's last note."],
      claims: [],
    },
  );
}

function body(l: Ledger): string {
  const r = renderLedger(l);
  if ("error" in r) throw new Error(r.error);
  return r.body;
}

function comment(id: number, text: string, association = "MEMBER") {
  return {
    id,
    body: text,
    user: { login: association === "NONE" ? "drive-by" : "maintainer" },
    author_association: association,
    updated_at: "2026-10-01T11:00:00Z",
  };
}

function claim(clone: string, generation: number): string {
  return renderClaim({
    actor: OTHER_ACTOR,
    account: null,
    clone,
    generation,
    at: new Date().toISOString(),
  });
}

/** A fixture in a tree of its own, with `comments` added to the PR's. */
function withComments(name: string, f: Fixture, comments: unknown[]) {
  const tree = makeScratchRepo(`ledger-${name}`).dir;
  const { dir, stateDir } = writeFixture(f, tree);
  const file = join(dir, "issue-comments.json");
  const existing = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify([...existing, ...comments]));
  return { dir, stateDir, tree };
}

async function stateOf(stateDir: string, tree: string) {
  const got = await state(stateDir, ["get", "999"], tree);
  return JSON.parse(got.stdout);
}

describe("drive.ts seeds its state from the ledger", () => {
  it("seeds a fresh clone at the ledger's round, with its parked and held items", async () => {
    const { dir, stateDir, tree } = withComments(
      "fresh",
      { prState: "MERGED" },
      [comment(500, body(ledger(4, 3)))],
    );
    const r = await runDriveIn(dir, stateDir, PASS, tree, LEDGER_ON);
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("ledger: seeded from generation 4: round 3");
    const s = await stateOf(stateDir, tree);
    expect(s.rounds).toBe(3);
    expect(s.parked.map((p: { key: string }) => p.key)).toEqual([
      "PRRT_parked",
    ]);
    expect(s.held.map((h: { key: string }) => h.key)).toEqual(["PRRT_held"]);
    expect(s.ledgerGeneration).toBeGreaterThanOrEqual(4);
  });

  it("yields to a ledger newer than its own state, and keeps a state newer than the ledger", async () => {
    for (const [local, expected] of [
      [2, 4],
      [6, 7],
    ] as const) {
      const { dir, stateDir, tree } = withComments(
        `yield-${local}`,
        { prState: "MERGED" },
        [comment(500, body(ledger(5, 4)))],
      );
      writeFileSync(
        join(stateDir, "drive-pr-999.json"),
        JSON.stringify({
          ...freshState(999),
          rounds: 7,
          ledgerGeneration: local,
        }),
      );
      const r = await runDriveIn(dir, stateDir, PASS, tree, LEDGER_ON);
      expectSpawnExit({ ...r, stdout: null }, 5);
      expect((await stateOf(stateDir, tree)).rounds).toBe(expected);
    }
  });

  it("refuses a ledgerVersion it does not read, naming it", async () => {
    const v9 = body(ledger(4, 3)).replace(
      '"ledgerVersion":1',
      '"ledgerVersion":9',
    );
    const { dir, stateDir, tree } = withComments(
      "version",
      { prState: "MERGED" },
      [comment(500, v9)],
    );
    const r = await runDriveIn(dir, stateDir, PASS, tree, LEDGER_ON);
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).toContain("ledgerVersion 9");
    expect((await stateOf(stateDir, tree)).rounds).toBe(0);
  });

  it("ignores a ledger from an unassociated author, and reports it", async () => {
    const { dir, stateDir, tree } = withComments(
      "untrusted",
      { prState: "MERGED" },
      [comment(500, body(ledger(9, 6)), "NONE")],
    );
    const r = await runDriveIn(dir, stateDir, PASS, tree, LEDGER_ON);
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("ledger: ignoring comment 500 by drive-by");
    expect((await stateOf(stateDir, tree)).rounds).toBe(0);
  });
});

describe("drive.ts and another clone's driver", () => {
  const FIVE_HOURS_AGO = () =>
    new Date(Date.now() - 5 * 3600_000).toISOString();

  it("refuses a plain arm beside a running driver in another clone", async () => {
    const { dir, stateDir, tree } = withComments(
      "beside",
      { prState: "MERGED" },
      [comment(500, body(ledger(4, 3, { state: "running" })))],
    );
    const r = await runDriveIn(dir, stateDir, PASS, tree, LEDGER_ON);
    expectSpawnExit({ ...r, stdout: null }, 13);
    expect(r.stderr).toContain("driven from another clone");
    expect(r.stderr).not.toContain("--take-over");
  });

  it("refuses a takeover while the other clone's heartbeat is fresh", async () => {
    const { dir, stateDir, tree } = withComments(
      "fresh-heartbeat",
      { prState: "MERGED" },
      [comment(500, body(ledger(4, 3, { state: "running" })))],
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--take-over", ...PASS],
      tree,
      LEDGER_ON,
    );
    expectSpawnExit({ ...r, stdout: null }, 11);
    expect(r.stderr).toContain("within the 240-minute lease window");
  });

  it("stands down when a rival's claim on the same generation came first", async () => {
    const { dir, stateDir, tree } = withComments(
      "claim-lost",
      { prState: "MERGED" },
      [
        comment(
          500,
          body(ledger(4, 3, { state: "running", heartbeat: FIVE_HOURS_AGO() })),
        ),
        comment(600, claim("clone-rival", 4)),
      ],
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--take-over", ...PASS],
      tree,
      LEDGER_ON,
    );
    expectSpawnExit({ ...r, stdout: null }, 20);
    expect(r.stderr).toContain("standing down. Claim 600");
    // It posted its claim, append-only, and seeded nothing.
    const posted = readFileSync(join(dir, "posted.jsonl"), "utf8");
    expect(posted).toContain("drive-pr-takeover-claim");
    expect((await stateOf(stateDir, tree)).rounds).toBe(0);
  });

  it("takes the drive over when its claim is the earliest, seeding and recording it", async () => {
    const { dir, stateDir, tree } = withComments(
      "claim-won",
      { prState: "MERGED" },
      [
        comment(
          500,
          body(ledger(4, 3, { state: "running", heartbeat: FIVE_HOURS_AGO() })),
        ),
        // A rival claim posted after this driver's (the stub's ids start at 9001).
        comment(99_999, claim("clone-rival", 4)),
      ],
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--take-over", ...PASS],
      tree,
      LEDGER_ON,
    );
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("claimed PR #999's drive (comment 9001");
    const s = await stateOf(stateDir, tree);
    expect(s.rounds).toBe(3);
    expect(s.takeovers.map((t: { verdict: string }) => t.verdict)).toEqual([
      "STALE",
    ]);
    expect(s.takeovers[0].fromActor).toBe(OTHER_ACTOR);
  });
});

describe("drive.ts stands down at a round boundary on a newer claim", () => {
  it("exits TAKEN_OVER without another pass once another clone's claim appears", async () => {
    const { dir, stateDir, tree } = withComments(
      "boundary",
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [],
    );
    // The pass stands in for time passing: another clone claims the drive.
    const claimFile = join(dir, "claim.json");
    writeFileSync(
      claimFile,
      JSON.stringify(comment(99_990, claim("clone-elsewhere", 1))),
    );
    const addClaim = `const fs=require("node:fs");const f=${JSON.stringify(join(dir, "issue-comments.json"))};fs.writeFileSync(f,JSON.stringify([...JSON.parse(fs.readFileSync(f,"utf8")),JSON.parse(fs.readFileSync(${JSON.stringify(claimFile)},"utf8"))]))`;
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        'echo "pass for 999: RAN_THE_PASS" >&2',
        `"$LEDGER_TEST_BUN" -e "$LEDGER_TEST_ADD_CLAIM"`,
      ].join("\n"),
    ];
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "3", "--", ...pass],
      tree,
      {
        env: {
          DRIVE_PR_LEDGER: "on",
          LEDGER_TEST_BUN: process.execPath,
          LEDGER_TEST_ADD_CLAIM: addClaim,
        },
      },
    );
    expectSpawnExit({ ...r, stdout: null }, 20);
    expect(r.stderr).toContain("taken over. Another clone");
    expect(r.stderr).toContain("comment 99990");
    expect(r.stderr.match(/RAN_THE_PASS/g)?.length).toBe(1);
    // The round boundary before the pass wrote the ledger; nothing after.
    const posted = readFileSync(join(dir, "posted.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes("drive-pr-ledger"));
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted.at(-1)).not.toContain('\\"state\\":\\"stopped\\"');
  }, 120_000);
});
