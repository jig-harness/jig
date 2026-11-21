/** Untagged releases that share a remedy, as the one need a person answers. */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitingAnswer } from "../../ask/lib/waiting.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import type { LineNeed } from "../lib/dashboard-contract.ts";
import { stationContextOf, stationDecision } from "../lib/line-station.ts";
import { readLine } from "../lib/line-store.ts";
import {
  claimReleaseRerun,
  recordTagged,
  releaseNeedActions,
  releaseNeeds,
  releasePolicyOf,
  reserveRelease,
  type OwedPlanState,
} from "../lib/release-needs.ts";
import { RELEASES_ALREADY_TAKEN, stateDb } from "../lib/state.ts";
import { claimAnswer, finishAnswer } from "../lib/station-answer-store.ts";
import {
  settleStationAnswers,
  type StationPorts,
} from "../lib/station-answers.ts";
import type { Action, RepoReport } from "../lib/types.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import { FOLLOWUP_CONFIG, followupWorkspace } from "./followup-fixtures.ts";
import { dispatchState } from "./launch-fixtures.ts";
import { report as reportOf } from "./line-fixtures.ts";
import { applyTick } from "./pickup-fixtures.ts";

/** Listed out of text order, as version numbers sort apart from their spelling. */
const RELEASES = [
  ["v1.10.0", "#43"],
  ["v1.11.0", "#44"],
  ["v1.12.0", "#45"],
  ["v1.2.0", "#41"],
  ["v1.9.0", "#42"],
] as const;
const IN_VERSION_ORDER = "v1.2.0, v1.9.0, v1.10.0, v1.11.0, v1.12.0";
const NEWEST_ITEM = "#45";
const NEWEST_ITEM_NUMBER = 45;

const active: World[] = [];
afterEach(() => {
  for (const w of active.splice(0)) w.close();
});

function fixture(): World {
  const w = world();
  active.push(w);
  followupWorkspace(w);
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  writeFileSync(join(w.repo, ".config/jig.yaml"), FOLLOWUP_CONFIG);
  w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
  w.setComments(NEWEST_ITEM_NUMBER, []);
  return w;
}

function owe(w: World, tag: string, item: string): void {
  const root = dispatchState(w);
  expect(reserveRelease(SLUG, tag, "seed", undefined, root).ok).toBe(true);
  expect(reserveRelease(SLUG, tag, "seed", item, root).ok).toBe(true);
}

function oweAll(w: World): void {
  for (const [tag, item] of RELEASES) owe(w, tag, item);
}

function releaseCards(w: World): LineNeed[] {
  const line = readLine(dispatchState(w));
  expect(line.ok).toBe(true);
  return line.ok
    ? (line.value?.needs.filter((need) => need.cause === "release-owed") ?? [])
    : [];
}

function waitingReleases(w: World) {
  return waitingAnswer(dispatchState(w)).waiting.filter((entry) =>
    entry.reason.includes("owed"),
  );
}

const questionOf = (need: LineNeed | undefined) =>
  need?.decisions[0]?.question ?? "";
const optionsOf = (need: LineNeed | undefined) =>
  need?.decisions[0]?.options?.map((option) => option.name);

/** Every version but the tagged v1.2.0 is listed, under a decision for that list. */
function expectCurrentList(w: World): void {
  const questions = releaseCards(w).map(questionOf).join(" ");
  expect(questions).toContain("v1.9.0");
  expect(questions).toContain("v1.12.0");
  expect(questions).not.toContain("v1.2.0");
}

