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
import {
  appendDirective,
  outboxRecordsForPr,
} from "../scripts/lib/state/mailbox.ts";
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
