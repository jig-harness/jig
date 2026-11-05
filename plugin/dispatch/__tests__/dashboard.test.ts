/**
 * `jig dispatch dashboard` over a fixture outcome log: filtered to
 * yesterday it shows yesterday's rows only, with each class counted; the
 * server refuses a request without its token, and writes nothing; open
 * while a tick writes, it answers every refresh at once and shows the new
 * rows once they are written.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { dashboardData, serveDashboard } from "../dashboard.ts";
import type { LineSnapshot, RowsAnswer } from "../lib/dashboard-contract.ts";
import { writeLine } from "../lib/line-store.ts";
import { insertRow, writeRow, type LogRow } from "../lib/log.ts";
import { closeStateDb, SCHEMA_VERSION, stateDb } from "../lib/state.ts";
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

/** A read's value; a failure here fails the test with its reason. */
function rowsOf(params: URLSearchParams, root: string): RowsAnswer {
  const answer = dashboardData(params, NOW, root);
  if (!answer.ok) throw new TestReadError(answer.failure.reason);
  return answer.value;
}

class TestReadError extends Error {
  override name = "TestReadError";
}

let stop: (() => void) | null = null;
const bulkRoots: string[] = [];
afterEach(() => {
  stop?.();
  stop = null;
  for (const root of bulkRoots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
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
    const data = rowsOf(new URLSearchParams(YESTERDAY), root);
    expect(data.total).toBe(3);
    expect(data.truncated).toBe(false);
  });

  it("caps the rows at the newest 5000 while the counts and total cover the whole window", () => {
    const base = Date.parse("2026-10-31T00:00:00.000Z");
    const bulk = (count: number): string => {
      const root = mkdtempSync(join(tmpdir(), "dispatch-log-"));
      bulkRoots.push(root);
      const db = stateDb(root);
      db.transaction(() => {
        for (let i = 0; i < count; i++)
          insertRow(
            db,
            ended(
              new Date(base + i * 1000).toISOString(),
              `r-${i}`,
              "converged",
            ),
          );
      })();
      return root;
    };
    const over = rowsOf(new URLSearchParams(YESTERDAY), bulk(5001));
    expect(over.rows).toHaveLength(5000);
    expect(over.rows[0]?.key).toBe("ended r-5000");
    expect(over.rows.at(-1)?.key).toBe("ended r-1");
    expect(over.total).toBe(5001);
    expect(over.counts).toEqual({ converged: 5001 });
    expect(over.truncated).toBe(true);
    const exact = rowsOf(new URLSearchParams(YESTERDAY), bulk(5000));
    expect(exact.rows).toHaveLength(5000);
    expect(exact.total).toBe(5000);
    expect(exact.truncated).toBe(false);
  });

  it("shows only yesterday's rows when filtered to yesterday, with each class counted", () => {
    const root = fixtureLog();
    const data = rowsOf(new URLSearchParams(YESTERDAY), root);
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
    const web = rowsOf(
      new URLSearchParams({
        ...YESTERDAY,
        repo: "example-org/web",
        class: "quota wall",
      }),
      root,
    );
    expect(web.rows.map((r) => r.key)).toEqual(["ended r-y1"]);
    expect(web.total).toBe(1);
    // The counts ignore the class filter, so another class can still be chosen.
    expect(web.counts).toEqual({ "event: drifting": 1, "quota wall": 1 });
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
    const body = (await answer.json()) as { value: { rows: LogRow[] } };
    expect(body.value.rows.map((r) => r.at.slice(0, 10))).toEqual([
      "2026-10-31",
      "2026-10-31",
      "2026-10-31",
    ]);

    rows.searchParams.delete("token");
    expect((await fetch(rows)).status).toBe(403);
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("counts a class on three of the last seven nights as recurring, and fewer as not", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-log-"));
    bulkRoots.push(root);
    const hoursAgo = (hours: number) =>
      new Date(NOW - hours * 3_600_000).toISOString();
    for (const hours of [2, 26, 50, 51])
      writeRow(ended(hoursAgo(hours), `r-web-${hours}`, "stalled"), root);
    // Two nights on another repository is not recurring.
    for (const hours of [2, 26])
      writeRow(
        ended(hoursAgo(hours), `r-api-${hours}`, "stalled", "example-org/api"),
        root,
      );
    // Eight nights back it is outside the seven; a class that finished well never recurs.
    writeRow(ended(hoursAgo(8 * 24), "r-old", "stalled"), root);
    for (const hours of [3, 27, 51])
      writeRow(ended(hoursAgo(hours), `r-well-${hours}`, "converged"), root);
    const { recurring, logHasRows } = rowsOf(new URLSearchParams(), root);
    expect(recurring).toEqual([
      {
        class: "stalled",
        repo: "example-org/web",
        nights: [false, false, false, false, true, true, true],
        rows: 4,
      },
    ]);
    expect(logHasRows).toBe(true);
  });

  it("buckets recurrence by host day, so the nights do not move with the query time", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-log-"));
    bulkRoots.push(root);
    for (const [i, at] of [
      "2026-11-01T16:46:00.000Z",
      "2026-11-01T16:48:00.000Z",
      "2026-11-02T16:48:00.000Z",
    ].entries())
      writeRow(ended(at, `r-day-${i}`, "stalled"), root);
    const nightsAt = (nowIso: string) => {
      const answer = dashboardData(
        new URLSearchParams(),
        Date.parse(nowIso),
        root,
      );
      if (!answer.ok) throw new TestReadError(answer.failure.reason);
      return answer.value.recurring.map((r) => r.nights.filter(Boolean).length);
    };
    // Two host days hold the failures, however late on Nov 3 the page asks.
    expect(nightsAt("2026-11-03T16:47:00.000Z")).toEqual([]);
    expect(nightsAt("2026-11-03T23:00:00.000Z")).toEqual([]);
    writeRow(ended("2026-11-03T10:00:00.000Z", "r-day-3", "stalled"), root);
    expect(nightsAt("2026-11-03T16:47:00.000Z")).toEqual([3]);
  });

  it("reads a named window on the host's clock, and the whole day for today", () => {
    const root = fixtureLog();
    const today = rowsOf(new URLSearchParams({ window: "today" }), root);
    expect(today.window).toBe("today");
    expect(new Date(today.from).getHours()).toBe(0);
    expect(Date.parse(today.to)).toBe(NOW);
    const yesterday = rowsOf(
      new URLSearchParams({ window: "yesterday" }),
      root,
    );
    expect(Date.parse(yesterday.to)).toBe(Date.parse(today.from) - 1);
    const range = rowsOf(
      new URLSearchParams({ ...YESTERDAY, window: "7d" }),
      root,
    );
    expect(range.window).toBe("range");
    expect(range.from).toBe(YESTERDAY.from);
  });

  /** A server over `root` that answers only the requests a test sends. */
  function served(root: string) {
    const dashboard = serveDashboard({
      listen: { host: "127.0.0.1", port: null },
      port: 0,
      root,
      token: "fixture-token",
      now: () => NOW,
    });
    stop = dashboard.stop;
    return (
      path: string,
      token: string | null = "fixture-token",
      headers: Record<string, string> = {},
    ) => {
      const url = new URL(path, dashboard.url);
      if (token !== null) url.searchParams.set("token", token);
      return fetch(url, { headers });
    };
  }

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
    accounts: [],
    lastAccount: null,
    sessions: [],
    needs: [],
    queue: [],
    repos: [],
  };

  it("answers the newest tick's line and its receipt, and says so when there is none yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-log-"));
    bulkRoots.push(root);
    const read = served(root);
    const before = (await (await read("/state")).json()) as {
      value: { line: unknown; now: string; schema: number };
    };
    expect(before.value.line).toBeNull();
    expect(before.value.now).toBe(new Date(NOW).toISOString());
    expect(before.value.schema).toBe(SCHEMA_VERSION);
    const missing = await read("/receipt");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      ok: false,
      failure: { code: "no-receipt" },
    });

    writeLine(LINE, '{"runId":"the receipt"}', root);
    const after = (await (await read("/state")).json()) as {
      value: { line: LineSnapshot };
    };
    expect(after.value.line.runId).toBe(LINE.runId);
    expect(await (await read("/receipt")).json()).toEqual({
      runId: "the receipt",
    });
    // A receipt named by the run the page shows is that run's, or a refusal that says a newer tick took its place.
    const named = await read(`/receipt?run=${LINE.runId}`);
    expect(named.status).toBe(200);
    const stale = await read("/receipt?run=an-older-tick");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      failure: { code: "receipt-superseded" },
    });
  });

  it("refuses a wrong token with a page that runs nothing, and an API read with a code", async () => {
    const read = served(fixtureLog());
    const page = await read("/", "wrong");
    expect(page.status).toBe(403);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(await page.text()).not.toContain("<script");
    const api = await read("/state", null);
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({
      ok: false,
      failure: {
        code: "token-refused",
        reason: "this dashboard needs the token its command printed",
      },
    });
  });

  it("runs the page under a policy naming its own script, and sends it compressed", async () => {
    const read = served(fixtureLog());
    const page = await read("/");
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    // fetch asks for compression and undoes it, so the header is what shows it.
    expect(page.headers.get("content-encoding")).toBe("gzip");
    const html = await page.text();
    const script = /<script>([\s\S]*)<\/script>/i.exec(html)?.[1] ?? "";
    expect(script).not.toBe("");
    expect(script).not.toMatch(/<\/script/i);
    const hash = createHash("sha256").update(script).digest("base64");
    expect(policy).toContain(`'sha256-${hash}'`);
  });

  it("sends gzip only when the request's Accept-Encoding allows it", async () => {
    const read = served(fixtureLog());
    const encoding = async (accept: string) =>
      (
        await read("/", "fixture-token", { "accept-encoding": accept })
      ).headers.get("content-encoding");
    expect(await encoding("gzip;q=0, identity;q=1")).toBeNull();
    expect(await encoding("*;q=0")).toBeNull();
    expect(await encoding("gzip;q=0.5")).toBe("gzip");
  });

  it("answers a read that fails with its code and reason, and what was thrown only in its log", async () => {
    const root = fixtureLog();
    const read = served(root);
    const newer = SCHEMA_VERSION + 1;
    stateDb(root).run(`PRAGMA user_version = ${newer}`);
    closeStateDb(root);
    const answer = await read("/rows");
    expect(answer.status).toBe(503);
    const body = (await answer.json()) as {
      ok: false;
      failure: { code: string; reason: string; cause?: unknown };
    };
    expect(body.failure.code).toBe("log-unreadable");
    expect(body.failure.reason).toContain(`version ${newer}`);
    expect(body.failure.cause).toBeUndefined();
    closeStateDb(root);
    const state = await read("/state");
    expect(state.status).toBe(503);
    expect(await state.json()).toMatchObject({
      failure: { code: "line-unreadable" },
    });
  });

  it("catches a bug at the boundary: a code and a sentence for the page, and the server still answers", async () => {
    let broken = true;
    const root = fixtureLog();
    const dashboard = serveDashboard({
      listen: { host: "127.0.0.1", port: null },
      port: 0,
      root,
      token: "fixture-token",
      now: () => {
        if (broken) throw new TestReadError("a bug with its own message");
        return NOW;
      },
    });
    stop = dashboard.stop;
    const url = new URL("/state", dashboard.url);
    url.searchParams.set("token", "fixture-token");
    const answer = await fetch(url);
    expect(answer.status).toBe(500);
    const text = await answer.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      failure: { code: "defect" },
    });
    expect(text).not.toContain("a bug with its own message");
    broken = false;
    expect((await fetch(url)).status).toBe(200);
  });

  it("answers no other route and no other method", async () => {
    const root = fixtureLog();
    const read = served(root);
    const none = await read("/elsewhere");
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({
      failure: { code: "not-found" },
    });
    const url = new URL(none.url);
    url.pathname = "/rows";
    const posted = await fetch(url, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(await posted.json()).toMatchObject({
      failure: { code: "not-allowed" },
    });
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
      const body = (await answer.json()) as { value: { rows: LogRow[] } };
      return { took, keys: body.value.rows.map((r) => r.key) };
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
