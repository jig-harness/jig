/**
 * `jig ask` through the `jig` command, against a fake forge and the
 * dispatcher's records written into the child's own home: the drive of a
 * pull request this machine dispatched names its launch, account and state;
 * on a machine with no dispatcher state the same address answers from the
 * forge and says the launch records were not read; an address nobody holds
 * answers with its last outcome; a malformed address or an unknown station is
 * a usage error naming the stations; `--json` prints the same answer as one
 * object; and nothing is written to the forge.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  claimRecord,
  type LaunchRecord,
  recordExit,
  writeRecord,
} from "../../dispatch/lib/launches.ts";
import { writeRow } from "../../dispatch/lib/log.ts";
import type { ProcessIdentity } from "../../shared/liveness.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  endedClaim,
  launchClaim,
  LAUNCH_CLAIM,
} from "../../shared/records/launch-claims.ts";
import type { LaunchDraft } from "../../shared/records/shared.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import {
  type AskWorld,
  askWorld,
  comment,
  pullDoc,
  REPO,
} from "./ask-fixtures.ts";

const LIVENESS = resolve(import.meta.dir, "../../shared/liveness.ts");

let current: AskWorld | null = null;
const children: Array<{ kill(): void }> = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  current?.close();
  current = null;
});

function world(): AskWorld {
  current = askWorld();
  current.api("user", { login: "drive-bot" });
  return current;
}

const RECORD = "20261105T100000Z-abcdef12";

/** A launch record for pull request `pr`, as a tick writes it. */
function record(
  w: AskWorld,
  pr: number,
  extra: Partial<LaunchRecord> = {},
): LaunchRecord {
  const r: LaunchRecord = {
    version: 1,
    id: RECORD,
    token: "token",
    action: "rearm",
    repo: REPO,
    repoPath: w.repo,
    pr,
    item: null,
    account: "account-a",
    vendor: "claude",
    configDir: join(w.root, "config-a"),
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt: "2026-11-05T10:00:00.000Z",
    workspace: { id: "repo-1::ws", path: w.repo },
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    sessionId: "session-1",
    ...extra,
  };
  writeRecord(r, w.state);
  return r;
}

/** A process that runs until the test ends, with its identity as a child of the world's home reads it. */
async function liveProcess(w: AskWorld) {
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
  const read = JSON.parse(probe.stdout.toString()) as {
    ok: boolean;
    value: ProcessIdentity;
  };
  expect(read.ok).toBe(true);
  return read.value;
}

const running = (pr: number) =>
  stoppedLedger(pr, undefined, {
    driver: {
      actor: "wt-0123456789abcdef",
      clone: "clone-a",
      heartbeat: new Date().toISOString(),
      state: "running",
    },
  });

function draft(pr: number): LaunchDraft {
  return {
    stage: "drive",
    pr,
    run: "tick",
    action: "rearm",
    record: RECORD,
    host: "hostdigest01",
    owner: true,
    facts: "stopped 16",
    writer: localWriter("forge", "drive-bot"),
  };
}

async function askJson(w: AskWorld, args: string[], cwd?: string) {
  const r = await w.ask([...args, "--json"], cwd);
  return { r, answer: JSON.parse(r.stdout) as AskAnswer };
}

