/**
 * A stopped drive a launch still holds: `waitsOn` names the hold when nobody
 * can show the launch's process running, and stays `none` only while a
 * holder's process is alive. The hold comes from this machine's launch
 * record or from an open launch claim on the pull request. A drive the hold
 * does not keep from going on, a merged pull request's included, is named
 * the hold's once it has outlived its bound.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import {
  claimRecord,
  type LaunchRecord,
  writeRecord,
} from "../../dispatch/lib/launches.ts";
import {
  comment,
  ledgerOn,
  PARK_KEY,
  parkedLedger,
  pullRequest,
  REPO,
  type SendWorld,
  sendWorld,
} from "../../send/__tests__/send-fixtures.ts";
import type { ProcessIdentity } from "../../shared/liveness.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  launchClaim,
  LAUNCH_CLAIM,
} from "../../shared/records/launch-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { currentIso, currentMs, isoFromMs } from "../../shared/time.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { AskAnswer } from "../lib/answer.ts";
import { pullDoc } from "./ask-fixtures.ts";

const RECORD = "20261105T100000Z-abcdef12";
const LIVENESS = join(import.meta.dir, "../../shared/liveness.ts");
const HOUR_MS = 3_600_000;

let current: SendWorld | undefined;
const children: Array<{ kill(): void }> = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  current?.close();
  current = undefined;
});

function world(): SendWorld {
  current = sendWorld();
  return current;
}

/** A parked ledger whose driver stopped at `heartbeat`. */
function parkedAt(heartbeat: string): Ledger {
  const ledger = parkedLedger(12);
  ledger.driver.heartbeat = heartbeat;
  return ledger;
}

/** The pull request with `ledger`, every park of it answered, and `more` comments. */
function answeredPark(
  w: SendWorld,
  ledger: Ledger,
  more: unknown[] = [],
): void {
  pullRequest(
    w,
    12,
    [],
    [
      ledgerOn(701, ledger),
      comment(702, `answer ${PARK_KEY}: keep it`, "maintainer", "MEMBER"),
      ...more,
    ],
  );
}

/** A re-arm's launch record of the pull request, created at `createdAt`. */
function launch(w: SendWorld, createdAt: string): void {
  const r: LaunchRecord = {
    version: 1,
    id: RECORD,
    token: "token",
    action: "rearm",
    repo: REPO,
    repoPath: w.repo,
    pr: 12,
    item: null,
    account: "account-a",
    vendor: "claude",
    configDir: join(w.root, "config-a"),
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt,
    workspace: { id: "repo-1::ws", path: w.repo },
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    sessionId: "session-1",
  };
  writeRecord(r, w.state);
}

/** Claim the launch for a process on a host this machine cannot see, whose state reads unknown. */
function claimElsewhere(w: SendWorld, claimedAt: string): void {
  claimRecord(
    RECORD,
    {
      hostId: "another-host-id",
      host: "another-host",
      bootId: "another-boot",
      pid: 4242,
      start: "Mon Nov  2 10:00:00 2026",
      claimedAt,
    },
    w.state,
  );
}

/** Claim the launch on this host for a supervised stage whose wrapper, supervisor and child have all ended. */
function claimEndedHere(w: SendWorld, claimedAt: string): void {
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { captureIdentity } = await import(${JSON.stringify(LIVENESS)}); console.log(JSON.stringify(await captureIdentity()));`,
    ],
    { env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(probe, 0);
  const read = JSON.parse(probe.stdout.toString() || "{}") as {
    ok: boolean;
    value: ProcessIdentity;
  };
  expect(read.ok).toBe(true);
  const ended = { ...read.value, pid: 2147483647 };
  claimRecord(
    RECORD,
    {
      ...ended,
      claimedAt,
      supervision: { supervisor: ended, child: read.value },
    },
    w.state,
  );
}

/** A process that runs until the test ends, with its identity as the world's child reads it. */
function liveProcess(w: SendWorld): ProcessIdentity {
  const sleeper = Bun.spawn(
    [process.execPath, "-e", "setTimeout(() => {}, 120000)"],
    { env: w.env, stdout: "ignore", stderr: "ignore" },
  );
  children.push(sleeper);
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { captureIdentity } = await import(${JSON.stringify(LIVENESS)}); const deadline = Date.now() + 10000; let r; do { r = await captureIdentity(${sleeper.pid}); } while (!r.ok && Date.now() < deadline); console.log(JSON.stringify(r));`,
    ],
    { env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  const read = JSON.parse(probe.stdout.toString() || "{}") as {
    ok: boolean;
    value: ProcessIdentity;
  };
  expectSpawnExit(probe, 0);
  expect(read.ok).toBe(true);
  return read.value;
}