describe("untagged releases of one repository on the line", () => {
  it("reach a person as one need that lists every version", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const cards = releaseCards(w);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ target: NEWEST_ITEM, act: "Authorize" });
    expect(cards[0]?.reason).toContain(IN_VERSION_ORDER);
    expect(questionOf(cards[0])).toContain(IN_VERSION_ORDER);
    expect(questionOf(cards[0])).toContain(SLUG);
    expect(cards[0]?.title).toBe("5 releases owe their tags");
    expect(cards[0]?.decisions[0]?.answer?.address).toBe(
      `pickup@${SLUG}#${NEWEST_ITEM_NUMBER}`,
    );
    expect(optionsOf(cards[0])).toEqual([
      "Re-run the failed gates",
      "Investigate",
      "Tag it by hand",
    ]);
  });

  it("count as one waiting need in jig ask --waiting", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const waiting = waitingReleases(w);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      address: `pickup@${SLUG}#${NEWEST_ITEM_NUMBER}`,
      target: NEWEST_ITEM,
      act: "answer",
    });
    expect(waiting[0]?.reason).toContain(IN_VERSION_ORDER);
  });

  it("drop each version as it is tagged, and the need with the last", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const first = releaseCards(w)[0];
    recordTagged(SLUG, ["v1.2.0", "v1.9.0"], dispatchState(w));
    await applyTick(w, false);
    const cards = releaseCards(w);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      target: NEWEST_ITEM,
      since: first?.since,
    });
    expect(questionOf(cards[0])).toContain("v1.10.0, v1.11.0, v1.12.0");
    expect(questionOf(cards[0])).not.toContain("v1.9.0");
    expect(cards[0]?.decisions[0]?.digest).not.toBe(
      first?.decisions[0]?.digest,
    );
    expect(waitingReleases(w)).toHaveLength(1);
    recordTagged(SLUG, ["v1.10.0", "v1.11.0", "v1.12.0"], dispatchState(w));
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
    expect(waitingReleases(w)).toHaveLength(0);
  });

  it("keep the need's age when the release it is answered on is tagged", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const first = releaseCards(w)[0];
    w.setComments(44, []);
    recordTagged(SLUG, ["v1.12.0"], dispatchState(w));
    await applyTick(w, false);
    expect(releaseCards(w)).toMatchObject([
      { target: "#44", since: first?.since },
    ]);
  });

  it("hold a release whose one re-run is spent apart from those that have theirs", async () => {
    const w = fixture();
    oweAll(w);
    const root = dispatchState(w);
    expect(claimReleaseRerun(SLUG, "v1.2.0", root)).toBe(true);
    expect(claimReleaseRerun(SLUG, "v1.9.0", root)).toBe(true);
    w.setComments(42, []);
    await applyTick(w, false);
    const cards = releaseCards(w);
    expect(cards).toHaveLength(2);
    const open = cards.find((need) => need.target === NEWEST_ITEM);
    const spent = cards.find((need) => need.target === "#42");
    expect(questionOf(open)).toContain("v1.10.0, v1.11.0, v1.12.0");
    expect(optionsOf(open)).toContain("Re-run the failed gates");
    expect(questionOf(spent)).toContain("v1.2.0, v1.9.0");
    expect(optionsOf(spent)).toEqual(["Investigate", "Tag it by hand"]);
    expect(spent?.decisions[0]?.decision?.call.recommended).toBe("inspect");
  });

  it("offer a lone release whose re-run was requested only what is left", async () => {
    const w = fixture();
    owe(w, "v1.2.0", "#41");
    w.setComments(41, []);
    expect(claimReleaseRerun(SLUG, "v1.2.0", dispatchState(w))).toBe(true);
    await applyTick(w, false);
    const [card] = releaseCards(w);
    expect(card?.target).toBe("#41");
    expect(optionsOf(card)).toEqual(["Investigate", "Tag it by hand"]);
    expect(card?.decisions[0]?.decision?.call.recommended).toBe("inspect");
  });

  it("leave a lone release its own decision", async () => {
    const w = fixture();
    owe(w, "v1.2.0", "#41");
    w.setComments(41, []);
    await applyTick(w, false);
    const cards = releaseCards(w);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      target: "#41",
      reason: "Release v1.2.0 is owed its tag.",
    });
    expect(questionOf(cards[0])).toBe(
      `How should release v1.2.0 of ${SLUG} get its tag?`,
    );
  });

  it("stay off the line once a person takes them, while the rest are tagged", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const digest = releaseCards(w)[0]?.decisions[0]?.digest;
    expect(digest).toBeDefined();
    w.setComments(NEWEST_ITEM_NUMBER, [
      forgeComment(
        111,
        `answer release: choose Tag it by hand [${digest}]`,
        "maintainer",
        "OWNER",
      ),
    ]);
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
    recordTagged(SLUG, ["v1.2.0"], dispatchState(w));
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
    owe(w, "v1.13.0", "#46");
    w.setComments(46, []);
    await applyTick(w, false);
    expect(releaseCards(w)).toMatchObject([{ target: "#46" }]);
  });

  it("come back when a person answers the decision they took them under again", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const digest = releaseCards(w)[0]?.decisions[0]?.digest;
    const took = forgeComment(
      111,
      `answer release: choose Investigate [${digest}]`,
      "maintainer",
      "OWNER",
    );
    w.setComments(NEWEST_ITEM_NUMBER, [took]);
    await applyTick(w, false);
    recordTagged(SLUG, ["v1.2.0"], dispatchState(w));
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
    w.setComments(NEWEST_ITEM_NUMBER, [
      took,
      {
        ...forgeComment(
          112,
          `answer release: choose Re-run the failed gates [${digest}]`,
          "maintainer",
          "OWNER",
        ),
        updated_at: "2026-10-01T12:00:00Z",
      },
    ]);
    await applyTick(w, false);
    const [card] = releaseCards(w);
    expect(card?.target).toBe(NEWEST_ITEM);
    expect(card?.reason).toContain("v1.9.0, v1.10.0, v1.11.0, v1.12.0");
    expect(card?.reason).not.toContain("v1.2.0");
    expect(card?.decisions[0]?.digest).toBe(digest);
    expect(card?.decisions[0]?.acted?.option).toBe("Re-run the failed gates");
    await applyTick(w, false);
    expectCurrentList(w);
  });

  it("return under the current list when the answer that took them is gone", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const digest = releaseCards(w)[0]?.decisions[0]?.digest;
    w.setComments(NEWEST_ITEM_NUMBER, [
      forgeComment(
        111,
        `answer release: choose Investigate [${digest}]`,
        "maintainer",
        "OWNER",
      ),
    ]);
    await applyTick(w, false);
    recordTagged(SLUG, ["v1.2.0"], dispatchState(w));
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
    w.setComments(NEWEST_ITEM_NUMBER, []);
    await applyTick(w, false);
    await applyTick(w, false);
    expectCurrentList(w);
  });

  it("stay taken when the answer that holds them reads again after a gap", async () => {
    const w = fixture();
    oweAll(w);
    await applyTick(w, false);
    const digest = releaseCards(w)[0]?.decisions[0]?.digest;
    const took = forgeComment(
      111,
      `answer release: choose Investigate [${digest}]`,
      "maintainer",
      "OWNER",
    );
    w.setComments(NEWEST_ITEM_NUMBER, [took]);
    await applyTick(w, false);
    w.setComments(NEWEST_ITEM_NUMBER, []);
    await applyTick(w, false);
    w.setComments(NEWEST_ITEM_NUMBER, [took]);
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
    recordTagged(SLUG, ["v1.2.0"], dispatchState(w));
    await applyTick(w, false);
    expect(releaseCards(w)).toHaveLength(0);
  });

  it("keep a release a person took before releases were grouped", () => {
    const w = fixture();
    const root = dispatchState(w);
    owe(w, "v1.2.0", "#41");
    owe(w, "v1.9.0", "#42");
    const row = {
      repo: SLUG,
      target: "#41",
      key: "release",
      digest: "0123456789ab",
      answer: "https://example.test/1 2026-11-01T00:00:00Z",
      author: "maintainer",
      option: "Tag it by hand",
    };
    expect(claimAnswer(row, null, root)).toBe(true);
    finishAnswer(row, "held", "a person took the step", null, root);
    stateDb(root).run(RELEASES_ALREADY_TAKEN);
    const actions = releaseNeedActions(releaseNeeds(SLUG, root), "v");
    expect(actions.map(({ target, evidence }) => [target, evidence])).toEqual([
      ["#42", { tag: "v1.9.0" }],
      ["#41", { tag: "v1.2.0", open: "v1.2.0" }],
    ]);
  });
});

