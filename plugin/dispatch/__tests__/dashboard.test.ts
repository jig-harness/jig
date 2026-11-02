/**
 * `jig dispatch dashboard` over a fixture outcome log: filtered to
 * yesterday it shows yesterday's rows only, with each class counted; the
 * server refuses a request without its token, and writes nothing; open
 * while a tick writes, it answers every refresh at once and shows the new
 * rows once they are written.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { dashboardData, serveDashboard } from "../dashboard.ts";
import { writeRow, type LogRow } from "../lib/log.ts";
import { waitFor } from "./launch-fixtures.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const YESTERDAY = {
  from: "2026-10-31T00:00:00.000Z",
  to: "2026-10-31T23:59:59.999Z",
};

function ended(
  at: string,
  record: string,
  cls: LogRow["class"],
  repo = "example-org/web",
): LogRow {
  return {
    kind: "ended",
    key: `ended ${record}`,
    at,
    repo,
    stage: "rearm",
    target: "PR #7",
    record,
    account: "a",
    model: null,
    durationMs: 60_000,
    rounds: 1,
    class: cls ?? "unknown",
    reason: `exit for ${record}`,
  };
}

/** Rows on three days, and one month back, in a fresh state directory. */
function fixtureLog(): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-log-"));
  for (const row of [
    ended("2026-09-30T23:00:00.000Z", "r-sep", "converged"),
    ended("2026-10-30T22:00:00.000Z", "r-before", "converged"),
    ended("2026-10-31T08:00:00.000Z", "r-y1", "quota wall"),
    ended("2026-10-31T21:30:00.000Z", "r-y2", "converged", "example-org/api"),
    {
      kind: "event",
      key: "event drift r-y3",
      at: "2026-10-31T23:59:00.000Z",
      repo: "example-org/web",
      stage: "pickup",
      target: "#12",
      event: "drifting",
      account: "a",
      class: null,
      reason: "drifting: opened no pull request",
    } satisfies LogRow,
    ended("2026-11-01T01:00:00.000Z", "r-today", "died"),
  ])
    writeRow(row, root);
  return root;
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

/**
 * A tick's write, in a process of its own: it writes a row in a transaction
 * that holds the database's strongest write lock for `holdMs`, marking
 * `started` once the row is written and the lock held.
 */
const WRITER = (holdMs: number) => `
import { insertRow } from ${JSON.stringify(resolve(import.meta.dir, "../lib/log.ts"))};
import { stateDb } from ${JSON.stringify(resolve(import.meta.dir, "../lib/state.ts"))};
const [root, started] = process.argv.slice(2);
const db = stateDb(root);
db.transaction(() => {
  insertRow(db, JSON.parse(process.env.ROW));
  require("node:fs").writeFileSync(started, "");
  Bun.sleepSync(${holdMs});
}).exclusive();
`;

describe("jig dispatch dashboard", () => {
  it("reports the total and no truncation while the rows fit under the cap", () => {
    const root = fixtureLog();
    const data = dashboardData(new URLSearchParams(YESTERDAY), NOW, root) as {
      rows: LogRow[];
      total: number;
      truncated: boolean;
    };
    expect(data.total).toBe(3);
    expect(data.truncated).toBe(false);
  });

  it("shows only yesterday's rows when filtered to yesterday, with each class counted", () => {
    const root = fixtureLog();
    const data = dashboardData(new URLSearchParams(YESTERDAY), NOW, root) as {
      rows: LogRow[];
      counts: Record<string, number>;
    };
    expect(data.rows.map((r) => r.key)).toEqual([
      "event drift r-y3",
      "ended r-y2",
      "ended r-y1",
    ]);
    expect(data.counts).toEqual({
      "event: drifting": 1,
      converged: 1,
      "quota wall": 1,
    });
    const web = dashboardData(
      new URLSearchParams({
        ...YESTERDAY,
        repo: "example-org/web",
        class: "quota wall",
      }),
      NOW,
      root,
    ) as { rows: LogRow[] };
    expect(web.rows.map((r) => r.key)).toEqual(["ended r-y1"]);
  });

  it("serves the filtered rows to a request carrying its token, refuses one without, and writes nothing", async () => {
    const root = fixtureLog();
    const before = readdirSync(root).sort();
    const served = serveDashboard({
      listen: { host: "127.0.0.1", port: null },
      port: 0,
      root,
      token: "fixture-token",
    });
    stop = served.stop;
    const base = new URL(served.url);
    expect(base.searchParams.get("token")).toBe("fixture-token");

    const rows = new URL("/rows", base);
    for (const [k, v] of Object.entries({
      ...YESTERDAY,
      token: "fixture-token",
    }))
      rows.searchParams.set(k, v);
    const answer = await fetch(rows);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { rows: LogRow[] };
    expect(body.rows.map((r) => r.at.slice(0, 10))).toEqual([
      "2026-10-31",
      "2026-10-31",
      "2026-10-31",
    ]);

    rows.searchParams.delete("token");
    expect((await fetch(rows)).status).toBe(403);
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-preset="yesterday"');
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("answers every refresh while a tick writes, and shows the new rows once written", async () => {
    const root = fixtureLog();
    const served = serveDashboard({
      listen: { host: "127.0.0.1", port: null },
      port: 0,
      root,
      token: "fixture-token",
    });
    stop = served.stop;
    const today = new URL("/rows", served.url);
    today.searchParams.set("token", "fixture-token");
    today.searchParams.set("from", "2026-11-01T00:00:00.000Z");
    today.searchParams.set("to", "2026-11-01T23:59:59.999Z");
    const keys = async () => {
      const at = Date.now();
      const answer = await fetch(today);
      const took = Date.now() - at;
      expect(answer.status).toBe(200);
      const body = (await answer.json()) as { rows: LogRow[] };
      return { took, keys: body.rows.map((r) => r.key) };
    };

    const script = join(root, "writer.ts");
    const started = join(root, "started");
    writeFileSync(script, WRITER(3000));
    const writer = Bun.spawn([process.execPath, script, root, started], {
      env: {
        ...process.env,
        ROW: JSON.stringify(
          ended("2026-11-01T02:00:00.000Z", "r-new", "converged"),
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitFor("the writer's transaction", () => existsSync(started));
    // While the write holds its lock, each refresh answers at once, without the row it has not committed.
    for (let i = 0; i < 3; i++) {
      const during = await keys();
      expect(during.keys).toEqual(["ended r-today"]);
      expect(during.took).toBeLessThan(1000);
    }
    await expectSpawnExited(writer, 0);
    expect((await keys()).keys).toEqual(["ended r-new", "ended r-today"]);
  }, 30_000);
});