async function ask(w: SendWorld): Promise<AskAnswer> {
  const r = await w.ask([`drive@${REPO}#12`, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as AskAnswer;
}

describe("a stopped drive a launch of unknown process holds", () => {
  it("waits on this machine's launch record, naming it and why its process is unknown", async () => {
    const w = world();
    const now = currentIso();
    answeredPark(w, parkedAt(now));
    launch(w, now);
    claimElsewhere(w, now);

    const answer = await ask(w);
    expect(answer.holder).toMatchObject({
      stage: "rearm",
      host: "this machine",
      process: "unknown",
      since: now,
    });
    const { waiting } = answer.waitsOn as { waiting: string };
    expect(waiting).toContain("rearm launch on this machine");
    expect(waiting).toContain(RECORD);
    expect(waiting).toContain("is on another host");
    expect(waiting).toContain("has held the drive for");
  });

  it("waits on another host's open launch claim, naming the claim and its host", async () => {
    const w = world();
    const posted = launchClaim(
      {
        stage: "drive",
        pr: 12,
        run: "tick",
        action: "rearm",
        record: RECORD,
        host: "hostdigest01",
        owner: true,
        facts: "stopped 8",
        writer: localWriter("forge", "maintainer"),
      },
      1,
    );
    answeredPark(w, parkedAt(currentIso()), [
      comment(703, claimBody(LAUNCH_CLAIM, posted), "maintainer", "MEMBER"),
    ]);

    const answer = await ask(w);
    expect(answer.holder).toMatchObject({
      host: "hostdigest01",
      process: "unknown",
    });
    const { waiting } = answer.waitsOn as { waiting: string };
    expect(waiting).toContain("launch claim 703");
    expect(waiting).toContain("hostdigest01");
  });

  it("is a person's to settle once the hold has outlived its bound, with the command that clears the record", async () => {
    const w = world();
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    answeredPark(w, parkedAt(long));
    launch(w, long);
    claimElsewhere(w, long);

    const waits = (await ask(w)).waitsOn as { person: string; why: string };
    expect(waits.person).toBe("settle the launch that holds the drive");
    expect(waits.why).toContain(`jig dispatch clear ${RECORD}`);
  });

  it("counts the hold from the drive's stop, not from a launch that ran for hours before it", async () => {
    const w = world();
    answeredPark(w, parkedAt(currentIso()));
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    launch(w, long);
    claimElsewhere(w, long);

    expect((await ask(w)).waitsOn).toMatchObject({
      waiting: expect.stringContaining(RECORD),
    });
  });

  it("names the hold on a stale ledger too, where a re-drive is what it prevents", async () => {
    const w = world();
    const now = currentIso();
    const ledger = stoppedLedger(12, 21);
    ledger.driver.heartbeat = now;
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    launch(w, now);
    claimElsewhere(w, now);

    const { waiting } = (await ask(w)).waitsOn as { waiting: string };
    expect(waiting).toContain(RECORD);
    expect(waiting).not.toContain("re-drive on any account");
  });

  it("names the hold on a stop only a person settles, since no re-arm passes it", async () => {
    const w = world();
    const now = currentIso();
    const ledger = stoppedLedger(12, 2);
    ledger.driver.heartbeat = now;
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    launch(w, now);
    claimElsewhere(w, now);

    const { waiting } = (await ask(w)).waitsOn as { waiting: string };
    expect(waiting).toContain(RECORD);
  });

  it("leaves a pending launch to the dispatcher, however old", async () => {
    const w = world();
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    answeredPark(w, parkedAt(long));
    launch(w, long);

    const { waiting } = (await ask(w)).waitsOn as { waiting: string };
    expect(waiting).toContain("has not claimed the record yet");
    expect(waiting).not.toContain("jig dispatch clear");
  });

  it("names the hold on a pull request with no ledger yet", async () => {
    const w = world();
    const now = currentIso();
    pullRequest(w, 12, [], []);
    launch(w, now);
    claimElsewhere(w, now);

    const { waiting } = (await ask(w)).waitsOn as { waiting: string };
    expect(waiting).toContain(RECORD);
  });

  it("reads as driven while the holder's process is alive", async () => {
    const w = world();
    const now = currentIso();
    answeredPark(w, parkedAt(now));
    launch(w, now);
    claimRecord(RECORD, { ...liveProcess(w), claimedAt: now }, w.state);

    const answer = await ask(w);
    expect(answer.holder).toMatchObject({ process: "alive" });
    expect(answer.waitsOn).toBe("none");
  });
});

describe("a drive of any other class a launch of unknown process holds", () => {
  /** A converged ledger on pull request 12, merged at `mergedAt`. */
  function merged(w: SendWorld, mergedAt: string): void {
    const ledger = stoppedLedger(12, DRIVE_EXIT.CONVERGED);
    ledger.driver.heartbeat = mergedAt;
    w.api(
      `repos/${REPO}/pulls/12`,
      pullDoc(12, { state: "closed", merged: true, merged_at: mergedAt }),
    );
    w.api(`repos/${REPO}/issues/12/comments`, [ledgerOn(701, ledger)]);
  }

  it("is a person's to settle on a merged pull request once the hold has outlived its bound", async () => {
    const w = world();
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    merged(w, long);
    launch(w, long);
    claimEndedHere(w, long);

    const answer = await ask(w);
    expect(answer.holder).toMatchObject({ process: "unknown" });
    const waits = answer.waitsOn as { person: string; why: string };
    expect(waits.person).toBe("settle the launch that holds the drive");
    expect(waits.why).toContain(RECORD);
    expect(waits.why).toContain(`jig dispatch clear ${RECORD}`);
  });

  it("waits on nothing on a merged pull request inside the bound, counted from the merge", async () => {
    const w = world();
    merged(w, currentIso());
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    launch(w, long);
    claimEndedHere(w, long);

    expect((await ask(w)).waitsOn).toBe("none");
  });

  it("does not name the hold on a running ledger whose holder's processes cannot be judged, past the bound too", async () => {
    const w = world();
    const ledger = stoppedLedger(12, undefined, {
      driver: {
        actor: "wt-0123456789abcdef",
        clone: "clone-a",
        heartbeat: currentIso(),
        state: "running",
        started: currentIso(),
      },
    });
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    launch(w, long);
    claimElsewhere(w, long);

    const { waiting } = (await ask(w)).waitsOn as { waiting: string };
    expect(waiting).toContain("liveness and ownership are unknown");
  });

  it("names the hold on a merged pull request whose holder's processes cannot be judged", async () => {
    const w = world();
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    merged(w, long);
    launch(w, long);
    claimElsewhere(w, long);

    const waits = (await ask(w)).waitsOn as { person: string; why: string };
    expect(waits.person).toBe("settle the launch that holds the drive");
    expect(waits.why).toContain("is on another host");
  });

  it("is a person's to settle on a running ledger, counted from the launch", async () => {
    const w = world();
    const ledger = stoppedLedger(12, undefined, {
      driver: {
        actor: "wt-0123456789abcdef",
        clone: "clone-a",
        heartbeat: currentIso(),
        state: "running",
        started: currentIso(),
      },
    });
    pullRequest(w, 12, [], [ledgerOn(701, ledger)]);
    const long = isoFromMs(currentMs() - 10 * HOUR_MS);
    launch(w, long);
    claimEndedHere(w, long);

    const waits = (await ask(w)).waitsOn as { person: string; why: string };
    expect(waits.person).toBe("settle the launch that holds the drive");
    expect(waits.why).toContain(RECORD);
  });
});