describe("the answer to a group of releases", () => {
  const CONTEXT = stationContextOf(SLUG, { tracker: { adapter: "github" } });
  const OWED = ["v1.2.0", "v1.9.0", "v1.10.0"].map((tag, index) => ({
    tag,
    item: `#${index + 1}`,
    launch: "seed",
    rerun_claimed: 0,
    tagged: 0,
    taken_as: null,
    plan_state: null,
    next_tag_check: 0,
  }));

  function group(owed: typeof OWED = OWED): Action {
    const [action] = releaseNeedActions(owed, "v");
    if (action === undefined) throw new TypeError("no release group");
    return action;
  }

  function answering(
    option: string,
    rerun: (tag: string) => Outcome<string, "refused">,
    owed: typeof OWED = OWED,
    earlier: string[] = [],
  ): StationPorts & { reruns: string[]; taken: string[][]; kept: string[] } {
    const decision = stationDecision(
      group(owed) as Action & { cause: "release-owed" },
      CONTEXT,
    );
    const reruns: string[] = [];
    const taken: string[][] = [];
    const kept: string[] = [];
    const unused = async () => failed("refused", "not this need's step");
    return {
      reruns,
      taken,
      kept,
      self: "drive-bot",
      issueRepository: SLUG,
      comments: async () =>
        ok([
          ...earlier.map((body, index) => ({
            author: "another-maintainer",
            association: "OWNER",
            at: "2026-11-18T10:00:00Z",
            editedAt: null,
            url: `https://github.com/${SLUG}/issues/3#issuecomment-${index + 10}`,
            body,
          })),
          {
            author: "maintainer",
            association: "OWNER",
            at: "2026-11-18T11:00:00Z",
            editedAt: null,
            url: `https://github.com/${SLUG}/issues/3#issuecomment-1`,
            body: `answer release: choose ${option} [${decision?.digest}]`,
          },
        ]),
      trackerComments: async () => failed("unreadable", "not read"),
      rerunReleaseGates: async (tag) => {
        reruns.push(tag);
        return rerun(tag);
      },
      takeReleases: (tags, decision) => {
        taken.push([...tags]);
        if (decision !== null) kept.push(decision);
      },
      rerunFollowup: unused,
      doneFollowup: unused,
      releasePickup: unused,
      detachCheckout: unused,
      rearmDrive: unused,
      clearRecord: unused,
    };
  }

  async function settled(
    ports: StationPorts,
    owed: typeof OWED = OWED,
  ): Promise<RepoReport> {
    const report = reportOf({ slug: SLUG, actions: [group(owed)] });
    const w = world();
    active.push(w);
    await settleStationAnswers(SLUG, report, CONTEXT, ports, dispatchState(w));
    return report;
  }

  it("re-runs the gates of every release it lists", async () => {
    const ports = answering("Re-run the failed gates", (tag) =>
      ok(`requested ${tag}`),
    );
    const report = await settled(ports);
    expect(ports.reruns).toEqual(["v1.2.0", "v1.9.0", "v1.10.0"]);
    expect(report.actions[0]?.answered?.acted).toMatchObject({
      outcome: "done",
      detail:
        "v1.2.0: requested v1.2.0; v1.9.0: requested v1.9.0; v1.10.0: requested v1.10.0",
    });
  });

  it("says which releases a refused re-run left, after trying them all", async () => {
    const ports = answering("Re-run the failed gates", (tag) =>
      tag === "v1.9.0" ? failed("refused", "no failed runs") : ok("requested"),
    );
    const report = await settled(ports);
    expect(ports.reruns).toHaveLength(3);
    expect(report.actions[0]?.answered?.acted).toMatchObject({
      outcome: "refused",
      detail: "v1.2.0: requested; v1.9.0: no failed runs; v1.10.0: requested",
    });
  });

  it("is not held up by another person's answer to an earlier list", async () => {
    const ports = answering("Investigate", () => ok("unused"), OWED, [
      "answer release: choose Investigate [0123456789ab]",
    ]);
    const report = await settled(ports);
    expect(ports.taken).toEqual([["v1.2.0", "v1.9.0", "v1.10.0"]]);
    expect(report.actions).toHaveLength(0);
  });

  it("hands every release it lists to the person who took them", async () => {
    const ports = answering("Investigate", () => ok("unused"));
    const report = await settled(ports);
    expect(ports.reruns).toEqual([]);
    expect(ports.taken).toEqual([["v1.2.0", "v1.9.0", "v1.10.0"]]);
    expect(JSON.parse(ports.kept[0] ?? "")).toEqual({
      target: "#3",
      evidence: {
        tags: "v1.2.0 v1.9.0 v1.10.0",
        items: "#1 #2 #3",
        rerunSpent: false,
      },
    });
    expect(report.actions).toHaveLength(0);
    expect(report.quiet).toMatchObject([
      { target: "#3", class: "answered-hold" },
    ]);
  });
});

