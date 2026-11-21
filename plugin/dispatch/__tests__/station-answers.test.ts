import { ok as assert } from "node:assert/strict";
/**
 * A person's answer to a need's decision: counted only from a trusted
 * author, the dispatcher's own identity only through the record `jig send`
 * writes, naming the decision's current digest, agreed by every person who
 * answered; its step runs once, refuses with why, and a step that starts a
 * session leaves that session the answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerComment } from "../../shared/decisions/answer-record.ts";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  adfToMarkdown,
  markdownToAdf,
} from "../../skills/do-item/scripts/lib/tracker/jira/adf.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import { parkAnswers } from "../../skills/drive-pr/scripts/lib/driver/park-answers.ts";
import { stationContextOf, stationDecision } from "../lib/line-station.ts";
import { closeStateDb } from "../lib/state.ts";
import {
  carried,
  claimAnswer,
  finishAnswer,
  type CarriedAnswer,
  takeCarried,
} from "../lib/station-answer-store.ts";
import type { LaunchRecord } from "../lib/launches.ts";
import { pickupPassArgv } from "../lib/session.ts";
import {
  settleStationAnswers,
  stationItem,
  type StationPorts,
} from "../lib/station-answers.ts";
import type { Action, DispatchSection, RepoReport } from "../lib/types.ts";
import type {
  CommentFact,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { DEFAULT_LABELS } from "../lib/labels.ts";
import type { SharedContext } from "../lib/shared-launches.ts";
import { stationPorts } from "../lib/station-ports.ts";
import { report as reportOf } from "./line-fixtures.ts";

const SLUG = "example-org/web";
const CONTEXT = stationContextOf(SLUG, { tracker: { adapter: "github" } });

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "station-answers-"));
  roots.push(dir);
  return dir;
}

function failedFollowup(): Action {
  return {
    stage: "notify",
    target: "PR #12",
    record: "forge",
    reason: "failed follow-up",
    cause: "followup-failed",
    evidence: { marker: 41, record: "20261112T101301Z-33c6fa5f" },
  };
}

const digestOf = (action: Action) =>
  stationDecision(action as Action & { cause: "followup-failed" }, CONTEXT)
    ?.digest ?? "";

let next = 1;
function said(
  body: string,
  author = "maintainer",
  association = "OWNER",
  at = "2026-11-12T11:00:00Z",
): CommentLike {
  next += 1;
  return {
    author,
    association,
    at,
    editedAt: null,
    url: `https://github.com/${SLUG}/pull/12#issuecomment-${next}`,
    body,
  };
}

const OTHER_DIGEST = "0123456789ab";

/** What a `jig send` comment's record may be made to say instead of what its line says. */
interface SentFields {
  login?: string;
  host?: string;
  key?: string;
  /** The digest the record names; `null` leaves it out. */
  decision?: string | null;
  option?: string;
  form?: "approve" | "choose";
}

/**
 * The comment `jig send` writes choosing `option` of decision `key`, its
 * line naming `digest`; `record` changes what its hidden record says.
 */
function sentAnswer(
  key: string,
  digest: string,
  option: string,
  record: SentFields = {},
): string {
  const decision = record.decision === undefined ? digest : record.decision;
  const body = answerComment(
    record.key ?? key,
    `choose ${record.option ?? option} [${decision ?? digest}]`,
    12,
    {
      login: record.login ?? "drive-bot",
      host: record.host ?? "sha256:0123456789abcdef",
    },
    "2026-11-12T11:00:00.000Z",
    {
      ...(decision === null ? {} : { decision }),
      choice: {
        option: record.option ?? option,
        form: record.form ?? "choose",
      },
    },
  );
  return `answer ${key}: choose ${option} [${digest}]${body.slice(body.indexOf("\n"))}`;
}

