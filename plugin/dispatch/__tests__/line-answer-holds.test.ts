import { lineInputOf } from "../lib/tick-line.ts";
import { stationContextOf, stationDecision } from "../lib/line-station.ts";
import { ok as assert } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLine, writeLine } from "../lib/line-store.ts";
import { mergeLine, readBy } from "../lib/line-merge.ts";
import { closeStateDb } from "../lib/state.ts";
import { expect, it } from "bun:test";
import { buildLine } from "../lib/line.ts";
import { input, report, REPO, PATH } from "./line-fixtures.ts";

it("carries answered holds from the quiet list into the dashboard snapshot", () => {
  const why =
    "maintainer-a chose hold; nothing is done; it returns when its facts change";
  const r = report({
    quiet: [
      { target: "#17", class: "answered-hold", why },
      { target: "#18", class: "claimed-idle", why: "not a held decision" },
    ],
  });
  expect(buildLine(input({ reports: [r] })).answeredHolds).toEqual([
    { repo: REPO, target: "#17", why },
  ]);
});

it("stores answered holds and keeps only unread repositories' holds on a partial tick", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-answer-holds-"));
  try {
    const before = readBy(
      buildLine(
        input({
          reports: [
            report({
              quiet: [
                {
                  target: "#17",
                  class: "answered-hold",
                  why: "maintainer-a chose hold",
                },
              ],
            }),
            report({
              slug: "example-org/api",
              path: "/srv/work/api",
              quiet: [
                {
                  target: "#18",
                  class: "answered-hold",
                  why: "maintainer-b chose hold",
                },
              ],
            }),
          ],
        }),
      ),
      "before",
      "2026-11-03T16:45:00.000Z",
    );
    writeLine(before, "{}", root);
    const stored = readLine(root);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    assert(stored.value);
    expect(stored.value.answeredHolds).toEqual(before.answeredHolds);
    const fresh = readBy(
      buildLine(input({ reports: [report()] })),
      "after",
      "2026-11-03T16:46:00.000Z",
    );
    const merged = mergeLine(
      stored.value,
      fresh,
      [{ path: PATH }, { path: "/srv/work/api" }],
      "fresh",
    );
    expect(merged.answeredHolds).toEqual([
      {
        repo: "example-org/api",
        target: "#18",
        why: "maintainer-b chose hold",
      },
    ]);
  } finally {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

it("carries the configured issue repository through the line's station destination", () => {
  const reads = lineInputOf(
    [],
    { open: [], merged: [] },
    {
      pickups: [],
      claimed: [],
      adapter: "github",
      issueRepository: "example-org/tasks",
    },
    { ok: true, source: "fake", workspaces: [] },
  );
  expect(reads.tracker).toEqual({
    adapter: "github",
    repository: "example-org/tasks",
  });
  const decision = stationDecision(
    {
      stage: "notify",
      target: "#17",
      record: "tracker",
      reason: "stalled pickup",
      cause: "stalled",
      evidence: { state: "In Progress" },
    },
    stationContextOf(REPO, reads),
  );
  expect(decision?.answer?.repository).toBe("example-org/tasks");
});