describe("what is left to try for an untagged release", () => {
  const owed = (
    tag: string,
    plan_state: OwedPlanState | null,
    rerun_claimed = 0,
  ) => ({
    tag,
    item: `#${tag.replaceAll(/\D/g, "")}`,
    launch: "seed",
    rerun_claimed,
    tagged: 0,
    taken_as: null,
    plan_state,
    next_tag_check: 0,
  });
  const decisionOf = (action: Action | undefined) =>
    action === undefined
      ? undefined
      : stationDecision(
          action as Action & { cause: "release-owed" },
          stationContextOf(SLUG, { tracker: { adapter: "github" } }),
        )?.decision?.call;
  const recommended = (action: Action | undefined) => {
    const call = decisionOf(action);
    if (call === undefined) return undefined;
    return call.options.find((o) => o.id === call.recommended)?.name;
  };

  it("keeps the re-run for a release whose releasing commit failed its gates, or that recorded no state", () => {
    for (const state of ["failed", null] as const) {
      const [action] = releaseNeedActions([owed("v1.2.0", state)], "v");
      expect(recommended(action)).toBe("Re-run the failed gates");
      expect(action?.evidence.noRerun).toBeUndefined();
    }
  });

  it("recommends tagging by hand for a release whose required checks all passed", () => {
    const [action] = releaseNeedActions([owed("v1.2.0", "ready")], "v");
    expect(recommended(action)).toBe("Tag it by hand");
    expect(decisionOf(action)?.options.map((o) => o.name)).not.toContain(
      "Re-run the failed gates",
    );
    expect(action?.reason).toBe(
      "Release v1.2.0 is owed its tag. Every required check passed on the releasing commit of v1.2.0, so no failed gate is left to re-run.",
    );
  });

  it("recommends tagging by hand whatever the checks say where the repository makes the tag a person's step", () => {
    for (const values of [
      { changelog: { release: { tagged_by: "person" } } },
      { changelog: { release: { rerun_failed_gates: 0 } } },
    ]) {
      const [action] = releaseNeedActions(
        [owed("v1.2.0", "failed")],
        "v",
        releasePolicyOf(values),
      );
      expect(recommended(action)).toBe("Tag it by hand");
      expect(action?.reason).toContain("changelog.release.");
    }
  });

  it("does not group releases that differ in what is left to try", () => {
    const actions = releaseNeedActions(
      [
        owed("v1.2.0", "failed"),
        owed("v1.3.0", "failed"),
        owed("v1.4.0", "ready"),
        owed("v1.5.0", "manual"),
        owed("v1.6.0", "failed", 1),
      ],
      "v",
    );
    expect(
      actions.map((a) => [a.evidence.tags ?? a.evidence.tag, recommended(a)]),
    ).toEqual([
      ["v1.2.0 v1.3.0", "Re-run the failed gates"],
      ["v1.6.0", "Investigate"],
      ["v1.4.0 v1.5.0", "Tag it by hand"],
    ]);
    expect(actions[2]?.evidence.noRerun).toBe(
      "Every required check passed on the releasing commit of v1.4.0, so no failed gate is left to re-run. The tag plan leaves v1.5.0 to a person: older than the newest tag, outside automatic tagging.",
    );
  });
});
