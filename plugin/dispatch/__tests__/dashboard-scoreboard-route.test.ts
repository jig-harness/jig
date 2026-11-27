/**
 * `GET /scoreboard` and `GET /checks` as the dashboard serves them: both
 * refuse a request without the token and answer 405 to a write; the
 * scoreboard answers from the log under the state directory, and the live
 * checks answer `checks-unavailable` until a report reader is supplied.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failed, ok } from "../../shared/outcome.ts";
import { type ChecksReader, serveDashboard } from "../dashboard.ts";
import { type LogRow, writeRow } from "../lib/log.ts";
import { closeStateDb } from "../lib/state.ts";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

let roots: string[] = [];
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  closeStateDb();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A running dashboard over a log with one merged run, and a reader of its paths. */
function served(readChecks?: ChecksReader) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-scoreboard-"));
  roots.push(root);
  const merged = {
    kind: "ended",
    key: "ended 1",
    at: "2026-11-26T10:00:00.000Z",
    repo: "example-org/web",
    stage: "rearm",
    target: "PR #1",
    record: "r1",
    account: "a",
    model: null,
    durationMs: 3_600_000,
    rounds: 2,
    class: "merged",
    reason: "merged",
    release: "0.2.0",
  } as LogRow;
  writeRow(merged, root);
  const dashboard = serveDashboard({
    listen: { host: "127.0.0.1", port: null },
    port: 0,
    root,
    token: "fixture-token",
    now: () => NOW,
    ...(readChecks === undefined ? {} : { readChecks }),
  });
  stop = dashboard.stop;
  return (
    path: string,
    token: string | null = "fixture-token",
    method = "GET",
  ) => {
    const url = new URL(path, dashboard.url);
    url.searchParams.delete("token");
    if (token !== null) url.searchParams.set("token", token);
    return fetch(url, { method });
  };
}

describe("the scoreboard route", () => {
  it("answers each release's numbers from the log, and refuses a request without the token or a write", async () => {
    const read = served();
    const answer = await read("/scoreboard");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      ok: true,
      value: {
        window: "7d",
        slots: null,
        rows: [{ release: "0.2.0", merged: 1, medianRounds: 2 }],
        regressions: [],
      },
    });
    expect((await read("/scoreboard", null)).status).toBe(403);
    expect((await read("/scoreboard", "fixture-token", "POST")).status).toBe(
      405,
    );
  });
});

describe("the live-check route", () => {
  it("answers checks-unavailable until a report reader is supplied, then the reader's value or failure", async () => {
    const none = await served()("/checks");
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({
      ok: false,
      failure: { code: "checks-unavailable" },
    });
    stop?.();
    const report = await served(() => ok({ checks: ["a"] }))("/checks");
    expect(await report.json()).toEqual({ ok: true, value: { checks: ["a"] } });
    stop?.();
    const refused = served(() => failed("checks-unreadable", "no"));
    expect((await refused("/checks")).status).toBe(503);
    expect((await refused("/checks", null)).status).toBe(403);
    expect((await refused("/checks", "fixture-token", "POST")).status).toBe(
      405,
    );
  });

  it("reports a defect in the reader as the boundary does, with no detail", async () => {
    const answer = await served(() => {
      throw new Error("a bug");
    })("/checks");
    expect(answer.status).toBe(500);
    expect(await answer.json()).toMatchObject({
      ok: false,
      failure: { code: "defect" },
    });
  });
});
