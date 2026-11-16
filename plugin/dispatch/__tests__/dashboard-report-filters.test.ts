/**
 * `jig dispatch dashboard`'s log over the closing report's columns: it
 * filters on a report's `cause` and on who wrote it (`by`), offers the
 * values each takes in the window, narrows to one piece of work's rows for
 * its page, and leaves the `notify` stage's `notices_read` rows out unless
 * the class filter names them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardData } from "../dashboard.ts";
import type { RowsAnswer } from "../lib/dashboard-contract.ts";
import { type EndedRow, type LogRow, writeRow } from "../lib/log.ts";
import { noticesReadRow } from "../lib/notices-read.ts";
import { closeStateDb } from "../lib/state.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const WEB = "example-org/web";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function ended(
  record: string,
  target: string,
  report: Partial<EndedRow>,
): LogRow {
  return {
    kind: "ended",
    key: `ended ${record}`,
    at: "2026-11-01T08:00:00.000Z",
    repo: WEB,
    stage: "pickup",
    target,
    record,
    account: "a",
    model: null,
    durationMs: 60_000,
    rounds: null,
    class: "refused",
    reason: `exit for ${record}`,
    ...report,
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-report-log-"));
  roots.push(root);
  for (const row of [
    ended("r-scope", "#12", {
      by: "agent",
      concluded: "Stopped: the item asks for a schema the repository lacks.",
      suggested_next: {
        step: "Decide the schema.",
        owner: "person",
        act: "Decide",
      },
      cause: "scope",
    }),
    ended("r-none", "#12", { by: "none" }),
    ended("r-tool", "#13", {
      by: "agent",
      concluded: "The test runner would not start.",
      suggested_next: { step: "Run the pickup again.", owner: "line" },
      cause: "tool-failed",
    }),
    noticesReadRow(
      WEB,
      { ok: true, source: "test", workspaces: [] },
      null,
      "2026-11-01T09:00:00.000Z",
    ),
  ])
    writeRow(row, root);
  return root;
}

function rows(root: string, params: Record<string, string>): RowsAnswer {
  const answer = dashboardData(new URLSearchParams(params), NOW, root);
  if (!answer.ok) throw new TestReadError(answer.failure.reason);
  return answer.value;
}

class TestReadError extends Error {
  override name = "TestReadError";
}

const keys = (answer: RowsAnswer) => answer.rows.map((r) => r.key);

describe("the dashboard's log over closing reports", () => {
  it("filters on a report's cause and on who wrote it", () => {
    const root = fixture();
    expect(keys(rows(root, { cause: "scope" }))).toEqual(["ended r-scope"]);
    expect(keys(rows(root, { by: "none" }))).toEqual(["ended r-none"]);
    expect(keys(rows(root, { by: "agent" })).sort()).toEqual([
      "ended r-scope",
      "ended r-tool",
    ]);
    expect(rows(root, { by: "agent", cause: "tool-failed" }).total).toBe(1);
  });

  it("offers the causes and the writers the window holds", () => {
    const answer = rows(fixture(), {});
    expect(answer.options.cause).toEqual(["scope", "tool-failed"]);
    expect(answer.options.by).toEqual(["agent", "none"]);
  });

  it("narrows to one piece of work's rows for its page", () => {
    const answer = rows(fixture(), { repo: WEB, target: "#12" });
    expect(keys(answer).sort()).toEqual(["ended r-none", "ended r-scope"]);
  });

  it("leaves the notices_read rows out unless the class filter names them", () => {
    const root = fixture();
    const all = rows(root, {});
    expect(all.total).toBe(3);
    expect(all.counts).not.toHaveProperty("event: notices_read");
    const named = rows(root, { class: "event: notices_read" });
    expect(named.total).toBe(1);
    expect(named.rows[0]).toMatchObject({
      event: "notices_read",
      stage: "notify",
      read: null,
    });
    expect(named.counts["event: notices_read"]).toBe(1);
  });
});
