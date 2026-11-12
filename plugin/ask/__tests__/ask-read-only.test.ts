/**
 * `jig ask` reads the machine's databases and never writes them: the
 * dispatcher's state database and the drive's own are opened read-only, so
 * a command anyone can run at any moment never chooses when the owner's
 * database migrates. Against a database an older schema holds, `ask` reads
 * what that schema allows, or names the source as not read, and the file
 * stays byte for byte as it was.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  claimRecord,
  type LaunchRecord,
  writeRecord,
} from "../../dispatch/lib/launches.ts";
import { writeRow } from "../../dispatch/lib/log.ts";
import {
  closeStateDb,
  SCHEMA_VERSION,
  statePath,
} from "../../dispatch/lib/state.ts";
import { closeDatabase } from "../../shared/records/db.ts";
import {
  DRIVE_DB_VERSION,
  dbPathFor,
} from "../../skills/drive-pr/scripts/lib/state/db.ts";
import { scopedStateDir } from "../../skills/drive-pr/__tests__/scoped-state-dir.ts";
import { putLock } from "../../skills/drive-pr/__tests__/state-rows.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import { launchesWhere } from "../lib/local.ts";
import {
  type AskWorld,
  askWorld,
  comment,
  pullDoc,
  REPO,
} from "./ask-fixtures.ts";

let current: AskWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function world(): AskWorld {
  current = askWorld();
  current.api("user", { login: "drive-bot" });
  return current;
}

const RECORD = "20261104T100000Z-11111111";

/** The dispatcher's records for pull request 9: a launch record and the row of its end. */
function seed(w: AskWorld): void {
  const launch: LaunchRecord = {
    version: 1,
    id: RECORD,
    token: "token",
    action: "rearm",
    repo: REPO,
    repoPath: w.repo,
    pr: 9,
    item: null,
    account: "account-a",
    vendor: "claude",
    configDir: join(w.root, "config-a"),
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt: "2026-11-04T10:00:00.000Z",
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
  writeRecord(launch, w.state);
  claimRecord(
    RECORD,
    {
      hostId: "h",
      host: "h",
      bootId: "b",
      pid: 999_999_999,
      start: "s",
      claimedAt: "2026-11-04T10:00:01.000Z",
    },
    w.state,
  );
  writeRow(
    {
      kind: "ended",
      key: `ended ${RECORD}`,
      at: "2026-11-04T11:00:00.000Z",
      repo: REPO,
      stage: "rearm",
      target: "PR #9",
      record: RECORD,
      account: "account-a",
      model: null,
      durationMs: 3_600_000,
      rounds: 2,
      class: "converged",
      reason: "exit 0 (converged)",
    },
    w.state,
  );
  closeStateDb(w.state);
}

/** Edit a database file the way an older plugin left it. */
function edit(path: string, ...sql: string[]): void {
  const raw = new Database(path);
  for (const s of sql) raw.run(s);
  raw.close();
}

/** Remove every dispatch schema addition after version 8 and its recorded migration evidence. */
const BEFORE_TARGET = [
  "DROP INDEX log_target",
  "ALTER TABLE log DROP COLUMN target",
  "ALTER TABLE notices DROP COLUMN sent_at",
  "DROP TABLE followup_releases",
  "ALTER TABLE notices_content DROP COLUMN pending",
  "DROP TABLE reflection_findings",
  "DROP TABLE merge_reads",
  "ALTER TABLE launches DROP COLUMN result_next",
  "ALTER TABLE followup_outcomes DROP COLUMN asked",
  "DROP TABLE load_samples",
  "DROP TABLE failures",
  "DROP TABLE pickup_reads",
  "DROP TABLE steward_records",
  "DROP TABLE steward_runs",
  "ALTER TABLE launches DROP COLUMN refusal",
  "ALTER TABLE launches DROP COLUMN result_until",
  "PRAGMA user_version = 8",
  "UPDATE db_meta SET version = 8",
  "DELETE FROM db_migrations WHERE version > 8",
];

function userVersion(path: string): number {
  const raw = new Database(path, { readonly: true });
  const v = (raw.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  raw.close();
  return v;
}

async function askNine(w: AskWorld) {
  w.api(`repos/${REPO}/pulls/9`, pullDoc(9));
  w.api(`repos/${REPO}/issues/9/comments`, [
    comment(
      901,
      ledgerBody(stoppedLedger(9, 0, { verifiedSha: "a".repeat(40) })),
    ),
  ]);
  const r = await w.ask([`drive@${REPO}#9`, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as AskAnswer;
}

describe("jig ask against the dispatcher's database", () => {
  it("leaves a current database byte for byte as it was, and answers", async () => {
    const w = world();
    seed(w);
    const file = statePath(w.state);
    const before = readFileSync(file);

    const answer = await askNine(w);
    expect(answer.last).toMatchObject({
      class: "converged",
      from: "outcome log",
    });
    expect(answer.sources.records).toContainEqual({
      record: "dispatch-launch",
      read: true,
      local: true,
    });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("names the outcome log as not read on a database one schema behind, without migrating it", async () => {
    const w = world();
    seed(w);
    const file = statePath(w.state);
    // The schema before the log's `target` column: no index finds its rows, and a scan could neither finish nor be complete.
    edit(file, ...BEFORE_TARGET);
    const before = readFileSync(file);

    const answer = await askNine(w);
    expect(answer.last).toBeNull();
    expect(answer.sources.records).toContainEqual(
      expect.objectContaining({
        record: "dispatch-outcome",
        read: false,
        local: true,
        detail: expect.stringContaining("no target column"),
      }),
    );
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(userVersion(file)).toBe(8);
  });

  it("names a source its schema cannot answer as not read, saying the owner's next run brings it forward", async () => {
    const w = world();
    seed(w);
    const file = statePath(w.state);
    edit(file, ...BEFORE_TARGET, "DROP TABLE log");
    const before = readFileSync(file);

    const answer = await askNine(w);
    const outcome = answer.sources.records.find(
      (s) => s.record === "dispatch-outcome",
    );
    expect(outcome?.read).toBe(false);
    expect(outcome?.detail).toContain(
      "schema version 8; its next run brings it forward",
    );
    expect(answer.last).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("reads launch records from a pre-pickup-claims schema without migrating it", async () => {
    const w = world();
    seed(w);
    const file = statePath(w.state);
    edit(
      file,
      "DROP TABLE pickup_claims",
      `DELETE FROM db_migrations WHERE version = ${SCHEMA_VERSION}`,
      `PRAGMA user_version = ${SCHEMA_VERSION - 1}`,
    );
    const before = readFileSync(file);

    const answer = await askNine(w);
    const launches = await launchesWhere(w.state, () => true);
    expect(launches.ok && launches.value.records).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({ id: RECORD }),
      }),
    );
    expect(answer.sources.records).toContainEqual({
      record: "dispatch-launch",
      read: true,
      local: true,
    });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(userVersion(file)).toBe(SCHEMA_VERSION - 1);
  });
});

describe("jig ask against the drive's database", () => {
  it("lists a drive of a database one schema behind as not read, and writes nothing to it", async () => {
    const w = world();
    const stateDir = scopedStateDir(join(w.root, "drive-state"), w.repo);
    w.env.DRIVE_PR_STATE_DIR = stateDir;
    putLock(stateDir, "pr-drive-9", { label: "drive.ts" });
    const file = dbPathFor(stateDir);
    closeDatabase(file);
    edit(
      file,
      "DROP TABLE cancelled_ci",
      `PRAGMA user_version = ${DRIVE_DB_VERSION - 1}`,
      `UPDATE db_meta SET version = ${DRIVE_DB_VERSION - 1}`,
      `DELETE FROM db_migrations WHERE version > ${DRIVE_DB_VERSION - 1}`,
    );
    const before = readFileSync(file);

    const answer = await askNine(w);
    const lock = answer.sources.records.find((s) => s.record === "drive-lock");
    expect(lock?.read).toBe(false);
    expect(lock?.detail).toContain("a driver's next run brings it forward");
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