/** Ports that record each step and answer as told. */
function ports(
  comments: CommentLike[],
  answer: Outcome<string, "refused"> = ok("done it"),
): StationPorts & { steps: string[] } {
  const steps: string[] = [];
  const step =
    (name: string) =>
    async (...args: unknown[]) => {
      steps.push(`${name} ${args.join(" ")}`);
      return answer;
    };
  return {
    steps,
    self: "drive-bot",
    issueRepository: SLUG,
    comments: async () => ok(comments),
    trackerComments: async () =>
      failed("unreadable", "the tracker was read for a forge need"),
    rerunFollowup: step("rerun"),
    doneFollowup: step("done"),
    releasePickup: step("release"),
    detachCheckout: step("detach"),
    rearmDrive: step("rearm"),
    clearRecord: step("clear"),
  };
}

function settle(
  report: RepoReport,
  p: StationPorts,
  dir: string,
): Promise<void> {
  return settleStationAnswers(SLUG, report, CONTEXT, p, dir);
}

describe("settleStationAnswers", () => {
  it("runs the chosen option's step once, keeps how it went, and hands the next session the answer", async () => {
    const dir = root();
    const action = failedFollowup();
    const digest = digestOf(action);
    const comment = said(`answer followup: approve [${digest}]`);
    const p = ports([comment]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(report.actions[0]?.answered).toMatchObject({
      digest,
      answers: [{ author: "maintainer", choice: { option: "Run it again" } }],
      acted: { option: "Run it again", outcome: "done", detail: "done it" },
    });
    // The next tick reads the same answer: its step has run.
    const again = reportOf({ actions: [failedFollowup()] });
    await settle(again, p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(again.actions[0]?.answered?.acted?.outcome).toBe("done");
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toMatchObject({
      option: "Run it again",
      recommended: true,
      by: "maintainer",
      url: comment.url,
    });
    expect(takeCarried(SLUG, "PR #12", "r-2", dir)).toBeNull();
  });

  it("keeps the answer the next session is handed when the tick dies between the step's effect and its outcome", async () => {
    const dir = root();
    const action = failedFollowup();
    const comment = said(`answer followup: approve [${digestOf(action)}]`);
    const p = ports([comment]);
    p.rerunFollowup = async () => {
      throw new Error("the tick died after the marker was deleted");
    };
    await expect(
      settle(reportOf({ actions: [action] }), p, dir),
    ).rejects.toThrow("died");
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toMatchObject({
      option: "Run it again",
      url: comment.url,
    });
  });

  it("acts on no answer from the dispatcher's own login or an author the forge does not vouch for", async () => {
    const dir = root();
    const action = failedFollowup();
    const digest = digestOf(action);
    const p = ports([
      said(`answer followup: approve [${digest}]`, "drive-bot"),
      said(`answer followup: approve [${digest}]`, "passer-by", "NONE"),
    ]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual([]);
    expect(report.actions[0]?.answered?.answers).toEqual([]);
  });

  it("counts an answer `jig send` wrote as the dispatcher's own login, by the record it carries", async () => {
    const dir = root();
    const action = failedFollowup();
    const digest = digestOf(action);
    const p = ports([
      said(sentAnswer("followup", digest, "Run it again"), "Drive-Bot"),
    ]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(report.actions[0]?.answered).toMatchObject({
      answers: [{ author: "Drive-Bot", choice: { option: "Run it again" } }],
      acted: { author: "Drive-Bot", option: "Run it again", outcome: "done" },
    });
  });

  it("ignores the dispatcher's own comment whose record is not an answer to this decision by that login", async () => {
    const digest = digestOf(failedFollowup());
    const records: SentFields[] = [
      { key: "pickup" },
      { login: "maintainer" },
      { host: "dashboard (browser)" },
    ];
    for (const record of records) {
      const p = ports([
        said(
          sentAnswer("followup", digest, "Run it again", record),
          "drive-bot",
        ),
      ]);
      const report = reportOf({ actions: [failedFollowup()] });
      await settle(report, p, root());
      expect(p.steps).toEqual([]);
      expect(report.actions[0]?.answered?.answers).toEqual([]);
      expect(report.actions[0]?.answered?.state).toBeUndefined();
    }
  });

  it("leaves the dispatcher's own answer stale when its record names no digest, another, an earlier framing or another choice", async () => {
    const digest = digestOf(failedFollowup());
    const bodies = [
      sentAnswer("followup", digest, "Run it again", { decision: null }),
      sentAnswer("followup", digest, "Run it again", {
        decision: OTHER_DIGEST,
      }),
      // A whole comment copied from when the decision was framed differently.
      sentAnswer("followup", OTHER_DIGEST, "Run it again"),
      sentAnswer("followup", digest, "Run it again", {
        option: "Record it done",
      }),
      sentAnswer("followup", digest, "Run it again", { form: "approve" }),
    ];
    for (const body of bodies) {
      const p = ports([said(body, "drive-bot")]);
      const report = reportOf({ actions: [failedFollowup()] });
      await settle(report, p, root());
      expect(p.steps).toEqual([]);
      expect(report.actions[0]?.answered?.state).toBe("stale");
    }
  });

  it("reaches the park reader's verdict on the dispatcher's own sent answer", async () => {
    const action = failedFollowup();
    const digest = digestOf(action);
    const decision = stationDecision(
      action as Action & { cause: "followup-failed" },
      CONTEXT,
    );
    assert(decision !== null);
    const cases: Array<[string, "answered" | "stale"]> = [
      [digest, "answered"],
      [OTHER_DIGEST, "stale"],
    ];
    for (const [named, verdict] of cases) {
      const comment = said(
        sentAnswer("followup", named, "Run it again"),
        "drive-bot",
      );
      const parks = await parkAnswers(12, [stationItem(decision)], SLUG, [
        {
          user: { login: comment.author },
          author_association: comment.association,
          created_at: comment.at,
          updated_at: null,
          html_url: comment.url,
          body: comment.body,
        },
      ]);
      assert(!("unreadable" in parks));
      expect(parks[verdict]).toHaveLength(1);
      const report = reportOf({ actions: [failedFollowup()] });
      await settle(report, ports([comment]), root());
      expect(report.actions[0]?.answered?.state).toBe(
        verdict === "stale" ? "stale" : undefined,
      );
      expect(report.actions[0]?.answered?.acted !== undefined).toBe(
        verdict === "answered",
      );
    }
  });

  it("leaves an answer naming no digest, or another, stale, and two people's different options disputed", async () => {
    const dir = root();
    const digest = digestOf(failedFollowup());
    const stale = reportOf({ actions: [failedFollowup()] });
    const unbound = ports([said("answer followup: approve")]);
    await settle(stale, unbound, dir);
    expect(stale.actions[0]?.answered?.state).toBe("stale");
    const disputed = reportOf({ actions: [failedFollowup()] });
    const two = ports([
      said(`answer followup: approve [${digest}]`),
      said(
        `answer followup: choose Leave it to me [${digest}]`,
        "another-owner",
      ),
    ]);
    await settle(disputed, two, dir);
    expect(disputed.actions[0]?.answered?.state).toBe("disputed");
    expect([...unbound.steps, ...two.steps]).toEqual([]);
  });

  it("keeps a need answered Leave it to me off the needs for its facts, with no step", async () => {
    const dir = root();
    const action = failedFollowup();
    const p = ports([
      said(`answer followup: choose leave it to me [${digestOf(action)}]`),
    ]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(report.quiet).toEqual([
      expect.objectContaining({ target: "PR #12", class: "answered-hold" }),
    ]);
  });

  it("keeps a refused step's reason, and runs it again only for a new answer", async () => {
    const dir = root();
    const digest = digestOf(failedFollowup());
    const first = said(`answer followup: approve [${digest}]`);
    const refusing = ports(
      [first],
      failed("refused", "a person's hold label is on PR #12"),
    );
    const report = reportOf({ actions: [failedFollowup()] });
    await settle(report, refusing, dir);
    expect(report.actions[0]?.answered?.acted).toMatchObject({
      outcome: "refused",
      detail: "a person's hold label is on PR #12",
    });
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toBeNull();
    await settle(reportOf({ actions: [failedFollowup()] }), refusing, dir);
    expect(refusing.steps).toHaveLength(1);
    const answeredAgain = ports([
      first,
      said(
        `answer followup: approve [${digest}]`,
        "maintainer",
        "OWNER",
        "2026-11-12T12:00:00Z",
      ),
    ]);
    await settle(reportOf({ actions: [failedFollowup()] }), answeredAgain, dir);
    expect(answeredAgain.steps).toEqual(["rerun 12 41"]);
  });

  it("starts a pass's own decision's stage again and hands its next session the option chosen", async () => {
    const dir = root();
    const decision: ParkedDecision = {
      schema: "parked-decision/v1",
      class: "scope",
      call: {
        id: "a",
        question: "Should the export keep the old column?",
        options: [
          {
            id: "keep",
            name: "Keep it",
            summary: "The column stays.",
            pay: ["A wider export."],
          },
          {
            id: "drop",
            name: "Drop it",
            summary: "The column goes.",
            pay: ["Readers of it break."],
          },
        ],
        recommended: "keep",
        why: "Readers of the column still exist.",
      },
      steps: [],
      alreadyDone: "The scouts ran.",
    };
    const digest = decisionDigest(decision);
    const action: Action = {
      ...failedFollowup(),
      framed: { decision, digest, at: "2026-11-12T10:00:00.000Z" },
    };
    const p = ports([
      said(
        `answer followup: choose Drop it [${digest}]\nnote followup: only the export's copy`,
      ),
    ]);
    await settle(reportOf({ actions: [action] }), p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toMatchObject({
      question: "Should the export keep the old column?",
      option: "Drop it",
      recommended: false,
      changes: "The column goes.",
      note: "only the export's copy",
    });
  });

  it("retires an interrupted answer's carry when a newer answer to the same decision is claimed", () => {
    const dir = root();
    const carry = (option: string): CarriedAnswer => ({
      question: "q?",
      option,
      recommended: false,
      changes: "",
      costs: "",
      by: "maintainer",
      url: `https://github.com/${SLUG}/pull/12#issuecomment-${option}`,
    });
    const row = (answer: string, option: string) => ({
      repo: SLUG,
      target: "PR #12",
      key: "followup",
      digest: "d1",
      answer,
      author: "maintainer",
      option,
    });
    expect(claimAnswer(row("a 1", "First"), carry("First"), dir)).toBe(true);
    expect(claimAnswer(row("b 2", "Second"), carry("Second"), dir)).toBe(true);
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)?.option).toBe("Second");
    expect(takeCarried(SLUG, "PR #12", "r-2", dir)).toBeNull();
  });

  it("retires an interrupted carry when the same decision is answered under a replacement framing without one", () => {
    const dir = root();
    const row = (digest: string, answer: string, option: string) => ({
      repo: SLUG,
      target: "PR #12",
      key: "followup",
      digest,
      answer,
      author: "maintainer",
      option,
    });
    const carried: CarriedAnswer = {
      question: "q?",
      option: "Release it",
      recommended: false,
      changes: "",
      costs: "",
      note: "release now",
      by: "maintainer",
      url: `https://github.com/${SLUG}/pull/12#issuecomment-1`,
    };
    expect(claimAnswer(row("d1", "a 1", "Release it"), carried, dir)).toBe(
      true,
    );
    expect(claimAnswer(row("d2", "b 2", "Leave it to me"), null, dir)).toBe(
      true,
    );
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toBeNull();
  });
});

describe("settleStationAnswers on an item of another tracker", () => {
  const LINEAR = stationContextOf(SLUG, {
    tracker: { adapter: "linear" },
    links: { itemsOf: () => null, prsOf: () => [] },
  });
  const stalled = (): Action => ({
    stage: "notify",
    target: "ENG-12",
    record: "tracker",
    reason: "stalled pickup",
    cause: "stalled",
    evidence: { state: "In Progress" },
  });
  const digest =
    stationDecision(stalled() as Action & { cause: "stalled" }, LINEAR)
      ?.digest ?? "";

  let n = 0;
  function onItem(
    body: string,
    author = "Dana Lee",
    association = "MEMBER",
    at = "2026-11-12T11:00:00Z",
  ): CommentLike {
    n += 1;
    return {
      author,
      association,
      at,
      editedAt: null,
      url: `https://linear.app/acme/issue/ENG-12/x#comment-${n}`,
      body,
    };
  }

  /** Ports whose tracker holds `comments` on the item, and `own` by its own user, and whose forge is never read. */
  function onTracker(
    comments: Outcome<CommentLike[], "unreadable">,
    own: CommentLike[] = [],
  ): StationPorts & { steps: string[]; read: string[] } {
    const p = ports([]);
    const read: string[] = [];
    return {
      ...p,
      read,
      comments: async () => failed("unreadable", "the forge was read"),
      trackerComments: async (item) => {
        read.push(item);
        return comments.ok
          ? ok({
              comments: comments.value,
              own: { name: "Jig Factory", comments: own },
            })
          : comments;
      },
    };
  }

  const settleOn = (report: RepoReport, p: StationPorts, dir: string) =>
    settleStationAnswers(SLUG, report, LINEAR, p, dir);

  it("reads the item's comments on the tracker and acts on each person's latest answer", async () => {
    const dir = root();
    const p = onTracker(
      ok([
        onItem(`answer pickup: choose Leave it to me [${digest}]`),
        onItem(
          `answer pickup: approve [${digest}]`,
          "Dana Lee",
          "MEMBER",
          "2026-11-12T12:00:00Z",
        ),
      ]),
    );
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(p.read).toEqual(["ENG-12"]);
    expect(p.steps).toEqual([expect.stringMatching(/^release ENG-12/)]);
    expect(report.actions[0]?.answered).toMatchObject({
      digest,
      answers: [
        { author: "Dana Lee", choice: { option: "Release the claim" } },
      ],
      acted: { option: "Release the claim", outcome: "done" },
    });
  });

  it("hands the next pickup no answer once the tick released the claim, so it starts the item afresh", async () => {
    const dir = root();
    const p = onTracker(ok([onItem(`answer pickup: approve [${digest}]`)]));
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(p.steps).toEqual([expect.stringMatching(/^release ENG-12/)]);
    expect(report.actions[0]?.answered?.acted).toMatchObject({
      option: "Release the claim",
      outcome: "done",
    });
    const handed = carried(SLUG, "ENG-12", "r-1", dir);
    expect(handed).toEqual({});
    const record = {
      id: "r-1",
      token: "0".repeat(32),
      action: "pickup",
      repo: SLUG,
      pr: null,
      item: "ENG-12",
      vendor: "claude",
      model: null,
      effort: null,
      sessionId: null,
      ...handed,
    } as unknown as LaunchRecord;
    const prompt = pickupPassArgv(record, []).at(-1) ?? "";
    expect(prompt).not.toContain("Carry out the option they chose");
    expect(prompt).not.toContain("Release the claim");
  });

  it("hands a replayed launch record no release answer an earlier version kept in it", () => {
    const answered = {
      question: "q?",
      option: "Release the claim",
      recommended: false,
      changes: "",
      costs: "",
      by: "maintainer",
      url: `https://github.com/${SLUG}/issues/12#issuecomment-1`,
    };
    const record = (extra: object) =>
      ({
        id: "r-9",
        token: "0".repeat(32),
        action: "pickup",
        repo: SLUG,
        pr: null,
        item: "ENG-12",
        vendor: "claude",
        model: null,
        effort: null,
        sessionId: null,
        ...extra,
      }) as unknown as LaunchRecord;
    const legacy = pickupPassArgv(record({ answered }), []).at(-1) ?? "";
    expect(legacy).not.toContain("Carry out the option they chose");
    const framed =
      pickupPassArgv(
        record({ answered: { ...answered, step: "session" } }),
        [],
      ).at(-1) ?? "";
    expect(framed).toContain("Carry out the option they chose");
  });

  it("acts on no answer from an author the tracker does not vouch for, a stale digest or two people who differ", async () => {
    const dir = root();
    const cases: Array<[CommentLike[], "stale" | "disputed" | undefined]> = [
      [
        [onItem(`answer pickup: approve [${digest}]`, "Guest", "NONE")],
        undefined,
      ],
      [[onItem("answer pickup: approve [0123456789ab]")], "stale"],
      [
        [
          onItem(`answer pickup: approve [${digest}]`),
          onItem(
            `answer pickup: choose Leave it to me [${digest}]`,
            "Sam Ortiz",
          ),
        ],
        "disputed",
      ],
    ];
    for (const [comments, state] of cases) {
      const p = onTracker(ok(comments));
      const report = reportOf({ actions: [stalled()] });
      await settleOn(report, p, dir);
      expect(p.steps).toEqual([]);
      expect(report.actions[0]?.answered?.state).toBe(state);
    }
  });

  it("releases the claim on a person's answer the tracker holds, never counting its own user's", async () => {
    const dir = root();
    const dana = { id: "u-dana", name: "Dana Lee" };
    const { p, moved } = ownUserPorts(
      [
        {
          id: "c1",
          body: `answer pickup: choose Leave it to me \\[${digest}\\]`,
          createdAt: "2026-11-12T10:30:00.000Z",
          trusted: true,
          author: FACTORY_USER,
        },
        {
          id: "c2",
          body: `answer pickup: approve \\[${digest}\\]`,
          createdAt: "2026-11-12T11:00:00.000Z",
          trusted: true,
          author: dana,
          url: "https://linear.app/acme/issue/ENG-12/x#comment-c2",
        },
      ],
      dir,
    );
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(moved).toEqual(["ENG-12 todo"]);
    expect(report.actions[0]?.answered).toMatchObject({
      answers: [{ author: "Dana Lee" }],
      acted: { author: "Dana Lee", outcome: "done" },
    });
    expect(report.actions[0]?.answered?.answers).toHaveLength(1);
  });

  /** Stationed ports over a tracker whose credential acts as Jig Factory and whose item holds `comments`, recording each state moved to. */
  function ownUserPorts(
    comments: readonly CommentFact[],
    dir: string,
  ): { p: StationPorts; moved: string[] } {
    const moved: string[] = [];
    const tracker = {
      adapter: "linear",
      commentAuthors: true,
      viewer: async () => FACTORY_USER,
      issueComments: async () => ({ uuid: "uuid-12", comments }),
      getIssue: async () => ({
        state: { name: "In Progress", type: "started" },
      }),
      transition: async (key: string, state: string) => {
        moved.push(`${key} ${state}`);
      },
    } as unknown as Tracker;
    const p = stationPorts({
      repo: { path: "/srv/work/web", slug: SLUG, defaultBranch: "main" },
      enabled: new Set(["pickup"]),
      section: {
        states: ["todo"],
        labels: { ...DEFAULT_LABELS, enabled: false },
      } as unknown as DispatchSection,
      shared: {} as SharedContext,
      login: "drive-bot",
      tracker,
      issueRepository: null,
      links: { itemsOf: () => null, prsOf: () => [] },
      sessions: async () => ({ ok: true, source: "test", workspaces: [] }),
      root: dir,
    });
    return { p, moved };
  }

  const FACTORY_USER = { id: "u-factory", name: "Jig Factory" };
  const RELEASE = "Release the claim";
  const byFactory = (
    body: string,
    fields: Partial<CommentFact> = {},
  ): CommentFact => ({
    id: "c-own",
    body,
    createdAt: "2026-11-12T11:00:00.000Z",
    trusted: true,
    author: FACTORY_USER,
    ...fields,
  });
  const sentByFactory = (named = digest, record: SentFields = {}) =>
    sentAnswer("pickup", named, RELEASE, { login: "Jig Factory", ...record });

  it("counts an answer `jig send` wrote as the tracker's own user, by the record it carries", async () => {
    const dir = root();
    // The tracker hands the answer line back with its brackets escaped.
    const body = sentByFactory().replace(`[${digest}]`, `\\[${digest}\\]`);
    const { p, moved } = ownUserPorts([byFactory(body)], dir);
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(moved).toEqual(["ENG-12 todo"]);
    expect(report.actions[0]?.answered).toMatchObject({
      answers: [{ author: "Jig Factory", choice: { option: RELEASE } }],
      acted: { author: "Jig Factory", option: RELEASE, outcome: "done" },
    });
  });

  it("keeps a record whose JSON has escapes of its own as the tracker wrote it", async () => {
    const dir = root();
    const body = sentByFactory().replace(
      '"form":"choose"',
      '"form":"choose","note":"say \\"why\\""',
    );
    const { p, moved } = ownUserPorts([byFactory(body)], dir);
    await settleOn(reportOf({ actions: [stalled()] }), p, dir);
    expect(moved).toEqual(["ENG-12 todo"]);
  });

  it("counts the tracker's own user's sent answer after a trip through Jira's document format", async () => {
    const dir = root();
    const body = adfToMarkdown(markdownToAdf(sentByFactory()));
    const { p, moved } = ownUserPorts([byFactory(body)], dir);
    await settleOn(reportOf({ actions: [stalled()] }), p, dir);
    expect(moved).toEqual(["ENG-12 todo"]);
  });

  it("does not count the tracker's own user's sent answer when the tracker does not vouch for that user", async () => {
    const dir = root();
    const { p, moved } = ownUserPorts(
      [byFactory(sentByFactory(), { trusted: false })],
      dir,
    );
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(moved).toEqual([]);
    expect(report.actions[0]?.answered?.acted).toBeUndefined();
  });

  it("does not act on the tracker's own user's comment whose record names another key, digest or framing", async () => {
    const cases: Array<[string, "stale" | undefined]> = [
      [sentByFactory(digest, { key: "followup" }), undefined],
      [sentByFactory(digest, { decision: OTHER_DIGEST }), "stale"],
      [sentByFactory(digest, { decision: null }), "stale"],
      [sentByFactory(OTHER_DIGEST), "stale"],
    ];
    for (const [body, state] of cases) {
      const dir = root();
      const { p, moved } = ownUserPorts([byFactory(body)], dir);
      const report = reportOf({ actions: [stalled()] });
      await settleOn(report, p, dir);
      expect(moved).toEqual([]);
      expect(report.actions[0]?.answered?.state).toBe(state);
      expect(report.actions[0]?.answered?.acted).toBeUndefined();
    }
  });

  it("reads an answer only the tracker's own user wrote as unread, says why, and takes no step", async () => {
    const dir = root();
    const p = onTracker(ok([onItem("thanks, looking")]), [
      onItem(`answer pickup: approve [${digest}]`, "Jig Factory"),
    ]);
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(p.steps).toEqual([]);
    expect(report.actions[0]?.answered).toEqual({
      digest,
      answers: [],
      unread:
        "the only answer on ENG-12 is by Jig Factory, the user the dispatcher's own tracker credential acts as, whose comments the tick counts only with the record jig send writes; answer with jig send, answer on the tracker as another user, or give the dispatcher a tracker user of its own",
    });
  });

  it("acts on a person's answer beside one by the tracker's own user", async () => {
    const dir = root();
    const p = onTracker(ok([onItem(`answer pickup: approve [${digest}]`)]), [
      onItem(`answer pickup: approve [${digest}]`, "Jig Factory"),
    ]);
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(report.actions[0]?.answered?.unread).toBeUndefined();
    expect(report.actions[0]?.answered?.answers).toHaveLength(1);
  });

  it("shows why the answers on the item were not read, and takes no step", async () => {
    const dir = root();
    const why =
      "the linear tracker does not name who wrote each comment, so answers on ENG-12 are not read";
    const p = onTracker(failed("unreadable", why));
    const report = reportOf({ actions: [stalled()] });
    await settleOn(report, p, dir);
    expect(p.steps).toEqual([]);
    expect(report.actions[0]?.answered).toEqual({
      digest,
      answers: [],
      unread: why,
    });
  });
});

/** A snapshot's exact framing from before the hold display was clarified. */
function legacyFraming(action: Action): ParkedDecision {
  const framing = stationDecision(
    action as Action & { cause: "followup-failed" },
    CONTEXT,
  )?.decision;
  assert(framing);
  return {
    ...framing,
    call: {
      ...framing.call,
      options: framing.call.options.map((o) =>
        o.id === "hold"
          ? {
              ...o,
              name: "Leave it to me",
              summary:
                "The dispatcher takes no step on it for these facts and stops listing it under Needs you; it lists it again when they change.",
            }
          : o,
      ),
    },
  };
}

it("counts an old snapshot's hold or rerun answer while its facts stand, and leaves changed facts stale", async () => {
  for (const [answer, option, outcome] of [
    ["choose Leave it to me", "I'll handle it — hide this card", "held"],
    ["approve", "Run it again", "done"],
  ] as const) {
    const dir = root();
    const action = failedFollowup();
    const digest = decisionDigest(legacyFraming(action));
    expect(digestOf(action)).toBe(digest);
    const p = ports([said(`answer followup: ${answer} [${digest}]`)]);
    await settle(reportOf({ actions: [action] }), p, dir);
    expect(action.answered?.acted).toMatchObject({ option, outcome });
    expect(p.steps).toEqual(outcome === "held" ? [] : ["rerun 12 41"]);
    const changed = failedFollowup();
    changed.evidence.marker = 42;
    const stale = reportOf({ actions: [changed] });
    await settle(stale, p, dir);
    expect(changed.answered?.state).toBe("stale");
    expect(changed.answered?.acted).toBeUndefined();
    expect(p.steps).toEqual(outcome === "held" ? [] : ["rerun 12 41"]);
  }
});

it("does not repeat a hold or rerun already acted under the old snapshot's digest", async () => {
  for (const [answer, option, outcome] of [
    ["choose Leave it to me", "Leave it to me", "held"],
    ["approve", "Run it again", "done"],
  ] as const) {
    const dir = root();
    const action = failedFollowup();
    const digest = decisionDigest(legacyFraming(action));
    const comment = said(`answer followup: ${answer} [${digest}]`);
    const row = {
      repo: SLUG,
      target: "PR #12",
      key: "followup",
      digest,
      answer: `${comment.url} ${comment.at}`,
      author: comment.author,
      option,
    };
    expect(claimAnswer(row, null, dir)).toBe(true);
    finishAnswer(row, outcome, "recorded before the display change", null, dir);
    const p = ports([comment]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    await settle(reportOf({ actions: [failedFollowup()] }), p, dir);
    expect(p.steps).toEqual([]);
    expect(action.answered?.acted).toMatchObject({
      option,
      outcome,
      detail: "recorded before the display change",
    });
    expect(report.quiet.some((q) => q.class === "answered-hold")).toBe(
      outcome === "held",
    );
  }
});

it("counts the dispatcher's own sent hold answer whose record keeps the retired spelling", async () => {
  const dir = root();
  const action = failedFollowup();
  const digest = digestOf(action);
  const p = ports([
    said(
      sentAnswer("followup", digest, "I'll handle it \u2014 hide this card", {
        option: "Leave it to me",
      }),
      "Drive-Bot",
    ),
  ]);
  await settle(reportOf({ actions: [action] }), p, dir);
  expect(action.answered?.state).toBeUndefined();
  expect(action.answered?.acted).toMatchObject({ outcome: "held" });
});
