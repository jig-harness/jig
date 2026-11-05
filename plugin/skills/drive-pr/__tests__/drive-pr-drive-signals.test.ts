/**
 * drive-pr suite: the signals one record now carries. The round a drive
 * counts is the review round record `current-round.ts` reads and the ledger
 * mirrors; a mailbox `stop` addressed to one driver generation ends that
 * driver and not the next, one naming no generation ends every later driver,
 * and the driver acknowledges each in the outbox.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { MAILBOX_STOPPED_EXIT, MAX_ROUNDS_EXIT } from "../scripts/drive.ts";
import { driveDb } from "../scripts/lib/state/db.ts";
import {
  appendDirective,
  appendOutboxRecord,
  outboxRecordsForPr,
} from "../scripts/lib/state/mailbox.ts";
import { generationAcked } from "../scripts/lib/state/mailbox-stop.ts";
import { parseLedger } from "../scripts/lib/state/ledger.ts";
import {
  binDir,
  gitCleanEnv,
  makeScratchRepo,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { PASS_LOUD, runDriveIn, state } from "./drive-loop-harness.ts";

useDrivePrSuite();

const CURRENT_ROUND = join(
  import.meta.dir,
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
  "current-round.ts",
);

const WORK = { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] };

/**
 * The round of the last drive ledger the stub forge was sent. The stub
 * appends each request's input as it came, one JSON object after another.
 */
function lastLedgerRound(dir: string): number {
  const bodies = readFileSync(join(dir, "posted.jsonl"), "utf8")
    .split(/(?=\{"body":)/)
    .filter((post) => post.includes("drive-pr-ledger-data"))
    .map((post) => (JSON.parse(post) as { body: string }).body);
  const parsed = parseLedger(bodies.at(-1) ?? "");
  if (parsed?.kind !== "ledger")
    throw new Error(`no ledger was posted: ${JSON.stringify(parsed)}`);
  return parsed.ledger.round;
}

describe("the review round record", () => {
  it("is the round the drive counted, the ledger carries and current-round.ts prints", async () => {
    const tree = makeScratchRepo("signals-round").dir;
    const { dir, stateDir } = writeFixture(WORK, tree);
    // Two rounds a hand-driven loop counted before the drive: the drive's
    // round counts on from them, and so does its budget.
    for (const head of ["1".repeat(40), "2".repeat(40)])
      expectSpawnExit(
        await state(stateDir, ["count-round", "999", "--head", head], tree),
        0,
      );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "3", "--", ...PASS_LOUD],
      tree,
      { env: { DRIVE_PR_LEDGER: "on" } },
    );
    expect(r.stderr).toContain("RAN_THE_PASS");
    const round = Bun.spawnSync([process.execPath, CURRENT_ROUND, "999"], {
      cwd: tree,
      env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: stateDir },
    });
    expectSpawnExit(round, 0);
    const printed = Number(round.stdout.toString().trim());
    expect(printed).toBe(3);
    expect(lastLedgerRound(dir)).toBe(printed);
  }, 120_000);
});

