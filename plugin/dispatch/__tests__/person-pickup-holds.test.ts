import { expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { personPickupBlock } from "../lib/person-pickup-holds.ts";
import type { LaunchRecord } from "../lib/launches.ts";
import { pool } from "../lib/pool.ts";
import { batchPickups } from "../lib/queue-batch.ts";
import { readTracker } from "../lib/tick-tracker.ts";
import type { Action, DispatchSection } from "../lib/types.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  REPO,
  type SendWorld,
  sendWorld,
} from "../../send/__tests__/send-fixtures.ts";
import {
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { issue as jiraIssue } from "../../skills/do-item/__tests__/jira-fixtures.ts";
import { report } from "./line-fixtures.ts";
import { issue } from "./served-fixtures.ts";

const PAGE = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

function wireAnswers(adapter: string, key: string): Record<string, unknown> {
  const identity = { id: "operator", name: "operator" };
  switch (adapter) {
    case "github":
      return {
        TrackerViewer: {
          data: { viewer: { id: "operator", login: "operator" } },
        },
        TrackerIssue: {
          data: oneIssue(
            issueNode({
              number: 1,
              repo: REPO,
              assignee: "alex",
              extra: { subIssues: PAGE },
            }),
          ),
        },
      };
    case "linear":
      return {
        TrackerViewer: { data: { viewer: identity } },
        TrackerPoolIssue: {
          data: {
            issue: {
              identifier: key,
              title: "held issue",
              url: null,
              labels: PAGE,
              children: PAGE,
              priority: 2,
              createdAt: "2026-01-01T00:00:00.000Z",
              state: { id: "todo", name: "Todo", type: "unstarted" },
              assignee: { id: "alex", name: "alex" },
            },
          },
        },
      };
    default:
      return {
        "GET /rest/api/3/myself": {
          accountId: identity.id,
          displayName: identity.name,
          timeZone: "UTC",
        },
        [`GET /rest/api/3/issue/${key}`]: jiraIssue({ key }),
        "GET /rest/api/3/field": [],
        "POST /rest/api/3/search/jql": { issues: [], isLast: true },
      };
  }
}

/** Keep the real CLI and adapter transport in the child; only their HTTP answers are simulated. */
function wire(w: SendWorld, adapter: string, key: string) {
  const answers = wireAnswers(adapter, key);
  const calls = join(w.root, "tracker-calls");
  const preload = join(w.root, "tracker-fixture.ts");
  Object.assign(w.env, {
    JIG_GITHUB_GRAPHQL_URL: "http://127.0.0.1/graphql",
    LINEAR_API_KEY: "fake-token",
    JIRA_EMAIL: "operator@example.com",
    JIRA_API_TOKEN: "fake-token",
    JIRA_BEARER_TOKEN: "",
    JIRA_TOKEN_COMMAND: "",
  });
  writeFileSync(
    preload,
    `
import { appendFileSync } from "node:fs";
const answers = ${JSON.stringify(answers)};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const route = url.pathname.endsWith("/graphql")
    ? /query\\s+(\\w+)/.exec((await request.json()).query)?.[1]
    : request.method + " " + url.pathname;
  appendFileSync(${JSON.stringify(calls)}, route + "\\n");
  return route in answers
    ? Response.json(answers[route])
    : new Response("unexpected request " + route, { status: 503 });
};
`,
  );
  return {
    send: (verb: string) =>
      w.jig(
        ["send", `pickup@${REPO}#${key.replace(/^#/, "")}`, verb],
        w.repo,
        preload,
      ),
    calls: () => readFileSync(calls, "utf8").trim().split("\n"),
  };
}

it.each([
  ["github", "#", {}],
  ["linear", "ENG-", { team: "ENG" }],
  [
    "jira",
    "ENG-",
    { team: "ENG", jira: { site: "https://example.atlassian.net" } },
  ],
] as const)(
  "keeps a local hold out of the %s pickup queue and releases it back to its batch",
  async (adapter, prefix, settings) => {
    const w = sendWorld();
    const root = w.state;
    try {
      writeFileSync(
        join(w.repo, "label-taxonomy.yaml"),
        `version: 1
types:
  - id: task
statuses:
  - id: todo
groups:
  - id: size
    required: true
    labels:
      - id: small
`,
      );
      const key = (n: number) => `${prefix}${n}`;
      mkdirSync(join(w.home, ".jig"), { recursive: true });
      writeFileSync(
        join(w.home, ".jig", "dispatch.yaml"),
        `repositories:\n  - path: ${w.repo}\n    stages: [pickup]\n`,
      );
      w.config(`issue_tracker:
  adapter: ${adapter}
  ${adapter === "github" ? "" : "team: ENG"}
  ${adapter === "jira" ? "jira: { site: https://example.atlassian.net }" : ""}
  facets:
    type: { store: label }
    ${adapter === "github" ? "priority: { store: label }" : ""}
    size: { store: label }
`);
      const cli = wire(w, adapter, key(1));
      const rows = [1, 2, 3].map((n) => issue(key(n), ["area:tools"]));
      const tracker = {
        adapter,
        team: adapter === "github" ? REPO : "ENG",
        stateName: (state: string) => (state === "todo" ? "Todo" : state),
        assignUnassigned: async () => ({ assigned: true }),
        assignedIssues: async (_: string, states: string[]) =>
          states.includes("in_progress") ? [] : rows,
        assignedBy: async () => ({
          id: "writer",
          name: "writer",
          trusted: true,
        }),
        openChildren: async () => [],
        listRelations: async () => [],
        poolIssue: async (k: string) =>
          rows.find((r) => r.identifier === k) ?? null,
        getIssue: async (k: string) => ({
          identifier: k,
          description: "",
          parent: null,
        }),
      } as unknown as Tracker;
      const values = {
        issue_tracker: {
          adapter,
          ...settings,
          facets: { size: { store: "label" } },
        },
        do_item: { agents: { codearea_areas: { "area:tools": "tools" } } },
      };
      const section = { identity: null } as DispatchSection;
      const tick = async () => {
        const view = report();
        const tracked = await readTracker(
          {
            values,
            root,
            repo: { path: w.repo, slug: REPO, defaultBranch: "main" },
            section,
            report: view,
            where: "test",
            people: [
              { name: "Alex", forge: ["alex"], tracker: { [adapter]: "alex" } },
            ],
            serveDefaults: undefined,
            nowMs: 1,
            headroom: true,
            records: [],
            preparedTracker: tracker,
          },
          undefined,
          { budget: async () => ({}) as never, pool: pool(2) },
        );
        const actions = tracked.pickups.map(
          (row): Action => ({
            stage: "pickup",
            target: row.key,
            record: "tracker",
            reason: "ready",
            evidence: { servedPerson: row.servedPerson ?? "" },
          }),
        );
        const batches = batchPickups(actions, tracked.pickups, values, w.repo);
        return { view, batches };
      };
      expectSpawnExit(await cli.send("hold"), 0);
      const held = await tick();
      expect(held.view.unplaced).toContainEqual(
        expect.objectContaining({
          target: key(1),
          pickupHold: { by: "operator", at: expect.any(String) },
        }),
      );
      expect(held.batches).toHaveLength(1);
      expect(JSON.parse(String(held.batches[0]?.evidence.batchItems))).toEqual([
        { key: key(2), person: "alex" },
        { key: key(3), person: "alex" },
      ]);
      expect(
        personPickupBlock(
          {
            action: "pickup",
            repo: REPO,
            item: key(2),
            batchItems: [{ key: key(1), person: "alex" }],
          } as LaunchRecord,
          root,
        ),
      ).toContain(`${key(1)} is held by operator`);
      expectSpawnExit(await cli.send("release"), 0);
      const calls = cli.calls();
      const perCommand =
        adapter === "github"
          ? ["TrackerViewer", "TrackerIssue"]
          : adapter === "linear"
            ? ["TrackerViewer", "TrackerPoolIssue"]
            : [
                "GET /rest/api/3/myself",
                "GET /rest/api/3/myself",
                `GET /rest/api/3/issue/${key(1)}`,
                "POST /rest/api/3/search/jql",
              ];
      expect(calls).toEqual([...perCommand, ...perCommand]);
      expect(w.writes()).toEqual([]);
      const released = await tick();
      expect(released.view.unplaced).toEqual([]);
      expect(released.batches).toHaveLength(1);
      expect(
        JSON.parse(String(released.batches[0]?.evidence.batchItems)),
      ).toEqual([
        { key: key(1), person: "alex" },
        { key: key(2), person: "alex" },
        { key: key(3), person: "alex" },
      ]);
    } finally {
      w.close();
    }
  },
);
