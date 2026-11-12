/**
 * `jig dispatch line --json`: the newest tick's line as the dashboard's
 * `GET /state` answers it, read without a lock and without creating the state
 * database. The command runs in a child whose home is a fresh directory, so
 * the state root it reads is the one the test wrote.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { baselineMigrations } from "../../shared/records/migrations.ts";
import { serveDashboard } from "../dashboard.ts";
import type { LineSnapshot, StateAnswer } from "../lib/dashboard-contract.ts";
import { hostTimeZone } from "../lib/host-time.ts";
import { writeLine } from "../lib/line-store.ts";
import {
  closeStateDb,
  MIGRATIONS,
  SCHEMA_VERSION,
  stateDb,
  statePath,
} from "../lib/state.ts";
import { lineMain } from "../line-command.ts";

const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

const LINE: LineSnapshot = {
  version: 1,
  runId: "2026-11-01T11-55-00-000Z-1-aaaaaaaa",
  startedAt: "2026-11-01T11:55:00.000Z",
  finishedAt: "2026-11-01T11:56:00.000Z",
  exitStatus: 0,
  apply: true,
  applyWithheld: null,
  intervalMs: 300_000,
  longestTickMs: 60_000,
  plugin: "1.2.3",
  timeZone: "Europe/Lisbon",
  accounts: [],
  lastAccount: null,
  sessions: [],
  needs: [],
  queue: [],
  repos: [],
};

const homes: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const home of homes.splice(0)) {
    closeStateDb(stateRootOf(home));
    rmSync(home, { recursive: true, force: true });
  }
});

/** The dispatcher's state directory under a home, as `stateRoot` names it. */
function stateRootOf(home: string): string {
  return join(home, ".local", "state", "jig", "dispatch");
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "jig-dispatch-line-"));
  homes.push(home);
  return home;
}

/** Create a version-one dispatcher database with matching migration history. */
function versionOneStateDb(root: string): void {
  mkdirSync(root, { recursive: true });
  const path = statePath(root);
  const db = new Database(path);
  try {
    const firstMigration = MIGRATIONS.at(0);
    expect(firstMigration).toBeDefined();
    db.run(firstMigration?.sql ?? "");
    db.run("PRAGMA user_version = 1");
    baselineMigrations(db, { path, migrations: MIGRATIONS }, 1);
  } finally {
    db.close();
  }
}