describe("the review round record counted from several loops", () => {
  const out = (r: Awaited<ReturnType<typeof state>>) =>
    r.stdout.toString().trim();

  it("settles only the rounds counted when the settle began", async () => {
    const tree = makeScratchRepo("signals-settle").dir;
    const { stateDir } = writeFixture(WORK, tree);
    for (const head of ["1".repeat(40), "2".repeat(40)])
      await state(stateDir, ["count-round", "999", "--head", head], tree);
    const mark = out(await state(stateDir, ["last-open-round", "999"], tree));
    expect(mark).toBe("2");
    await state(
      stateDir,
      ["count-round", "999", "--head", "3".repeat(40)],
      tree,
    );
    const settled = await state(
      stateDir,
      ["settle-rounds", "999", "--head", mark],
      tree,
    );
    expect(out(settled)).toBe("2");
    expect(out(await state(stateDir, ["open-rounds", "999"], tree))).toBe("1");
  }, 60_000);

  it("keeps the head the state counted before the table when another head is counted first", async () => {
    const tree = makeScratchRepo("signals-known").dir;
    const { stateDir } = writeFixture(WORK, tree);
    const [a, b] = ["a".repeat(40), "b".repeat(40)];
    expectSpawnExit(
      await state(stateDir, ["bump-round", "999", "--head", a], tree),
      0,
    );
    // A state kept from before the table: its counted head has no row.
    const drive = driveDb(stateDir);
    drive.db.run("DELETE FROM review_rounds WHERE clone = ?", [drive.clone]);
    expectSpawnExit(
      await state(stateDir, ["bump-round", "999", "--head", b], tree),
      0,
    );
    const again = await state(
      stateDir,
      ["count-round", "999", "--head", a],
      tree,
    );
    expect(JSON.parse(out(again))).toMatchObject({ round: 2, counted: false });
  }, 60_000);

  it("does not take an unknown command for an inherited member", async () => {
    const tree = makeScratchRepo("signals-proto").dir;
    const { stateDir } = writeFixture(WORK, tree);
    const r = await state(stateDir, ["__proto__", "999"], tree);
    expectSpawnExit(r, 2);
  }, 60_000);
});

describe("a mailbox stop and the driver generation it names", () => {
  /** The driver acknowledgements in the outbox, as [directive id, generation]. */
  const acks = (mailbox: string) => {
    const out = outboxRecordsForPr(mailbox, "999");
    if (!out.ok) throw new Error(out.why);
    return out.records
      .filter((rec) => rec.status === "ack")
      .map((rec) => [rec.id, rec.generation]);
  };
  const generationOf = (stderr: string) =>
    Number(/driver generation (\d+)/.exec(stderr)?.[1]);

  it("reads any acknowledgement of the generation as its stop having taken effect", async () => {
    const tree = makeScratchRepo("signals-ack").dir;
    const { dir } = writeFixture(WORK, tree);
    const mailbox = join(dir, "mailbox");
    const ack = (id: string, generation: number) =>
      appendOutboxRecord(mailbox, {
        id,
        ts: new Date().toISOString(),
        pr: "999",
        status: "ack",
        generation,
      });
    await ack("m-first", 2);
    expect(generationAcked(mailbox, "999", 2)).toBe(true);
    expect(generationAcked(mailbox, "999", 3)).toBe(false);
  });

  it("ends only the generation it names, while one naming none ends every later driver", async () => {
    const tree = makeScratchRepo("signals-stop").dir;
    const { dir, stateDir } = writeFixture(WORK, tree);
    const mailbox = join(dir, "mailbox");
    const drive = () =>
      runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_LOUD],
        tree,
        {
          env: {
            DRIVE_PR_MAILBOX_DIR: mailbox,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
          },
        },
      );

    // A clone's first driver of the pull request is generation 1.
    const addressed = await appendDirective(mailbox, "999", "test", "stop", {
      generation: 1,
    });
    const first = await drive();
    expectSpawnExit({ ...first, stdout: null }, MAILBOX_STOPPED_EXIT);
    expect(generationOf(first.stderr)).toBe(1);
    expect(first.stderr).not.toContain("RAN_THE_PASS");
    expect(acks(mailbox)).toEqual([[addressed.id, 1]]);

    // The next driver is not stopped by it: it runs its round, to its budget.
    const second = await drive();
    expectSpawnExit({ ...second, stdout: null }, MAX_ROUNDS_EXIT);
    expect(generationOf(second.stderr)).toBe(2);
    expect(second.stderr).toContain("RAN_THE_PASS");
    expect(acks(mailbox)).toEqual([[addressed.id, 1]]);

    // A stop naming no generation stops the next driver, and the one after.
    const everyone = await appendDirective(mailbox, "999", "test", "stop");
    const third = await drive();
    expectSpawnExit({ ...third, stdout: null }, MAILBOX_STOPPED_EXIT);
    const fourth = await drive();
    expectSpawnExit({ ...fourth, stdout: null }, MAILBOX_STOPPED_EXIT);
    expect(acks(mailbox)).toEqual([
      [addressed.id, 1],
      [everyone.id, 3],
      [everyone.id, 4],
    ]);
  }, 180_000);
});
