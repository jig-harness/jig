/**
 * The line a tick leaves for the dashboard, from what it read: each panel's
 * rows from the records that hold them, and what no record holds left out.
 */
import { describe, expect, it } from "bun:test";
import type { LineAccount } from "../lib/dashboard-contract.ts";
import type { ReadRecord } from "../lib/launches.ts";
import {
  buildLine,
  decisionOf,
  type LineInput,
  type RepoLineInput,
  type RepoStored,
} from "../lib/line.ts";
import type { MachineConfig } from "../lib/machine-config.ts";
import type {
  Action,
  DispatchSection,
  DrivenPr,
  RepoReport,
} from "../lib/types.ts";

const REPO = "example-org/web";
const PATH = "/srv/work/web";
const NOW = "2026-11-03T16:45:00.000Z";

function report(fields: Partial<RepoReport> = {}): RepoReport {
  return {
    path: PATH,
    slug: REPO,
    refused: null,
    section: null,
    followupSince: null,
    records: [],
    actions: [],
    running: [],
    unplaced: [],
    launches: [],
    notifications: [],
    quiet: [],
    ...fields,
  };
}

const MACHINE: MachineConfig = {
  path: "/home/person/.jig/dispatch.yaml",
  repositories: [
    {
      path: PATH,
      stages: ["rearm", "notify"],
      followupSince: null,
      owner: true,
    },
  ],
  accounts: [],
  intervalMs: 300_000,
  wallBackoffMs: 3_600_000,
  runtimeTimeoutMs: 60_000,
  workspaceTimeoutMs: 60_000,
  receiptsDays: 30,
  dashboardListen: null,
  sharedRecords: "forge",
  send: true,
};

const NOTHING_STORED: RepoStored = {
  nudges: [],
  holds: [],
  notified: new Map(),
};

function input(fields: Partial<LineInput> = {}): LineInput {
  return {
    runId: "run",
    startedAt: "2026-11-03T16:44:00.000Z",
    finishedAt: NOW,
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    plugin: "1.2.3",
    timeZone: "UTC",
    machine: MACHINE,
    reports: [report()],
    inputs: new Map(),
    stored: () => NOTHING_STORED,
    records: [],
    accounts: [],
    lastAccount: null,
    recentTicksMs: [],
    ...fields,
  };
}

function reads(
  fields: Partial<RepoLineInput> = {},
): Map<string, RepoLineInput> {
  return new Map([
    [
      PATH,
      {
        drives: [],
        known: [],
        sessions: { ok: true, source: "fake", workspaces: [] },
        ...fields,
      },
    ],
  ]);
}

const FRAMED = [
  "[thread] PRRT_x1 · class scope · parked at round 3",
  "  ## Question",
  "",
  "  Should the retry cover 4xx responses too?",
  "",
  "  ## Options",
  "",
  "  - **A** Retry 5xx only.",
  "",
  "  ## Recommended",
  "",
  "  **A**, because 429 wants its own issue.",
];

function parkedPr(): DrivenPr {
  return {
    number: 456,
    url: "https://forge.example/example-org/web/pull/456",
    title: "Retry the webhook on a 5xx",
    head: "feature/456",
    class: "parked",
    why: "stopped 8 (parked)",
    evidence: { heartbeat: "2026-11-03T07:05:00.000Z" },
    waiting: [{ key: "PRRT_x1", kind: "thread", lines: FRAMED }],
  };
}

const PARK: Action = {
  stage: "notify",
  target: "PR #456",
  record: "forge",
  reason: "drive ledger parked: a person answers",
  evidence: { url: parkedPr().url, heartbeat: "2026-11-03T07:05:00.000Z" },
  cause: "parked",
  notice: { key: "park-key", text: "the notice" },
};

