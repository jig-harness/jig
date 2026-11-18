/**
 * `jig send pickup@… answer <key> --approve|--choose` to a pickup's
 * decision on an item of a tracker other than the forge: written through
 * the tracker as the comment a person could type there, as the user the
 * tracker's credential acts as here, with the record the tick counts it by where that
 * user may be the one its own credential acts as; refused, with why, by a
 * tracker that cannot name who wrote a comment, to the repository's factory
 * identity from another host, and where no record the tick counts can be
 * written.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LineNeed,
  LineSnapshot,
} from "../../dispatch/lib/dashboard-contract.ts";
import {
  stationContextOf,
  stationDecision,
} from "../../dispatch/lib/line-station.ts";
import { writeLine } from "../../dispatch/lib/line-store.ts";
import { closeStateDb } from "../../dispatch/lib/state.ts";
import {
  countsAsSent,
  settleStationAnswers,
  type StationPorts,
} from "../../dispatch/lib/station-answers.ts";
import { readTrackerAnswers } from "../../dispatch/lib/tracker-answers.ts";
import type { Action } from "../../dispatch/lib/types.ts";
import { report as reportOf } from "../../dispatch/__tests__/line-fixtures.ts";
import { reading } from "../../ask/lib/reading.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { answerComment } from "../../shared/decisions/answer-record.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type {
  Tracker,
  TrackerUser,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { planTrackerAnswer } from "../lib/answer-tracker.ts";
import {
  REPO as REPO_OF_WORLD,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";
import type { AnswerRequest } from "../lib/answer-request.ts";

const REPO = "example-org/web";
const DANA: TrackerUser = { id: "u-dana", name: "Dana Lee" };
const FACTORY: TrackerUser = { id: "u-factory", name: "Jig Factory" };

let roots: string[] = [];
let world: SendWorld | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
  world?.close();
  world = null;
  for (const root of roots) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

const STALLED: Action & { cause: "stalled" } = {
  stage: "notify",
  target: "ENG-12",
  record: "tracker",
  reason: "stalled pickup",
  cause: "stalled",
  evidence: { state: "In Progress" },
};

function need(): LineNeed {
  const decision = stationDecision(
    STALLED,
    stationContextOf(REPO, {
      tracker: { adapter: "linear" },
      links: { itemsOf: () => null, prsOf: () => [] },
    }),
  );
  if (decision === null) throw new TypeError("the fixture frames no decision");
  return {
    cause: "stalled",
    stage: "pickup",
    repo: REPO,
    target: "ENG-12",
    pr: null,
    item: "ENG-12",
    url: "https://linear.app/acme/issue/ENG-12",
    title: null,
    since: "2026-11-12T10:00:00.000Z",
    reason: STALLED.reason,
    decisions: [decision],
    notified: null,
    workspaces: [],
  };
}

const NEED = need();
const DIGEST = NEED.decisions[0]?.digest ?? "";

/** A line holding `needs`, as a tick writes it. */
function line(needs: LineNeed[]): LineSnapshot {
  return {
    version: 1,
    runId: "2026-11-12T10-00-00-000Z-1-aaaaaaaa",
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:01:00.000Z",
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    intervalMs: 300_000,
    longestTickMs: 60_000,
    plugin: "1.2.3",
    accounts: [],
    lastAccount: null,
    sessions: [],
    needs,
    queue: [],
    ready: [],
    repos: [],
  } as unknown as LineSnapshot;
}

/** A context whose machine's newest line holds the stalled pickup's need. */
function context(): AskContext {
  const root = mkdtempSync(join(tmpdir(), "send-tracker-answer-"));
  roots.push(root);
  writeLine(line([NEED]), "{}", root);
  return {
    reading: reading(),
    address: { station: "pickup", repo: REPO, key: "ENG-12" },
    name: `pickup@${REPO}#ENG-12`,
    thread: false,
    window: { since: null, all: false },
    login: null,
    dispatcher: root,
    host: null,
    checkout: null,
    dispatches: false,
    labelPrefix: null,
  };
}