describe("jig ask", () => {
  it("names the launch, account and state of a drive this machine dispatched", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(running(7))),
    ]);
    record(w, 7);
    const identity = await liveProcess(w);
    claimRecord(
      RECORD,
      { ...identity, claimedAt: "2026-11-05T10:00:01.000Z" },
      w.state,
    );

    const r = await w.ask([`drive@${REPO}#7`]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(`drive@${REPO}#7`);
    expect(r.stdout).toContain("rearm, on this machine");
    expect(r.stdout).toContain("process alive");
    expect(r.stdout).toContain("account account-a");
    expect(r.stdout).toContain("state    running");

    const { answer } = await askJson(w, [`drive@${REPO}#7`]);
    expect(answer.holder).toMatchObject({
      stage: "rearm",
      host: "this machine",
      process: "alive",
      local: { account: "account-a", session: "session-1", record: RECORD },
    });
    expect(answer.waitsOn).toBe("none");
    expect(answer.sources.records).toContainEqual({
      record: "dispatch-launch",
      read: true,
      local: true,
    });
  });

  it("reads a stop on a conflict this machine already re-drove for the same change as a person's to settle", async () => {
    const w = world();
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    w.api(
      `repos/${REPO}/pulls/7`,
      pullDoc(7, { mergeable: false, base: { ref: "main" } }),
    );
    w.api(`repos/${REPO}/git/ref/heads/main`, { object: { sha: base } });
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(stoppedLedger(7, 9))),
    ]);
    const open = await askJson(w, [`drive@${REPO}#7`]);
    expect(JSON.stringify(open.answer.waitsOn)).not.toContain(
      "already re-drove",
    );
    record(w, 7, {
      redrive: {
        cause: "stopped on a conflict with its base, and still conflicting",
        change: `head ${head}, base ${base}`,
        conflictStop: true,
      },
    });
    recordExit(
      RECORD,
      { at: "2026-11-05T10:05:00.000Z", code: 9, signal: null },
      w.state,
    );
    const { answer } = await askJson(w, [`drive@${REPO}#7`]);
    expect(answer.waitsOn).toMatchObject({
      person: "re-arm",
      why: expect.stringContaining("already re-drove it"),
    });
  });

  it("reads a stop on a conflict another host already re-drove and ended as a person's to settle", async () => {
    const w = world();
    const writer = localWriter("forge", "drive-bot");
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const posted = launchClaim(
      {
        ...draft(7),
        change: `head ${head}, base ${base}`,
        conflictStop: true,
      },
      1,
    );
    const ended = endedClaim(
      "drive",
      {
        key: posted.key,
        generation: 1,
        at: "2026-11-05T10:00:00.000Z",
        writer,
        payload: posted.payload,
        legacy: false,
      },
      7,
      {
        state: "ended",
        at: "2026-11-05T10:05:00.000Z",
        exit: 9,
        outcome: null,
      },
      writer,
    );
    w.api(
      `repos/${REPO}/pulls/7`,
      pullDoc(7, { mergeable: false, base: { ref: "main" } }),
    );
    w.api(`repos/${REPO}/git/ref/heads/main`, { object: { sha: base } });
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(stoppedLedger(7, 9))),
      comment(702, claimBody(LAUNCH_CLAIM, ended)),
    ]);

    const { answer } = await askJson(w, [`drive@${REPO}#7`], w.away);
    expect(answer.waitsOn).toMatchObject({
      person: "re-arm",
      why: expect.stringContaining("already re-drove it"),
    });
  });

  it("answers from the forge on a machine with no dispatcher, and says the launch records were not read", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(running(7))),
      comment(
        702,
        claimBody(LAUNCH_CLAIM, launchClaim(draft(7), 1)),
        "drive-bot",
        "NONE",
      ),
    ]);

    const { r, answer } = await askJson(w, [`drive@${REPO}#7`], w.away);
    expectSpawnExit(r, 0);
    expect(answer.state).toBe("running");
    expect(answer.holder).toMatchObject({
      stage: "rearm",
      host: "hostdigest01",
      process: "unknown",
    });
    const launches = answer.sources.records.find(
      (s) => s.record === "dispatch-launch",
    );
    expect(launches?.read).toBe(false);
    expect(launches?.detail).toContain("no dispatcher state");
    expect(answer.sources.forgeCalls).toBe(3);
    expect(answer.sources.trackerCalls).toBe(0);
    // Every forge call is a read.
    for (const call of w.calls()) expect(call).toMatch(/^api -i /);
  });

  it("answers an address nobody holds with its last outcome", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/9`, pullDoc(9));
    w.api(`repos/${REPO}/issues/9/comments`, [
      comment(
        901,
        ledgerBody(stoppedLedger(9, 0, { verifiedSha: "a".repeat(40) })),
      ),
    ]);
    writeRow(
      {
        kind: "ended",
        key: "ended 20261104T100000Z-11111111",
        at: "2026-11-04T11:00:00.000Z",
        repo: REPO,
        stage: "rearm",
        target: "PR #9",
        record: "20261104T100000Z-11111111",
        account: "account-a",
        model: null,
        durationMs: 3_600_000,
        rounds: 2,
        class: "converged",
        reason: "exit 0 (converged)",
      },
      w.state,
    );

    const { r, answer } = await askJson(w, [`drive@${REPO}#9`]);
    expectSpawnExit(r, 0);
    expect(answer.holder).toBe("none");
    expect(answer.state).toBe("CONVERGED");
    expect(answer.last).toEqual({
      class: "converged",
      at: "2026-11-04T11:00:00.000Z",
      reason: "exit 0 (converged)",
      from: "outcome log",
    });
    expect(answer.waitsOn).toMatchObject({ person: "merge" });
  });

  it("answers from a launch claim's end where no outcome log holds the launch", async () => {
    const w = world();
    const writer = localWriter("forge", "drive-bot");
    const posted = launchClaim(draft(9), 1);
    const ended = endedClaim(
      "drive",
      {
        key: posted.key,
        generation: 1,
        at: "2026-11-04T10:00:00.000Z",
        writer,
        payload: posted.payload,
        legacy: false,
      },
      9,
      {
        state: "ended",
        at: "2026-11-04T11:00:00.000Z",
        exit: 16,
        outcome: null,
      },
      writer,
    );
    w.api(`repos/${REPO}/pulls/9`, pullDoc(9));
    w.api(`repos/${REPO}/issues/9/comments`, [
      comment(901, ledgerBody(stoppedLedger(9, 16))),
      comment(902, claimBody(LAUNCH_CLAIM, ended)),
    ]);

    const { r, answer } = await askJson(w, [`drive@${REPO}#9`], w.away);
    expectSpawnExit(r, 0);
    expect(answer.holder).toBe("none");
    expect(answer.state).toBe("QUOTA_PARKED");
    expect(answer.last).toMatchObject({
      class: "quota wall",
      at: "2026-11-04T11:00:00.000Z",
      from: "launch claim",
    });
    // A dispatching host's claim is on the pull request, so the wall settles by itself.
    expect(answer.waitsOn).toHaveProperty("waiting");
  });

  it("exits 1 when the key names no pull request", async () => {
    const w = world();
    const r = await w.ask([`drive@${REPO}#404`]);
    expectSpawnExit(r, 1);
    expect(r.stdout).toContain("no such pull request");
  });

  it("refuses a malformed address or an unknown station with a usage error listing the stations", async () => {
    const w = world();
    for (const args of [
      ["review@example-org/example-repo#7"],
      ["drive@example-org/example-repo#seven"],
      ["@example-org/example-repo#7"],
      ["drive@example-org/example-repo#7", "8"],
    ]) {
      const r = await w.ask(args);
      expectSpawnExit(r, 2);
      if (args[0]?.startsWith("review") || args[0]?.startsWith("@"))
        expect(r.stderr).toContain("pickup, drive, followup");
    }
    expect(w.calls()).toEqual([]);
  });

  it("takes the key as a second argument and the repository from the checkout", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, []);
    const { r, answer } = await askJson(w, ["drive", "7"]);
    expectSpawnExit(r, 0);
    expect(answer.address).toBe(`drive@${REPO}#7`);
    expect(answer.state).toBe("not driven");
    const outside = await w.ask(["drive", "7"], w.away);
    expectSpawnExit(outside, 2);
    expect(outside.stderr).toContain("names no repository");
  });

  it("prints the same answer as one JSON object", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(stoppedLedger(7, 18))),
    ]);
    const text = await w.ask([`drive@${REPO}#7`]);
    const { r, answer } = await askJson(w, [`drive@${REPO}#7`]);
    expectSpawnExit(r, 0);
    expect(answer.v).toBe(1);
    expect(Object.keys(answer)).toEqual(
      expect.arrayContaining(["holder", "state", "waitsOn", "last", "sources"]),
    );
    expect(answer.state).toBe("MAILBOX_STOPPED");
    expect(answer.waitsOn).toMatchObject({ person: "re-arm" });
    expect(text.stdout).toContain(`state    ${answer.state}`);
    expect(text.stdout).toContain("person: re-arm");
  });

  it("distinguishes an explicit operator stop from an accident and an exhausted recovery budget", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    const ledger = stoppedLedger(7, undefined);
    ledger.driver.personStop = {
      at: new Date().toISOString(),
      reason: "maintenance",
    };
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(ledger)),
    ]);
    const explicit = await askJson(w, [`drive@${REPO}#7`]);
    expect(explicit.answer.state).toBe("stopped by a person");
    expect(explicit.answer.waitsOn).toMatchObject({
      person: "re-arm",
      why: expect.stringContaining("maintenance"),
    });
    ledger.driver.state = "running";
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(ledger)),
    ]);
    const pending = await askJson(w, [`drive@${REPO}#7`]);
    expect(pending.answer.state).toBe("running");
    expect(JSON.stringify(pending.answer)).toContain(
      "stop requested by a person",
    );
    ledger.driver.state = "stopped";
    delete ledger.driver.personStop;
    ledger.driver.recoveryVersion = 1;
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(ledger)),
    ]);
    const accident = await askJson(w, [`drive@${REPO}#7`]);
    expect(accident.answer.state).toBe("stopped with no recorded cause");
    expect(accident.answer.waitsOn).toMatchObject({
      why: expect.stringContaining("re-arming"),
    });
    for (let i = 0; i < 3; i++) {
      const id = `20261106T120000Z-abcdef0${i}`;
      record(w, 7, {
        id,
        facts: "no-cause: earlier run",
        createdAt: new Date(Date.now() - 1000).toISOString(),
      });
      recordExit(
        id,
        { at: new Date().toISOString(), code: 0, signal: null },
        w.state,
      );
    }
    const exhausted = await askJson(w, [`drive@${REPO}#7`]);
    expect(exhausted.answer.waitsOn).toMatchObject({
      person: "re-arm",
      why: expect.stringContaining("repeated no-cause stops"),
    });
    const damaged = launchClaim(draft(7), 1);
    damaged.payload.facts = 42;
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(ledger)),
      comment(702, claimBody(LAUNCH_CLAIM, damaged)),
    ]);
    const unread = await askJson(w, [`drive@${REPO}#7`]);
    expect(unread.answer.waitsOn).toMatchObject({
      waiting: expect.stringContaining("does not read"),
    });
  });

  it("reports a forge read that fails as a source not read, never a throw", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    const { r, answer } = await askJson(w, [`drive@${REPO}#7`]);
    expectSpawnExit(r, 0);
    expect(answer.sources.records).toContainEqual(
      expect.objectContaining({ record: "drive-ledger", read: false }),
    );
  });
});