function record(
  fields: Partial<ReadRecord["record"]> = {},
  state: ReadRecord["state"] = {
    kind: "alive",
    process: {
      hostId: "",
      host: "h",
      bootId: "b",
      pid: 1,
      start: "s",
      claimedAt: "2026-11-03T15:30:00.000Z",
    },
  },
): ReadRecord {
  return {
    record: {
      version: 1,
      id: "20261103T153000Z-aaaaaaaa",
      token: "t",
      action: "rearm",
      repo: REPO,
      repoPath: PATH,
      pr: 456,
      item: null,
      account: "work-a",
      vendor: "claude",
      configDir: "/c",
      wallBackoffMs: 0,
      passTimeoutSec: 5400,
      replaces: null,
      facts: "f",
      createdAt: "2026-11-03T15:30:00.000Z",
      workspace: { id: "w", path: "/srv/work/web/pr-456" },
      attempts: [],
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
      ...fields,
    },
    state,
    result: null,
  };
}

describe("decisionOf", () => {
  it("takes the frame's heading into fields and the record out of its indent", () => {
    const decision = decisionOf({
      key: "PRRT_x1",
      kind: "thread",
      lines: FRAMED,
    });
    expect(decision.question).toBe("Should the retry cover 4xx responses too?");
    expect(decision.recommendation).toBe(
      "**A**, because 429 wants its own issue.",
    );
    expect(decision.decisionClass).toBe("scope");
    expect(decision.lines[0]).toBe("## Question");
    expect(decision.lines).not.toContain(FRAMED[0]);
  });

  it("names no question for a park from before parks were framed", () => {
    const decision = decisionOf({
      key: "PRRT_x2",
      kind: "finding",
      lines: [
        "[finding] PRRT_x2 · class (none recorded) · parked at round 2",
        "  Decision needed: file the follow-up.",
      ],
    });
    expect(decision).toMatchObject({
      question: null,
      recommendation: null,
      decisionClass: null,
      lines: ["Decision needed: file the follow-up."],
    });
  });
});