/** `jig dispatch line --json` in a child whose home is `home`. */
async function line(home: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      JIG,
      "dispatch",
      "line",
      "--json",
    ],
    {
      cwd: home,
      // The test's own zone, so the child's answer and the server's agree.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TZ: hostTimeZone(),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** `GET /state`'s status and body for the database under `root`, at `NOW`. */
async function servedState(root: string) {
  const dashboard = serveDashboard({
    listen: { host: "127.0.0.1", port: null },
    port: 0,
    root,
    token: "fixture-token",
    now: () => NOW,
  });
  stops.push(dashboard.stop);
  const url = new URL("/state", dashboard.url);
  url.searchParams.set("token", "fixture-token");
  const response = await fetch(url, {
    headers: { "accept-encoding": "identity" },
  });
  return { status: response.status, body: await response.text() };
}

describe("jig dispatch line --json", () => {
  it("prints what GET /state answers for the same stored line, byte for byte", async () => {
    const root = stateRootOf(freshHome());
    writeLine(LINE, '{"runId":"the receipt"}', root);
    const served = await servedState(root);
    expect(served.status).toBe(200);
    const printed: string[] = [];
    expect(
      lineMain({ root, nowMs: NOW, print: (text) => printed.push(text) }),
    ).toBe(0);
    expect(printed).toEqual([served.body]);
    const answer = JSON.parse(printed[0] ?? "") as {
      ok: true;
      value: StateAnswer;
    };
    expect(answer.ok).toBe(true);
    expect(answer.value.line).toEqual(LINE);
    expect(answer.value.timeZone).toBe("Europe/Lisbon");
    expect(answer.value.schema).toBe(SCHEMA_VERSION);
  });

  it("prints the stored line from the command line, with nothing on stderr", async () => {
    const home = freshHome();
    writeLine(LINE, '{"runId":"the receipt"}', stateRootOf(home));
    closeStateDb(stateRootOf(home));
    const run = await line(home);
    expectSpawnExit(run, 0);
    expect(run.stderr).toBe("");
    const answer = JSON.parse(run.stdout) as { ok: true; value: StateAnswer };
    expect(answer.value.line).toEqual(LINE);
  });

  it("answers with no line and exit 0 when there is no state database, and creates none", async () => {
    const home = freshHome();
    const run = await line(home);
    expectSpawnExit(run, 0);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    const answer = JSON.parse(run.stdout) as { ok: true; value: StateAnswer };
    expect(answer).toMatchObject({
      ok: true,
      value: { line: null, schema: SCHEMA_VERSION },
    });
    expect(existsSync(statePath(stateRootOf(home)))).toBe(false);
    expect(existsSync(stateRootOf(home))).toBe(false);
  });

  it("answers with no line and exit 0 when no tick has written one yet, as GET /state does", async () => {
    const home = freshHome();
    const root = stateRootOf(home);
    stateDb(root);
    closeStateDb(root);
    const run = await line(home);
    expectSpawnExit(run, 0);
    const answer = JSON.parse(run.stdout) as { ok: true; value: StateAnswer };
    expect(answer.value.line).toBeNull();
    const served = JSON.parse((await servedState(root)).body) as {
      ok: true;
      value: StateAnswer;
    };
    expect({ ...answer.value, now: "" }).toEqual({ ...served.value, now: "" });
  });

  it.each([
    ["a time zone that is not a string", { timeZone: 42 }],
    ["no start time", { startedAt: undefined }],
    ["a duration that is not a number", { recentTicksMs: ["oops"] }],
    ["a start time that is not a time", { startedAt: "not-a-date" }],
    ["a time zone that is not a zone", { timeZone: "not-a-zone" }],
    ["a negative interval", { intervalMs: -1 }],
    ["an interval past the last time Date holds", { intervalMs: 9e15 }],
  ])(
    "refuses a version-1 line with %s, as it does one that is not JSON",
    (_name, change) => {
      const root = stateRootOf(freshHome());
      writeLine(LINE, "{}", root);
      const bad = { ...LINE, ...change };
      stateDb(root)
        .query("UPDATE tick_line SET line = ? WHERE id = 1")
        .run(JSON.stringify(bad));
      closeStateDb(root);
      const errors: string[] = [];
      expect(
        lineMain({
          root,
          nowMs: NOW,
          print: () => undefined,
          printError: (text) => errors.push(text),
        }),
      ).toBe(1);
      expect(errors).toEqual([
        expect.stringMatching(/^jig dispatch line: line-unreadable: /),
      ]);
    },
  );

  const NEED = {
    cause: "park",
    repo: "r",
    target: "t",
    since: "2026-01-01T00:00:00.000Z",
    reason: "x",
    decisions: [],
    workspaces: [],
  };
  const DECISION = {
    key: "k",
    kind: "thread",
    lines: ["## Question"],
    question: null,
    recommendation: null,
    decisionClass: null,
  };
  const SESSION = {
    record: "r",
    account: "a",
    repo: "r",
    target: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    samples: [],
  };

  it.each([
    ["a numeric workspace", { needs: [{ ...NEED, workspace: 42 }] }],
    [
      "an array stage question",
      { needs: [{ ...NEED, question: ["first", "second"] }] },
    ],
    ["a numeric stage question", { needs: [{ ...NEED, question: 3 }] }],
    ["a null decision", { needs: [{ ...NEED, decisions: [null] }] }],
    [
      "a decision line that is not text",
      {
        needs: [
          {
            ...NEED,
            decisions: [{ ...DECISION, lines: [{ toString: null }] }],
          },
        ],
      },
    ],
    [
      "a decision whose question is not text",
      {
        needs: [
          {
            ...NEED,
            decisions: [{ ...DECISION, question: { text: "Choose" } }],
          },
        ],
      },
    ],
    [
      "a decision whose recommendation is not text",
      {
        needs: [{ ...NEED, decisions: [{ ...DECISION, recommendation: 3 }] }],
      },
    ],
    [
      "a decision whose class is not text",
      {
        needs: [{ ...NEED, decisions: [{ ...DECISION, decisionClass: [] }] }],
      },
    ],
    ["a null thread sample", { sessions: [{ ...SESSION, samples: [null] }] }],
  ])("refuses a line with %s", (_name, change) => {
    const root = stateRootOf(freshHome());
    writeLine(LINE, "{}", root);
    stateDb(root)
      .query("UPDATE tick_line SET line = ? WHERE id = 1")
      .run(JSON.stringify({ ...LINE, ...change }));
    closeStateDb(root);
    const errors: string[] = [];
    expect(
      lineMain({
        root,
        nowMs: NOW,
        print: () => undefined,
        printError: (text) => errors.push(text),
      }),
    ).toBe(1);
    expect(errors).toEqual([
      expect.stringMatching(/^jig dispatch line: line-unreadable: /),
    ]);
  });

  it.each([undefined, null, "/srv/work/pr-7"])(
    "reads an additive version-1 workspace field (%s)",
    (workspace) => {
      const root = stateRootOf(freshHome());
      writeLine(LINE, "{}", root);
      stateDb(root)
        .query("UPDATE tick_line SET line = ? WHERE id = 1")
        .run(JSON.stringify({ ...LINE, needs: [{ ...NEED, workspace }] }));
      closeStateDb(root);
      expect(lineMain({ root, nowMs: NOW, print: () => undefined })).toBe(0);
    },
  );

  it("reads a database at an older schema without migrating it", () => {
    const root = stateRootOf(freshHome());
    versionOneStateDb(root);
    const before = readFileSync(statePath(root));
    const printed: string[] = [];
    expect(
      lineMain({ root, nowMs: NOW, print: (text) => printed.push(text) }),
    ).toBe(0);
    expect(printed).toHaveLength(1);
    expect(readFileSync(statePath(root)).equals(before)).toBe(true);
  });

  it("exits 1 with one line on stderr and nothing on stdout when the line does not read", async () => {
    const home = freshHome();
    const root = stateRootOf(home);
    writeLine(LINE, '{"runId":"the receipt"}', root);
    stateDb(root).run("UPDATE tick_line SET line = 'not json' WHERE id = 1");
    closeStateDb(root);
    const run = await line(home);
    expectSpawnExit(run, 1);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("jig dispatch line: line-unreadable: ");
    // The dashboard refuses the same line.
    const served = await servedState(root);
    expect(served.status).toBe(503);
    expect(JSON.parse(served.body)).toMatchObject({
      ok: false,
      failure: { code: "line-unreadable" },
    });
  });
});

it("refuses malformed Ready cards from stored JSON", async () => {
  const home = freshHome();
  const root = stateRootOf(home);
  const card = {
    repo: "example-org/repo",
    pr: 7,
    url: "",
    title: "change",
    head: "a".repeat(40),
    place: "ready",
    lane: "merge-now",
    says: "ready",
    act: "merge",
    waitingFor: null,
    command: null,
    withheld: null,
    requested: [],
    failing: [],
    failingOmitted: 0,
    conditions: [],
    unblocks: [],
    since: "2026-11-09T10:00:00Z",
  };
  for (const invalid of [
    { lane: "typo" },
    { act: "execute" },
    { conditions: [null] },
    { requested: [null] },
    { failing: [1] },
    { unblocks: ["7"] },
    { title: undefined },
    { waitingFor: undefined },
    { withheld: undefined },
    { since: undefined },
  ]) {
    writeLine(LINE, "{}", root);
    stateDb(root)
      .query("UPDATE tick_line SET line = ? WHERE id = 1")
      .run(JSON.stringify({ ...LINE, ready: [{ ...card, ...invalid }] }));
    const r = await line(home);
    expectSpawnExit(r, 1);
  }
});
