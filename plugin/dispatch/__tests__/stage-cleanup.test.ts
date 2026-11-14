/** Real driver-state witnesses decide whether a dispatch launch can release its account slot. */
import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { world } from "./fixtures.ts";
import { earlierRecord } from "./launch-fixtures.ts";

const plugin = resolve(import.meta.dir, "../..");
const modulePath = (path: string) => JSON.stringify(join(plugin, path));

it("holds retained own acquisitions and uncertain exits, while accepting released or unrelated witnesses", async () => {
  const w = world();
  const record = earlierRecord(w, {
    id: "20261104T090000Z-cccccccc",
    account: "a",
  });
  const outside = join(w.root, "not-a-checkout");
  mkdirSync(outside);
  const script = join(w.root, "cleanup-witnesses.ts");
  writeFileSync(
    script,
    `
import { driverCleanupUncertain } from ${modulePath("dispatch/lib/stage-cleanup.ts")};
import { readRecord, claimRecord } from ${modulePath("dispatch/lib/launches.ts")};
import { stateDb } from ${modulePath("dispatch/lib/state.ts")};
import { captureIdentity } from ${modulePath("shared/liveness.ts")};
import { currentIso } from ${modulePath("shared/time.ts")};
import { resolveStateDir } from ${modulePath("skills/drive-pr/scripts/lib/state/store.ts")};
import { acquire, release, prLockName } from ${modulePath("skills/drive-pr/scripts/lib/driver/locks.ts")};
import { writeDriverRecord } from ${modulePath("skills/drive-pr/scripts/lib/ledger-stop.ts")};
import { driveDb } from ${modulePath("skills/drive-pr/scripts/lib/state/db.ts")};
import { DRIVE_EXIT } from ${modulePath("skills/drive-pr/scripts/lib/status/terminal-states.ts")};
const record = readRecord(${JSON.stringify(record.id)});
const capture = await captureIdentity();
if (!record || !capture.ok) process.exit(2);
const identity = capture.value;
const claim = { ...identity, claimedAt: currentIso(), supervision: { supervisor: identity, child: identity } };
if (!claimRecord(record.id, claim)) process.exit(3);
const stateDir = await resolveStateDir();
const pr = String(record.pr);
const lock = { stateDir, name: prLockName(pr), what: "test driver cleanup" };
const ran = { code: 0, signal: null, pid: identity.pid };
const read = () => driverCleanupUncertain(record, ran);
const resetChild = (child) => {
  claim.supervision.child = child;
  stateDb().query("UPDATE launches SET claim = ? WHERE id = ?").run(JSON.stringify(claim), record.id);
};
const answers = {};
acquire(lock, pr);
answers.retainedLock = await read();
answers.retainedLockAfterCrash = await driverCleanupUncertain(record, { ...ran, code: DRIVE_EXIT.INDETERMINATE });
answers.retainedLockAfterDeadline = await driverCleanupUncertain(record, { ...ran, code: DRIVE_EXIT.PASS_DEADLINE });
resetChild({ ...identity, pid: identity.pid + 1000000 });
answers.unrelatedLock = await read();
resetChild(identity);
const drive = driveDb(stateDir);
drive.db.query("UPDATE locks SET start = '' WHERE clone = ? AND name = ?").run(drive.clone, lock.name);
answers.lockWithoutCreationTime = await read();
resetChild(null);
answers.rapidExitRetainedLock = await read();
resetChild(identity);
release(lock);
const witness = { worktree: process.cwd(), started: currentIso(), pid: identity.pid, host: identity.host };
writeDriverRecord(stateDir, pr, witness);
answers.unreleasedRecord = await read();
writeDriverRecord(stateDir, pr, { ...witness, released: true });
answers.releasedRecord = await read();
answers.releasedAfterCrash = await driverCleanupUncertain(record, { ...ran, code: DRIVE_EXIT.INDETERMINATE });
answers.releasedAfterDeadline = await driverCleanupUncertain(record, { ...ran, code: DRIVE_EXIT.PASS_DEADLINE });
writeDriverRecord(stateDir, pr, { ...witness, pid: identity.pid + 1000000 });
answers.unrelatedRecord = await read();
answers.neverAcquiredAfterCrash = await driverCleanupUncertain(record, { ...ran, code: DRIVE_EXIT.INDETERMINATE });
answers.neverAcquiredAfterDeadline = await driverCleanupUncertain(record, { ...ran, code: DRIVE_EXIT.PASS_DEADLINE });
process.chdir(${JSON.stringify(outside)});
answers.unreadableLookup = await read();
answers.crashBeforeAcquisition = await driverCleanupUncertain(record, { code: DRIVE_EXIT.INDETERMINATE, signal: null });
answers.deadlineWithoutWitness = await driverCleanupUncertain(record, { code: DRIVE_EXIT.PASS_DEADLINE, signal: null });
console.log(JSON.stringify(answers));
`,
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        script,
      ],
      {
        cwd: w.repo,
        env: w.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ exitCode, stdout, stderr }, 0);
    expect(JSON.parse(stdout)).toEqual({
      retainedLock: true,
      retainedLockAfterCrash: true,
      retainedLockAfterDeadline: true,
      unrelatedLock: false,
      lockWithoutCreationTime: true,
      rapidExitRetainedLock: true,
      unreleasedRecord: true,
      releasedRecord: false,
      releasedAfterCrash: false,
      releasedAfterDeadline: false,
      unrelatedRecord: false,
      neverAcquiredAfterCrash: false,
      neverAcquiredAfterDeadline: false,
      unreadableLookup: true,
      crashBeforeAcquisition: true,
      deadlineWithoutWitness: true,
    });
  } finally {
    w.close();
  }
}, 30000);