describe("buildLine", () => {
  it("names an idle parked drive's joined workspace, independently of its notification destination", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [PARK],
            notifications: [
              {
                target: PARK.target,
                cause: "parked",
                key: "park-key",
                outcome: "sent",
                workspace: "/srv/notices",
                detail: "sent",
              },
            ],
          }),
        ],
        inputs: reads({
          drives: [parkedPr()],
          sessions: {
            ok: true,
            source: "fake",
            workspaces: [
              {
                id: "park",
                path: "/srv/parked",
                branch: "feature/456",
                items: [],
                prs: [456],
                agents: [],
                unverifiableTerminals: 0,
                comment: "",
                unread: false,
                name: "park",
              },
            ],
          },
        }),
      }),
    );
    expect(line.sessions).toEqual([]);
    expect(line.needs[0]).toMatchObject({
      workspace: "/srv/parked",
      notified: { workspace: "/srv/notices" },
    });
  });

  it("leaves an unknown workspace null rather than using the notices destination", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [PARK],
            notifications: [
              {
                target: PARK.target,
                cause: "parked",
                key: "park-key",
                outcome: "sent",
                workspace: "/srv/notices",
                detail: "sent",
              },
            ],
          }),
        ],
      }),
    );
    expect(line.needs[0]).toMatchObject({
      workspace: null,
      notified: { workspace: "/srv/notices" },
    });
  });

  it("uses the matching running launch's workspace and excludes another repository's records", () => {
    const line = buildLine(
      input({
        reports: [report({ actions: [PARK] })],
        records: [
          record({
            repo: "other/repo",
            workspace: { id: "other", path: "/srv/other" },
          }),
          record(),
        ],
      }),
    );
    expect(line.needs[0]).toMatchObject({ workspace: "/srv/work/web/pr-456" });
  });

  it("uses an explicit launch workspace for a failed follow-up and does not guess between double claims", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [
              { ...PARK, cause: "followup-failed", workspace: "/srv/followup" },
              { ...PARK, cause: "double-claim", target: "WEB-412" },
            ],
          }),
        ],
        inputs: reads({
          sessions: {
            ok: true,
            source: "fake",
            workspaces: ["one", "two"].map((id) => ({
              id,
              path: `/srv/${id}`,
              branch: id,
              items: ["WEB-412"],
              prs: [],
              agents: [],
              unverifiableTerminals: 0,
              comment: "",
              unread: false,
              name: id,
            })),
          },
        }),
      }),
    );
    expect(line.needs.map((n) => n.workspace)).toEqual(["/srv/followup", null]);
  });

  it.each([
    ["⚙ dispatched · notices", null],
    ["jig dispatch notices", null],
    ["jig dispatch notices", "desk"],
  ])(
    "excludes a renamed notices workspace with comment %s and destination %s even if joined",
    (comment, noticesBranch) => {
      const section = noticesBranch
        ? ({ noticesBranch } as DispatchSection)
        : null;
      const line = buildLine(
        input({
          reports: [report({ actions: [PARK], section })],
          inputs: reads({
            sessions: {
              ok: true,
              source: "fake",
              workspaces: [
                {
                  id: "notices",
                  path: "/srv/notices",
                  branch: "jig-dispatch-notices",
                  items: [],
                  prs: [456],
                  agents: [],
                  unverifiableTerminals: 0,
                  comment,
                  name: "renamed notices",
                  unread: false,
                },
              ],
            },
          }),
        }),
      );
      expect(line.needs[0]?.workspace).toBeNull();
    },
  );

  it.each(["working", "done"])(
    "keeps distinct joined workspaces ambiguous when one agent is %s",
    (state) => {
      const line = buildLine(
        input({
          reports: [report({ actions: [PARK] })],
          inputs: reads({
            sessions: {
              ok: true,
              source: "fake",
              workspaces: ["one", "two"].map((id) => ({
                id,
                path: `/srv/${id}`,
                branch: id,
                items: [],
                prs: [456],
                agents:
                  id === "one"
                    ? [{ id: "agent", state, agentType: null, since: null }]
                    : [],
                unverifiableTerminals: 0,
                comment: "",
                unread: false,
                name: id,
              })),
            },
          }),
        }),
      );
      expect(line.needs[0]?.workspace).toBeNull();
    },
  );

  it.each(["joined", "unknown-launch", "unknown-joined", "same-path"])(
    "reconciles a holding record with %s claims",
    (claim) => {
      const path = "/srv/work/web/pr-456";
      const line = buildLine(
        input({
          reports: [report({ actions: [PARK] })],
          records: [
            record(),
            ...(claim === "unknown-launch"
              ? [record({ id: "another", workspace: null })]
              : []),
          ],
          inputs: reads({
            sessions: {
              ok: true,
              source: "fake",
              workspaces:
                claim === "unknown-launch"
                  ? []
                  : [
                      {
                        id: "joined",
                        path:
                          claim === "unknown-joined"
                            ? ""
                            : claim === "same-path"
                              ? path
                              : "/srv/other",
                        branch: "feature/456",
                        items: [],
                        prs: [456],
                        agents: [
                          {
                            id: "agent",
                            state: "working",
                            agentType: null,
                            since: null,
                          },
                        ],
                        unverifiableTerminals: 0,
                        comment: "",
                        unread: false,
                        name: "joined",
                      },
                    ],
            },
          }),
        }),
      );
      expect(line.needs[0]?.workspace).toBe(
        claim === "same-path" ? path : null,
      );
    },
  );

  it("uses the stage record for an unanswered nudge when runtime reads fail", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [
              {
                ...PARK,
                cause: "nudge-unanswered",
                evidence: { record: "20261103T153000Z-aaaaaaaa" },
              },
            ],
          }),
        ],
        records: [record()],
        inputs: reads({
          sessions: { ok: false, source: "fake", reason: "offline" },
        }),
      }),
    );
    expect(line.needs[0]?.workspace).toBe("/srv/work/web/pr-456");
  });

  it("makes a need of a park, dated by its last ledger write, with its decisions and notification", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [PARK],
            notifications: [
              {
                target: "PR #456",
                cause: "parked",
                key: "park-key",
                outcome: "suppressed",
                workspace: "/srv/work/web/pr-456",
                detail: "sent",
              },
            ],
          }),
        ],
        inputs: reads({ drives: [parkedPr()] }),
        stored: () => ({
          ...NOTHING_STORED,
          notified: new Map([["park-key", "2026-11-03T07:10:00.000Z"]]),
        }),
      }),
    );
    expect(line.needs).toHaveLength(1);
    expect(line.needs[0]).toMatchObject({
      cause: "parked",
      stage: "rearm",
      target: "PR #456",
      pr: 456,
      item: null,
      title: "Retry the webhook on a 5xx",
      url: parkedPr().url,
      since: "2026-11-03T07:05:00.000Z",
      reason: PARK.reason,
      notified: {
        at: "2026-11-03T07:10:00.000Z",
        outcome: "suppressed",
        workspace: "/srv/work/web/pr-456",
      },
    });
    expect(line.needs[0]?.decisions[0]?.question).toBe(
      "Should the retry cover 4xx responses too?",
    );
  });

  it("lists every pull request waiting on a person with its cause, its question and since when, the first send dating it", () => {
    const stop: Action = {
      stage: "notify",
      target: "PR #457",
      record: "forge",
      reason: "its drive stopped 7, which only a person settles",
      evidence: { exit: 7 },
      cause: "needs-person",
      notice: { key: "stop-key", text: "t" },
    };
    const question = "which version does this merge ship in?";
    const followup: Action = {
      stage: "notify",
      target: "PR #458",
      record: "forge",
      reason: `failed follow-up: on a question for a person: ${question}`,
      evidence: { question },
      cause: "followup-failed",
      notice: { key: "followup-key", text: "t" },
    };
    const line = buildLine(
      input({
        reports: [report({ actions: [stop, followup] })],
        stored: () => ({
          ...NOTHING_STORED,
          notified: new Map([
            ["stop-key", "2026-11-02T09:00:00.000Z"],
            ["followup-key", "2026-11-03T10:00:00.000Z"],
          ]),
        }),
      }),
    );
    expect(
      line.needs.map((n) => [n.target, n.cause, n.since, n.question]),
    ).toEqual([
      ["PR #457", "needs-person", "2026-11-02T09:00:00.000Z", null],
      ["PR #458", "followup-failed", "2026-11-03T10:00:00.000Z", question],
    ]);
  });

  it("leaves a waiting or drifting cause to its session, and dates a stalled pickup by its idle clock", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [
              {
                stage: "notify",
                target: "API-77",
                record: "tracker",
                reason: "stalled pickup",
                evidence: {
                  title: "Add the audit export",
                  idleSince: "2026-11-03T12:25:00.000Z",
                },
                cause: "stalled",
                notice: { key: "k", text: "t" },
              },
              {
                stage: "notify",
                target: "PR #456",
                record: "runtime",
                reason: "drifting: flat",
                evidence: { record: "20261103T153000Z-aaaaaaaa" },
                cause: "drifting",
                notice: { key: "d", text: "t" },
              },
            ],
          }),
        ],
        records: [record()],
      }),
    );
    expect(line.needs.map((n) => n.cause)).toEqual(["stalled"]);
    expect(line.needs[0]).toMatchObject({
      item: "API-77",
      pr: null,
      url: null,
      title: "Add the audit export",
      since: "2026-11-03T12:25:00.000Z",
    });
    expect(line.sessions[0]?.drifting).toBe("drifting: flat");
  });

  it("reports an assigner who cannot write as a need and as a target that will not start", () => {
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
      }),
    );
    expect(line.needs.map((n) => n.cause)).toEqual(["assigner-cannot-write"]);
    expect(line.needs[0]?.url).toBeNull();
    expect(line.queue).toHaveLength(1);
    expect(line.queue[0]).toMatchObject({
      source: "assigned",
      group: "never",
      item: "#231",
    });
  });

  it("keeps the first sighting of a refusal that carries on from tick to tick", () => {
    const refusing = report({
      unplaced: [
        {
          target: "#231",
          record: "tracker",
          reason: "assigned by someone who cannot write",
          cause: "assigner-cannot-write",
        },
      ],
    });
    const first = buildLine(
      input({ reports: [refusing], finishedAt: "2026-11-03T08:00:00.000Z" }),
    );
    const later = buildLine(
      input({ reports: [refusing], previousNeeds: first.needs }),
    );
    expect(later.needs[0]?.since).toBe("2026-11-03T08:00:00.000Z");
    expect(buildLine(input({ reports: [refusing] })).needs[0]?.since).toBe(NOW);
  });

  it("orders the queue by what will happen, and leaves out what started", () => {
    const rearm = (target: string, fields: Partial<Action> = {}): Action => ({
      stage: "rearm",
      target,
      record: "forge",
      reason: `${target} wants a re-arm`,
      evidence: {},
      ...fields,
    });
    const launch = (
      target: string,
      outcome: RepoReport["launches"][number]["outcome"],
    ): RepoReport["launches"][number] => ({
      target,
      action: "rearm",
      outcome,
      account: null,
      record: null,
      detail: `${target} ${outcome}`,
    });
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [
              rearm("PR #1", {
                redrive: { cause: "conflicting", change: "head" },
              }),
              rearm("PR #2"),
              rearm("PR #3"),
              rearm("PR #4"),
              {
                stage: "pickup",
                target: "WEB-412",
                record: "tracker",
                reason: "assigned",
                evidence: {
                  title: "Paginate the audit list",
                  url: "https://tracker.example/WEB-412",
                  assignedBy: "maintainer-a",
                },
              },
              {
                stage: "followup",
                target: "PR #5",
                record: "forge",
                reason: "merged with no marker",
                evidence: {},
              },
            ],
            launches: [
              launch("PR #1", "waits"),
              launch("PR #2", "launched"),
              launch("PR #3", "refused"),
              { ...launch("WEB-412", "reported"), action: "pickup" },
              { ...launch("PR #5", "reported"), action: "followup" },
            ],
            labels: {
              prefix: "jig:",
              onlyLabeled: false,
              unlabeled: 0,
              states: [],
              commands: [{ target: "PR #4", command: "drive", note: "" }],
              held: [{ target: "PR #6", stage: "rearm", reason: "hold label" }],
              writes: [],
            },
            serialized: {
              catalog: "c",
              areas: ["migrations"],
              groups: [],
              held: [{ target: "PR #7", stage: "rearm", reason: "held" }],
            },
          }),
        ],
        stored: () => ({
          ...NOTHING_STORED,
          holds: [
            {
              pr: 7,
              area: "migrations",
              leader: 3,
              since: "2026-11-03T15:00:00.000Z",
            },
          ],
        }),
      }),
    );
    const byTarget = new Map(line.queue.map((q) => [q.target, q]));
    expect(byTarget.has("PR #2")).toBe(false);
    expect(byTarget.get("PR #1")).toMatchObject({
      source: "re-armable",
      group: "starts",
      stale: true,
      launch: { outcome: "waits" },
    });
    expect(byTarget.get("PR #3")).toMatchObject({ group: "never" });
    expect(byTarget.get("PR #4")).toMatchObject({
      source: "label drive",
      group: "starts",
      launch: null,
    });
    expect(byTarget.get("WEB-412")).toMatchObject({
      source: "assigned",
      group: "reported",
      assignedBy: "maintainer-a",
      url: "https://tracker.example/WEB-412",
      title: "Paginate the audit list",
    });
    expect(byTarget.get("PR #5")).toMatchObject({
      source: "merged",
      group: "reported",
    });
    expect(byTarget.get("PR #6")).toMatchObject({ group: "held", hold: null });
    expect(byTarget.get("PR #7")).toMatchObject({
      group: "held",
      hold: {
        leader: 3,
        area: "migrations",
        since: "2026-11-03T15:00:00.000Z",
      },
    });
  });

  it("reads a holding session from its record and its drive's ledger, and leaves out a record that holds nothing", () => {
    const ended = record(
      { id: "20261103T100000Z-bbbbbbbb", pr: 9 },
      {
        kind: "ended",
        exit: { at: NOW, code: 0, signal: null },
        process: null,
      },
    );
    const line = buildLine(
      input({
        inputs: reads({
          drives: [
            {
              ...parkedPr(),
              class: "driven",
              evidence: {
                round: 3,
                heartbeat: "2026-11-03T16:40:00.000Z",
                url: parkedPr().url,
              },
            },
          ],
        }),
        records: [
          record({
            samples: [{ round: 3, threads: 5, at: NOW }],
          }),
          ended,
        ],
      }),
    );
    expect(line.sessions).toHaveLength(1);
    expect(line.sessions[0]).toMatchObject({
      account: "work-a",
      target: "PR #456",
      title: "Retry the webhook on a 5xx",
      launch: "alive",
      launchReason: null,
      agent: null,
      round: 3,
      heartbeat: "2026-11-03T16:40:00.000Z",
      passTimeoutSec: 5400,
      workspace: "/srv/work/web/pr-456",
      samples: [{ round: 3, threads: 5 }],
    });
  });

  it("joins an interactive session to its agent, its wall and the nudge that answered it", () => {
    const line = buildLine(
      input({
        inputs: reads({
          sessions: {
            ok: true,
            source: "fake",
            workspaces: [
              {
                id: "w",
                path: "/srv/work/web/web-412",
                branch: "web-412",
                items: ["WEB-412"],
                prs: [],
                agents: [
                  {
                    id: "agent-1",
                    state: "waiting",
                    agentType: "claude",
                    since: Date.parse("2026-11-03T15:22:00.000Z"),
                  },
                ],
                unverifiableTerminals: 0,
                comment: "",
                unread: false,
                name: "",
              },
            ],
          },
        }),
        stored: () => ({
          ...NOTHING_STORED,
          nudges: [
            {
              record: "20261103T153000Z-aaaaaaaa",
              episode: "2026-11-03T15:20:00.000Z",
              at: "2026-11-03T16:15:00.000Z",
              delivery: "delivered",
              detail: "sent",
            },
          ],
        }),
        records: [
          record({
            action: "pickup",
            pr: null,
            item: "WEB-412",
            agentId: "agent-1",
            episodes: [
              {
                observedAt: "2026-11-03T15:20:00.000Z",
                resetAt: "2026-11-03T16:10:00.000Z",
                evidence: "usage limit reached",
                last: true,
                readAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    expect(line.sessions[0]).toMatchObject({
      target: "WEB-412",
      url: null,
      agent: { state: "waiting", since: "2026-11-03T15:22:00.000Z" },
      episode: { resetAt: "2026-11-03T16:10:00.000Z", last: true },
      nudge: { at: "2026-11-03T16:15:00.000Z", delivery: "delivered" },
    });
  });

  it("states a repository's failed reads and refusal, and what its tracker read said", () => {
    const line = buildLine(
      input({
        reports: [
          report({
            records: [
              {
                record: "tracker",
                source: "dispatch.identity",
                ok: true,
                detail: "no dispatch.identity: this repository has no pickups",
              },
              {
                record: "forge",
                source: "gh",
                ok: false,
                detail: "the pull requests cannot be read",
              },
            ],
          }),
          report({
            path: "/srv/gone",
            slug: null,
            refused: "the forge cannot say which repository this is",
          }),
        ],
      }),
    );
    expect(line.repos).toEqual([
      {
        slug: REPO,
        path: PATH,
        stages: ["rearm", "notify"],
        refused: null,
        failedReads: [
          {
            record: "forge",
            source: "gh",
            detail: "the pull requests cannot be read",
          },
        ],
        notes: ["no dispatch.identity: this repository has no pickups"],
      },
      {
        slug: null,
        path: "/srv/gone",
        stages: [],
        refused: "the forge cannot say which repository this is",
        failedReads: [],
        notes: [],
      },
    ]);
  });

  it("carries the recent ticks' durations, and reads the longest of a bounded number of them", () => {
    const accounts: LineAccount[] = [];
    const line = buildLine(
      input({ accounts, recentTicksMs: [90_000, 30_000] }),
    );
    // This tick took 60 s.
    expect(line.recentTicksMs).toEqual([90_000, 30_000, 60_000]);
    expect(line.longestTickMs).toBe(90_000);
    const long = buildLine(
      input({ recentTicksMs: Array.from({ length: 400 }, () => 1000) }),
    );
    expect(long.recentTicksMs).toHaveLength(288);
  });
});