/** A Linear-like tracker whose credential acts as `viewer`, recording each comment posted. */
function tracker(
  viewer: TrackerUser,
  fields: Partial<Tracker> = {},
): Tracker & { posted: Array<[string, string]> } {
  const posted: Array<[string, string]> = [];
  return {
    adapter: "linear",
    commentAuthors: true,
    viewer: async () => viewer,
    user: async (identity: string) =>
      identity === "factory@example.com" ? FACTORY : DANA,
    postComment: async (issue: string, body: string) => {
      posted.push([issue, body]);
    },
    posted,
    ...fields,
  } as unknown as Tracker & { posted: Array<[string, string]> };
}

const approve = (decision?: string): Extract<AnswerRequest, { all: false }> =>
  ({
    all: false,
    key: "pickup",
    form: { kind: "approve" },
    ...(decision === undefined ? {} : { decision }),
  }) as Extract<AnswerRequest, { all: false }>;

const plan = (
  t: Tracker,
  request = approve(DIGEST),
  options: {
    as?: string;
    dryRun?: boolean;
    identity?: string | null;
    owner?: Outcome<boolean, "unreadable">;
  } = {},
) =>
  planTrackerAnswer(context(), request, {
    as: options.as,
    dryRun: options.dryRun ?? false,
    open: () =>
      ok({
        tracker: t,
        identity:
          options.identity === undefined
            ? "factory@example.com"
            : options.identity,
        owner: options.owner ?? ok(false),
      }),
  });

