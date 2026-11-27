/**
 * `jig send steward@owner/name start`: a request for one steward pass, kept
 * on the dispatcher host that owns the repository, refused with the rule
 * named while a steward pass holds the repository or the host's hourly
 * budget is spent, and refused on a host that does not run the repository's
 * steward. A steward address names its repository alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { waitFor } from "../../dispatch/__tests__/launch-fixtures.ts";
import { recordExit, writeRecord } from "../../dispatch/lib/launches.ts";
import { keepStewardRequest } from "../../dispatch/lib/steward-requests.ts";
import { stateDb } from "../../dispatch/lib/state.ts";
import { keepStewardRun } from "../../dispatch/lib/steward.ts";
import { tickWakeDir } from "../../dispatch/lib/wake-tick.ts";
import { REPO, type SendWorld, sendWorld } from "./send-fixtures.ts";

const ADDRESS = `steward@${REPO}`;

interface StewardWorld extends SendWorld {
  /** The arguments of each tick the stand-in for a woken tick ran. */
  ticks(): string[][];
  wake: string;
}

let current: StewardWorld | null = null;
afterEach(async () => {
  const w = current;
  current = null;
  if (w === null) return;
  await waitFor("the waiter to exit", () => waiterPid(w) === null);
  w.close();
});

function waiterPid(w: StewardWorld): number | null {
  const file = join(w.wake, "waiter");
  if (!existsSync(file)) return null;
  const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function world(owner = true): StewardWorld {
  const w = sendWorld();
  const log = join(w.root, "ticks.jsonl");
  const stub = join(w.root, "fake-tick.ts");
  writeFileSync(log, "");
  writeFileSync(
    stub,
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  w.env.JIG_WAKE_COMMAND = JSON.stringify([process.execPath, stub]);
  mkdirSync(join(w.home, ".jig"), { recursive: true });
  writeFileSync(
    join(w.home, ".jig", "dispatch.yaml"),
    `steward:\n  enabled: true\nrepositories:\n  - path: ${w.repo}\n    stages: [steward]\n    owner: ${owner}\n`,
  );
  current = {
    ...w,
    wake: tickWakeDir(w.repo, w.state),
    ticks: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
  };
  return current;
}

function requests(w: SendWorld) {
  if (!existsSync(join(w.state, "state.sqlite"))) return [];
  return stateDb(w.state)
    .query("SELECT repo, requested_by AS by FROM steward_requests")
    .all();
}

const DIGEST = {
  version: 1 as const,
  repo: REPO,
  drives: [],
  needs: [],
  queue: [],
  passes: [],
  failures: [],
  load: null,
};

describe("jig send steward@… start", () => {
  it("shows the request on a dry run, keeps it on a real send and wakes the tick, and a second send leaves the first standing", async () => {
    const w = world();
    const dry = await w.send([ADDRESS, "start", "--dry-run"]);
    expectSpawnExit(dry, 0);
    expect(dry.stdout).toContain(`jig send ${ADDRESS} start (dry run)`);
    expect(dry.stdout).toContain(
      "a request for one steward pass, whatever the judgment backlog holds",
    );
    expect(dry.stdout).toContain("the dispatcher's next tick");
    expect(requests(w)).toEqual([]);
    const sent = await w.send([ADDRESS, "start"]);
    expectSpawnExit(sent, 0);
    expect(requests(w)).toEqual([
      { repo: REPO.toLowerCase(), by: "maintainer" },
    ]);
    expect(sent.stdout).toContain(
      `next       the dispatcher's tick for ${REPO}, woken now`,
    );
    await waitFor("the woken tick", () => w.ticks().length === 1);
    expect(w.ticks()).toEqual([["dispatch", "--apply", "--repo", w.repo]]);
    await waitFor("the waiter to exit", () => waiterPid(w) === null);
    const again = await w.send([ADDRESS, "start", "--dry-run"]);
    expectSpawnExit(again, 0);
    expect(again.stdout).toContain("the request maintainer sent at");
    expect(again.stdout).toContain("which stands");
  });

  it("refuses while the host's hourly budget is spent, naming the budget, and keeps nothing", async () => {
    const w = world();
    const now = Date.now();
    for (const n of [1, 2, 3])
      keepStewardRun(
        `20261127T00000${n}Z-0000000${n}`,
        DIGEST,
        now - n * 60_000,
        w.state,
      );
    const r = await w.send([ADDRESS, "start"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "jig send: refused: the host's hourly steward budget is spent, so the dispatcher would refuse the pass",
    );
    expect(requests(w)).toEqual([]);
  });

  it("refuses while a steward pass holds the repository, naming the hold, and keeps nothing", async () => {
    const w = world();
    writeRecord(
      {
        version: 1,
        id: "20261127T100000Z-abcdef12",
        token: "token",
        action: "steward",
        repo: REPO,
        repoPath: w.repo,
        pr: null,
        item: null,
        account: "a",
        vendor: "claude",
        configDir: w.root,
        wallBackoffMs: 1,
        replaces: null,
        facts: "hash",
        createdAt: "2026-11-27T10:00:00Z",
        workspace: { id: "ws", path: w.tree },
        attempts: [],
        agentId: null,
        model: null,
        effort: null,
        released: false,
        command: null,
        marker: null,
      },
      w.state,
    );
    const r = await w.send([ADDRESS, "start"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "jig send: refused: a steward pass already holds this repository, so the dispatcher would refuse the pass",
    );
    expect(requests(w)).toEqual([]);
  });

  it("refuses on a host that does not own the repository", async () => {
    const w = world(false);
    const r = await w.send([ADDRESS, "start"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      `run this command on the dispatcher host that owns ${REPO}`,
    );
    expect(requests(w)).toEqual([]);
  });

  it("refuses a host whose dispatch file does not run the steward for the repository", async () => {
    const w = world();
    writeFileSync(
      join(w.home, ".jig", "dispatch.yaml"),
      `repositories:\n  - path: ${w.repo}\n    stages: [steward]\n`,
    );
    const r = await w.send([ADDRESS, "start"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      `this host does not run the steward for ${REPO}`,
    );
  });

  it("takes no key on a steward address, start on no other station, and no steward address in jig ask", async () => {
    const w = world();
    const keyed = await w.send([`${ADDRESS}#5`, "start"]);
    expectSpawnExit(keyed, 2);
    expect(keyed.stderr).toContain("names its repository and no key");
    const drive = await w.send([`drive@${REPO}#12`, "start"]);
    expectSpawnExit(drive, 2);
    expect(drive.stderr).toContain("a drive address does not take start");
    const verbs = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(verbs, 2);
    expect(verbs.stderr).toContain("steward takes start");
    const asked = await w.jig(["ask", ADDRESS]);
    expectSpawnExit(asked, 2);
    expect(asked.stderr).toContain(
      "a steward address takes jig send's start alone",
    );
    expect(requests(w)).toEqual([]);
  });

  it("settles an already-answered request whose pass ended before the next tick and queues a new request", async () => {
    const w = world();
    const kept = keepStewardRequest(REPO, "maintainer", w.state);
    expect(kept.ok).toBe(true);
    if (!kept.ok) throw new Error(kept.failure.reason);
    const launchId = "20261127T100000Z-abcdef34";
    writeRecord(
      {
        version: 1,
        id: launchId,
        token: "token",
        action: "steward",
        repo: REPO,
        repoPath: w.repo,
        pr: null,
        item: null,
        account: "a",
        vendor: "claude",
        configDir: w.root,
        wallBackoffMs: 1,
        replaces: null,
        facts: "hash",
        createdAt: "2026-11-27T10:00:00Z",
        workspace: { id: "ws", path: w.tree },
        attempts: [
          { at: "2026-11-27T10:00:01Z", outcome: "sent", detail: "started" },
        ],
        agentId: null,
        model: null,
        effort: null,
        released: false,
        command: null,
        marker: null,
        stewardRequest: kept.value.id,
      },
      w.state,
    );
    recordExit(
      launchId,
      { at: "2026-11-27T10:05:00Z", code: 0, signal: null },
      w.state,
    );
    const sent = await w.send([ADDRESS, "start"]);
    expectSpawnExit(sent, 0);
    await waitFor("the woken tick", () => w.ticks().length === 1);
    const standing = stateDb(w.state)
      .query("SELECT id, requested_by AS by FROM steward_requests")
      .all() as Array<{ id: string; by: string }>;
    expect(standing).toHaveLength(1);
    expect(standing[0]?.id).not.toBe(kept.value.id);
    const rows = stateDb(w.state)
      .query("SELECT row FROM log WHERE key = ?")
      .all(`steward-request ${REPO} ${kept.value.id}`) as Array<{
      row: string;
    }>;
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("expected steward-requested row");
    expect(JSON.parse(first.row)).toMatchObject({
      event: "steward-requested",
      reason: expect.stringContaining(`started steward pass ${launchId}`),
    });
  });
});
