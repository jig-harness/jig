/**
 * The line's rows carry the work they are linked to (`LineLinks`): a pull
 * request's row its items, each with the link the line builds for an item,
 * and an item's row its open pull requests; a repository its configured
 * tracker. A row the tick could not tell about carries no links at all, so
 * the page can tell "none" from "not known".
 */
import { describe, expect, it } from "bun:test";
import { teamKeys } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { BoardCard } from "../lib/board.ts";
import { buildLine, type RepoLineInput } from "../lib/line.ts";
import { lineInputOf } from "../lib/tick-line.ts";
import type { Action } from "../lib/types.ts";
import type { PrLinkText } from "../lib/work-links.ts";
import { input, PATH, record, REPO, report } from "./line-fixtures.ts";

const SESSIONS = { ok: true, source: "fake", workspaces: [] } as const;
const PR_URL = (n: number) => `https://forge.example/${REPO}/pull/${n}`;

const TEXTS: PrLinkText[] = [
  {
    number: 456,
    url: PR_URL(456),
    headRefName: "web-412-paginate-the-audit-list",
    body: "Closes WEB-413",
    closing: [],
  },
  {
    number: 457,
    url: PR_URL(457),
    headRefName: "renovate/bun",
    body: "",
    closing: [],
  },
];

const TRACKED = {
  pickups: [
    {
      key: "WEB-412",
      title: "Paginate the audit list",
      url: "https://tracker.example/acme/issue/WEB-412/paginate",
      state: "Todo",
      assignee: "factory",
      assignedBy: "maintainer-a",
    },
  ],
  claimed: [],
  keys: teamKeys("WEB"),
  adapter: "linear",
  issueRepository: null,
};

function readsOf(
  linkTexts: PrLinkText[] | undefined,
): Map<string, RepoLineInput> {
  return new Map([
    [
      PATH,
      lineInputOf(
        [],
        {
          open: TEXTS.map((t) => ({
            number: t.number,
            url: t.url,
            title: `PR ${t.number}`,
          })),
          merged: [],
          ...(linkTexts === undefined ? {} : { linkTexts }),
        },
        TRACKED,
        { ...SESSIONS, workspaces: [] },
        { slug: REPO, branchPattern: "{key_lower}-{slug}" },
      ),
    ],
  ]);
}

const rearm = (target: string): Action => ({
  stage: "rearm",
  target,
  record: "forge",
  reason: "re-armable",
  evidence: {},
});

const pickup: Action = {
  stage: "pickup",
  target: "WEB-412",
  record: "tracker",
  reason: "assigned",
  evidence: {},
};

const followup: Action = {
  stage: "followup",
  target: "PR #300",
  record: "forge",
  reason: "merged with no marker",
  evidence: {},
};

const stalled: Action = {
  stage: "notify",
  target: "WEB-413",
  record: "tracker",
  reason: "stalled pickup",
  evidence: {},
  cause: "stalled",
};

function card(n: number): BoardCard {
  return {
    number: n,
    url: PR_URL(n),
    title: "change",
    head: "a".repeat(40),
    place: "ready",
    lane: "merge-now",
    says: "ready",
    waitsOn: { kind: "person", act: "merge" },
    conditions: [],
    failing: [],
    requested: [],
    command: null,
    withheld: null,
    unblocks: [],
    since: "2026-11-09T10:00:00Z",
  };
}

function lineWith(linkTexts: PrLinkText[] | undefined) {
  return buildLine(
    input({
      reports: [
        report({
          actions: [
            rearm("PR #456"),
            rearm("PR #457"),
            pickup,
            followup,
            stalled,
          ],
          board: {
            ok: true,
            reason: null,
            cards: [card(456)],
            unread: [],
            pending: [],
            ms: 0,
            cost: 0,
            remaining: null,
          },
        }),
      ],
      inputs: readsOf(linkTexts),
      records: [record({ action: "rearm", pr: 456 })],
    }),
  );
}

describe("the work a row is linked to", () => {
  const line = lineWith(TEXTS);
  const queued = new Map(line.queue.map((q) => [q.target, q]));

  it("gives a pull request's row its items, each with the link the line builds for an item", () => {
    expect(queued.get("PR #456")?.links).toEqual({
      items: [
        {
          key: "WEB-412",
          url: "https://tracker.example/acme/issue/WEB-412/paginate",
        },
        { key: "WEB-413", url: "https://tracker.example/acme/issue/WEB-413" },
      ],
      prs: [],
    });
    expect(line.sessions[0]?.links?.items.map((i) => i.key)).toEqual([
      "WEB-412",
      "WEB-413",
    ]);
    expect(line.ready?.[0]?.links?.items.map((i) => i.key)).toEqual([
      "WEB-412",
      "WEB-413",
    ]);
  });

  it("gives a pull request linked to nothing an empty list, and an item its open pull requests", () => {
    expect(queued.get("PR #457")?.links).toEqual({ items: [], prs: [] });
    expect(queued.get("WEB-412")?.links).toEqual({
      items: [],
      prs: [{ number: 456, url: PR_URL(456) }],
    });
    expect(line.needs.find((n) => n.target === "WEB-413")?.links).toEqual({
      items: [],
      prs: [{ number: 456, url: PR_URL(456) }],
    });
  });

  it("gives none to a pull request the open read did not hold", () => {
    expect(queued.get("PR #300")).toBeDefined();
    expect(queued.get("PR #300")?.links).toBeUndefined();
  });

  it("gives none to any row when the repository's query did not read in full", () => {
    const unread = lineWith(undefined);
    expect(unread.queue.length).toBeGreaterThan(0);
    expect(unread.queue.every((q) => q.links === undefined)).toBe(true);
    expect(unread.needs.every((n) => n.links === undefined)).toBe(true);
    expect(unread.sessions.every((s) => s.links === undefined)).toBe(true);
    expect(unread.ready?.every((r) => r.links === undefined)).toBe(true);
  });
});

describe("a repository's tracker on the line", () => {
  it("names the configured adapter", () => {
    expect(lineWith(TEXTS).repos[0]?.tracker).toEqual({ adapter: "linear" });
  });

  it("is null when the tracker configuration did not read, and absent when no read says", () => {
    const of = (adapter: string | null | undefined) =>
      buildLine(
        input({
          inputs: new Map([
            [
              PATH,
              lineInputOf(
                [],
                { open: [], merged: [] },
                {
                  pickups: [],
                  claimed: null,
                  ...(adapter === undefined ? {} : { adapter }),
                },
                { ...SESSIONS, workspaces: [] },
              ),
            ],
          ]),
        }),
      ).repos[0];
    expect(of(null)?.tracker).toBeNull();
    expect(of(undefined)).toBeDefined();
    expect(of(undefined)?.tracker).toBeUndefined();
  });
});