describe("jig send … answer on an item of another tracker", () => {
  it("writes the answer line on the item through the tracker, as the tracker's user here", async () => {
    const t = tracker(DANA);
    const planned = await plan(t);
    if (planned === null || !planned.ok)
      throw new TypeError(`not planned: ${JSON.stringify(planned)}`);
    expect(planned.value.writesAs).toBe(
      "Dana Lee, the user the tracker's credential acts as here",
    );
    expect(planned.value.record).toContain(
      `a comment on ENG-12 on the linear tracker: "answer pickup: approve [${DIGEST}]"`,
    );
    expect(t.posted).toEqual([]);
    const wrote = await planned.value.write();
    expect(wrote).toEqual({
      ok: true,
      value: "https://linear.app/acme/issue/ENG-12",
    });
    expect(t.posted).toHaveLength(1);
    const [item, body] = t.posted[0] ?? [];
    expect(item).toBe("ENG-12");
    expect(body?.split("\n")[0]).toBe(`answer pickup: approve [${DIGEST}]`);
    expect(body).toContain("jig-send-answer");
  });

  it("refuses when the factory identity cannot be looked up", async () => {
    const t = tracker(DANA, {
      user: async () => {
        throw new Error("lookup down");
      },
    } as Partial<Tracker>);
    const planned = await plan(t);
    expect(planned?.ok).toBe(false);
    expect(JSON.stringify(planned)).toContain("could not be looked up");
    expect(t.posted).toEqual([]);
  });

  it("prints the command to send on a dry run and refuses a real send that names no digest", async () => {
    const dry = await plan(tracker(DANA), approve(), { dryRun: true });
    expect(dry?.ok && dry.value.detail).toContainEqual([
      "send",
      `jig send pickup@${REPO}#ENG-12 answer pickup --approve --decision ${DIGEST}`,
    ]);
    const bare = await plan(tracker(DANA), approve());
    expect(bare?.ok).toBe(false);
  });

  it("refuses, writing nothing, a tracker that cannot name who wrote a comment, the factory identity and another --as", async () => {
    const cases: Array<[Tracker & { posted: unknown[] }, string, string?]> = [
      [
        tracker(DANA, { commentAuthors: false }),
        "ENG-12 is an item of the linear tracker, which does not name who wrote each comment, so the tick cannot count an answer there",
      ],
      [
        tracker(FACTORY),
        "the factory identity factory@example.com, whose comments the tick never counts as an answer",
      ],
      [tracker(DANA), "--as sam: this machine is signed in as Dana Lee", "sam"],
    ];
    for (const [t, says, as] of cases) {
      const planned = await plan(t, approve(DIGEST), {
        ...(as === undefined ? {} : { as }),
      });
      expect(planned?.ok).toBe(false);
      expect(
        planned !== null && !planned.ok ? planned.failure.reason : "",
      ).toContain(says);
      expect(t.posted).toEqual([]);
    }
  });

  it("posts from the host that owns the repository, with the record its tick counts the answer by", async () => {
    for (const identity of [null, "factory@example.com"]) {
      const t = tracker(DANA);
      const planned = await plan(t, approve(DIGEST), {
        identity,
        owner: ok(true),
      });
      if (planned === null || !planned.ok)
        throw new TypeError(`not planned: ${JSON.stringify(planned)}`);
      expect(planned.value.notice).toContain(
        `this machine owns ${REPO}, so its tick reads the answers with the tracker credential a send here uses, which acts as Dana Lee; it counts this answer by the record the comment carries`,
      );
      expect(planned.value.record).toContain("the option chosen in a marker");
      expect(t.posted).toEqual([]);
      await planned.value.write();
      const body = t.posted[0]?.[1] ?? "";
      expect(body).toStartWith(
        `answer pickup: approve [${DIGEST}]\n\n<!-- jig-send-answer\n`,
      );

      const root = mkdtempSync(join(tmpdir(), "send-tracker-tick-"));
      roots.push(root);
      const released: string[] = [];
      const reader = {
        adapter: "linear",
        commentAuthors: true,
        issueComments: async () => ({
          uuid: "uuid-12",
          comments: [
            {
              id: "c1",
              body,
              createdAt: "2026-11-12T11:00:00.000Z",
              trusted: true,
              author: DANA,
            },
          ],
        }),
      } as unknown as Tracker;
      const report = reportOf({ actions: [{ ...STALLED }] });
      await settleStationAnswers(
        REPO,
        report,
        stationContextOf(REPO, {
          tracker: { adapter: "linear" },
          links: { itemsOf: () => null, prsOf: () => [] },
        }),
        {
          self: null,
          issueRepository: null,
          trackerComments: (item: string) =>
            readTrackerAnswers(reader, item, async () => DANA),
          releasePickup: async (item: string) => {
            released.push(item);
            return ok("released");
          },
        } as unknown as StationPorts,
        root,
      );
      expect(released).toEqual(["ENG-12"]);
    }
  });

  it("writes nothing on a dry run from the host that owns the repository", async () => {
    const t = tracker(DANA);
    const planned = await plan(t, approve(DIGEST), {
      owner: ok(true),
      dryRun: true,
    });
    expect(planned?.ok).toBe(true);
    expect(t.posted).toEqual([]);
  });

  it("refuses, writing nothing, where the tick could not count the answer: no record can name the user, or the user does not read", async () => {
    const cases: Array<[Tracker & { posted: unknown[] }, string]> = [
      [
        tracker({ id: "u-nameless", name: "" }),
        "would not read this answer as choosing Release the claim",
      ],
      [
        tracker(DANA, {
          viewer: async () => {
            throw new Error("viewer down");
          },
        } as Partial<Tracker>),
        "the user the tracker's credential acts as did not read",
      ],
    ];
    for (const [t, says] of cases) {
      const planned = await plan(t, approve(DIGEST), { owner: ok(true) });
      expect(planned?.ok).toBe(false);
      expect(
        planned !== null && !planned.ok ? planned.failure.reason : "",
      ).toContain(says);
      expect(t.posted).toEqual([]);
    }
  });

  it("takes a comment for a sent answer only when its record names that user and the option chosen", () => {
    const decision = NEED.decisions[0];
    if (decision === undefined) throw new TypeError("no decision");
    const line = `answer pickup: approve [${DIGEST}]`;
    const body = answerComment(
      "pickup",
      `approve [${DIGEST}]`,
      null,
      { login: "Dana Lee", host: "sha256:0123456789abcdef" },
      "2026-11-12T11:00:00.000Z",
      {
        decision: DIGEST,
        choice: { option: "Release the claim", form: "approve" },
      },
    );
    const counted = (text: string, login: string, option: string) =>
      countsAsSent(decision, text, login, option);
    expect(counted(body, "Dana Lee", "Release the claim")).toBe(true);
    expect(counted(body, "Sam Ortiz", "Release the claim")).toBe(false);
    expect(counted(body, "Dana Lee", "Another option")).toBe(false);
    expect(counted(line, "Dana Lee", "Release the claim")).toBe(false);
  });

  it("posts when whether this machine owns the repository cannot be told, saying how the tick counts it", async () => {
    const t = tracker(DANA);
    const planned = await plan(t, approve(DIGEST), {
      owner: failed(
        "unreadable",
        "the git remote of /src/web names no repository",
      ),
    });
    if (planned === null || !planned.ok)
      throw new TypeError(`not planned: ${JSON.stringify(planned)}`);
    expect(planned.value.notice).toContain(
      `whether this machine owns ${REPO}, and so reads its answers with the tracker credential a send here uses (which acts as Dana Lee), cannot be told: the git remote of /src/web names no repository`,
    );
    await planned.value.write();
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]?.[1]).toContain("<!-- jig-send-answer");
  });

  it("posts, from a host that does not own the repository, a writer other than the factory identity", async () => {
    const t = tracker(DANA);
    const planned = await plan(t, approve(DIGEST));
    if (planned === null || !planned.ok)
      throw new TypeError(`not planned: ${JSON.stringify(planned)}`);
    expect(planned.value.notice).not.toContain("cannot be told here");
    await planned.value.write();
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]?.[1]).toContain("<!-- jig-send-answer");
  });

  it("posts from a host that does not own a repository naming no factory identity, saying how the tick counts it", async () => {
    const t = tracker(DANA);
    const planned = await plan(t, approve(DIGEST), { identity: null });
    if (planned === null || !planned.ok)
      throw new TypeError(`not planned: ${JSON.stringify(planned)}`);
    expect(planned.value.notice).toContain(
      "the repository names no factory identity (dispatch.identity), so whether Dana Lee is the user the tick's own tracker credential acts as on the host that owns the repository cannot be told here",
    );
    await planned.value.write();
    expect(t.posted).toHaveLength(1);
  });

  it("leaves a decision answered on the forge to the forge's reader", async () => {
    const forge = {
      ...NEED,
      decisions: NEED.decisions.map((d) =>
        d.answer === undefined
          ? d
          : { ...d, answer: { ...d.answer, on: "issue" as const } },
      ),
    };
    const ctx = context();
    writeLine(line([forge]), "{}", ctx.dispatcher ?? "");
    const planned = await planTrackerAnswer(ctx, approve(DIGEST), {
      as: undefined,
      dryRun: false,
      open: () =>
        ok({ tracker: tracker(DANA), identity: null, owner: ok(false) }),
    });
    expect(planned).toBeNull();
  });
});

