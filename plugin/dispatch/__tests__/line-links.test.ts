/**
 * Every row the line writes about a tracker item carries the item's link and
 * title when a read of the tick returned them: an item the walk could not
 * place, a claimed item that stalled, and, for one no read gave a link, a
 * link worked out from another item link of the repository's tracker. The
 * outcome log's rows carry the same through `aboutTargets`.
 */
import { describe, expect, it } from "bun:test";
import { aboutTargets, buildLine, type RepoLineInput } from "../lib/line.ts";
import { endedRow } from "../lib/log.ts";
import { lineInputOf } from "../lib/tick-line.ts";
import type { ReadRecord } from "../lib/launches.ts";
import { input, PATH, record, REPO, report } from "./line-fixtures.ts";

const SESSIONS = { ok: true, source: "fake", workspaces: [] } as const;

function readsOf(known: RepoLineInput["known"]): Map<string, RepoLineInput> {
  return new Map([
    [PATH, { drives: [], known, sessions: { ...SESSIONS, workspaces: [] } }],
  ]);
}

describe("an item's link and title on the line", () => {
  it("comes with an item the walk could not place, as the tracker listing returned it", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            unplaced: [
              {
                target: "WEB-80",
                title: "Backfill the ledger",
                url: "https://tracker.example/acme/issue/WEB-80/backfill-the-ledger",
                record: "tracker",
                reason: "the child cannot be read completely",
              },
            ],
          }),
        ],
      }),
    );
    expect(line.queue).toEqual([
      expect.objectContaining({
        target: "WEB-80",
        group: "never",
        title: "Backfill the ledger",
        url: "https://tracker.example/acme/issue/WEB-80/backfill-the-ledger",
      }),
    ]);
  });

  it("comes with a claimed item that stalled, from the tracker's listing of the claims", () => {
    const known = lineInputOf(
      [],
      { open: [], merged: [] },
      {
        pickups: [],
        claimed: [
          {
            key: "#240",
            title: "Retry the webhook delivery",
            url: "https://forge.example/example-org/web/issues/240",
            state: "In Progress",
          },
        ],
      },
      { ...SESSIONS, workspaces: [] },
    ).known;
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [
              {
                stage: "notify",
                target: "#240",
                record: "tracker",
                reason: "stalled pickup",
                evidence: { idleSince: "2026-11-03T12:25:00.000Z" },
                cause: "stalled",
                notice: { key: "k", text: "t" },
              },
            ],
          }),
        ],
        inputs: readsOf(known),
      }),
    );
    expect(line.needs[0]).toMatchObject({
      target: "#240",
      title: "Retry the webhook delivery",
      url: "https://forge.example/example-org/web/issues/240",
    });
  });

  it("is worked out from another item link of the repository's tracker when no read gave one", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            unplaced: [
              {
                target: "#231",
                record: "tracker",
                reason: "assigned by someone who cannot write",
                cause: "assigner-cannot-write",
              },
            ],
          }),
        ],
        inputs: readsOf([
          {
            target: "#12",
            title: "Another item",
            url: "https://forge.example/example-org/web/issues/12",
          },
        ]),
      }),
    );
    expect(line.needs[0]?.url).toBe(
      "https://forge.example/example-org/web/issues/231",
    );
    expect(line.queue[0]?.url).toBe(
      "https://forge.example/example-org/web/issues/231",
    );
  });
});

describe("an outcome-log row's link and title", () => {
  const about = aboutTargets(
    REPO,
    readsOf([
      {
        target: "WEB-4",
        title: "Add the audit export",
        url: "https://tracker.example/acme/issue/WEB-4/add-the-audit-export",
      },
    ]).get(PATH),
    [],
  );
  const ended: ReadRecord = {
    ...record(),
    record: {
      ...record().record,
      action: "pickup",
      pr: null,
      item: "WEB-4",
    },
  };

  it("are the ones the tick's reads gave the target", () => {
    const row = endedRow(
      ended,
      "2026-11-03T16:40:00.000Z",
      { takenOver: false, merged: null },
      null,
      about("WEB-4"),
    );
    expect(row).toMatchObject({
      target: "WEB-4",
      title: "Add the audit export",
      url: "https://tracker.example/acme/issue/WEB-4/add-the-audit-export",
    });
  });

  it("are left off a row whose target no read named or linked", () => {
    const row = endedRow(
      { ...ended, record: { ...ended.record, item: "the outcome log" } },
      "2026-11-03T16:40:00.000Z",
      { takenOver: false, merged: null },
      null,
      about("the outcome log"),
    );
    expect("title" in row).toBe(false);
    expect("url" in row).toBe(false);
  });
});