describe("jig send … answer on another tracker's item, from the command line", () => {
  /** A send world whose checkout's tracker is served by a fake GraphQL endpoint; `ops` logs each operation. */
  function trackerWorld() {
    const w = sendWorld();
    world = w;
    const ops: Array<{ op: string; variables: Record<string, unknown> }> = [];
    const stalled = { ...STALLED, target: "#14" };
    const decision = stationDecision(
      stalled,
      stationContextOf(REPO_OF_WORLD, {
        tracker: { adapter: "linear" },
        links: { itemsOf: () => null, prsOf: () => [] },
      }),
    );
    if (decision === null) throw new TypeError("no decision framed");
    writeLine(
      line([
        {
          ...NEED,
          repo: REPO_OF_WORLD,
          target: "#14",
          item: "#14",
          url: null,
          decisions: [decision],
        },
      ]),
      "{}",
      w.state,
    );
    // The default branch names the tracker and factory identity; the checkout's own copy names neither.
    w.config(
      `dispatch:\n  identity: factory-bot\nissue_tracker:\n  adapter: github\n  github:\n    repository: ${REPO_OF_WORLD}\n  facets:\n    type: { store: label }\n    priority: { store: label }\n`,
    );
    mkdirSync(join(w.repo, ".config"), { recursive: true });
    writeFileSync(
      join(w.repo, ".config", "jig.yaml"),
      `issue_tracker:\n  adapter: github\n  github:\n    repository: other/elsewhere\n`,
    );
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { query, variables } = (await request.json()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
        ops.push({ op, variables });
        const answers: Record<string, unknown> = {
          TrackerViewer: {
            viewer: { id: "U_maintainer", login: "maintainer" },
          },
          TrackerUser: { user: { id: "U_factory-bot", login: "factory-bot" } },
          TrackerIssue: oneIssue(
            issueNode({
              number: 14,
              repo: REPO_OF_WORLD,
              extra: {
                subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
              },
            }),
          ),
          TrackerComment: { addComment: { clientMutationId: null } },
        };
        return Response.json(
          op in answers
            ? { data: answers[op] }
            : { errors: [{ message: `unhandled ${op}` }] },
        );
      },
    });
    w.env.JIG_GITHUB_GRAPHQL_URL = `http://127.0.0.1:${server.port}/graphql`;
    return { w, ops, digest: decision.digest ?? "" };
  }

  it("posts the answer with its record on the host that owns the repository", async () => {
    const { w, ops, digest } = trackerWorld();
    mkdirSync(join(w.home, ".jig"), { recursive: true });
    writeFileSync(
      join(w.home, ".jig", "dispatch.yaml"),
      `repositories:\n  - path: ${w.repo}\n    stages: [pickup]\n`,
    );
    const address = `pickup@${REPO_OF_WORLD}#14`;
    const dry = await w.send([
      address,
      "answer",
      "pickup",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(dry, 0);
    expect(dry.stdout.replace(/\s+/g, " ")).toContain(
      "so its tick reads the answers with the tracker credential a send here uses, which acts as maintainer",
    );
    expect(ops.some((o) => o.op === "TrackerComment")).toBe(false);
    const sent = await w.send([
      address,
      "answer",
      "pickup",
      "--approve",
      "--decision",
      digest,
    ]);
    expectSpawnExit(sent, 0);
    const bodies = ops
      .filter((o) => o.op === "TrackerComment")
      .map((o) => String(o.variables.body));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toStartWith(
      `answer pickup: approve [${digest}]\n\n<!-- jig-send-answer\n`,
    );
    expect(w.writes()).toEqual([]);
  });

  it("says the tick may not read it when an owned checkout's remote names no repository", async () => {
    const { w, ops } = trackerWorld();
    const bare = join(w.root, "no-remote");
    mkdirSync(bare, { recursive: true });
    mkdirSync(join(w.home, ".jig"), { recursive: true });
    writeFileSync(
      join(w.home, ".jig", "dispatch.yaml"),
      `repositories:\n  - path: ${bare}\n    stages: [pickup]\n`,
    );
    const r = await w.send([
      `pickup@${REPO_OF_WORLD}#14`,
      "answer",
      "pickup",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout.replace(/\s+/g, " ")).toContain(
      `the git remote of ${bare}, a checkout the dispatch file says this machine owns, names no repository`,
    );
    expect(ops.some((o) => o.op === "TrackerComment")).toBe(false);
  });

  it("posts the answer on the item through the tracker, and nothing on the forge", async () => {
    const { w, ops, digest } = trackerWorld();
    const address = `pickup@${REPO_OF_WORLD}#14`;
    const dry = await w.send([
      address,
      "answer",
      "pickup",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(dry, 0);
    expect(dry.stdout).toContain(
      "maintainer, the user the tracker's credential acts as here",
    );
    expect(ops.some((o) => o.op === "TrackerComment")).toBe(false);
    const sent = await w.send([
      address,
      "answer",
      "pickup",
      "--approve",
      "--decision",
      digest,
    ]);
    expectSpawnExit(sent, 0);
    const bodies = ops
      .filter((o) => o.op === "TrackerComment")
      .map((o) => String(o.variables.body));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.split("\n")[0]).toBe(
      `answer pickup: approve [${digest}]`,
    );
    expect(bodies[0]).toContain("jig-send-answer");
    expect(w.writes()).toEqual([]);
    // The default branch's tracker and factory identity are the ones asked, never the checkout's.
    const issueAsks = ops.filter((o) => o.op === "TrackerIssue");
    expect(issueAsks.length).toBeGreaterThan(0);
    for (const ask of issueAsks) {
      expect(`${ask.variables.owner}/${ask.variables.name}`).toBe(
        REPO_OF_WORLD,
      );
    }
    const userAsks = ops.filter((o) => o.op === "TrackerUser");
    expect(userAsks.length).toBeGreaterThan(0);
    for (const ask of userAsks) expect(ask.variables.login).toBe("factory-bot");
  });
});
