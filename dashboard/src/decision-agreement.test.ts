/**
 * `jig ask --thread` and the dashboard show one park the same way: the same
 * options, numbered alike, and the same choice for each answer, because both
 * read the park and its answers through the same functions
 * (`plugin/shared/decision-card.ts`, `decisionOf`). The ask side runs the
 * command against a fake forge; the dashboard side reads the same ledger and
 * comments through the tick's park reader and the card's view.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import type { AskAnswer, ThreadEntry } from "../../plugin/ask/lib/answer.ts";
import type {
  LineDecision,
  LineNeed,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../../plugin/dispatch/lib/line-decision.ts";
import { readPark } from "../../plugin/dispatch/lib/sources/park-reading.ts";
import { ledgerBody } from "../../plugin/skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import {
  comment,
  digestOf,
  framedLedger,
  framedPark,
  PARK_KEY,
  pullRequest,
  REPO,
  type SendWorld,
  sendWorld,
} from "../../plugin/send/__tests__/send-fixtures.ts";
import { needView } from "./needs-view.ts";

let w: SendWorld | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const ANSWERED = "2026-11-02T10:00:00Z";
const ledger = framedLedger(12, [framedPark(PARK_KEY, "scope")]);

/** Pull request 12 parked on one framed decision, with `answers` as its comments. */
function world(answers: Array<[string, string]>): {
  world: SendWorld;
  listing: unknown[];
} {
  const listing = [
    comment(701, ledgerBody(ledger)),
    ...answers.map(([login, body], i) =>
      comment(702 + i, body, login, "MEMBER", ANSWERED),
    ),
  ];
  w = sendWorld();
  pullRequest(w, 12, [], listing);
  return { world: w, listing };
}

async function askThread(world: SendWorld): Promise<ThreadEntry[]> {
  const r = await world.ask([`drive@${REPO}#12`, "--json", "--thread"]);
  expectSpawnExit(r, 0);
  return (JSON.parse(r.stdout) as AskAnswer).thread ?? [];
}

/** The decision the tick's line carries for the park, read from the same comments. */
async function lineDecision(listing: unknown[]): Promise<LineDecision> {
  const read = await readPark(12, ledger, REPO, listing);
  if (read === undefined || "unreadable" in read)
    throw new Error("the park did not read");
  const park = read.parks?.[0];
  if (park === undefined) throw new Error("the park is not waiting");
  return decisionOf(park);
}

function cardOf(decision: LineDecision) {
  const need: LineNeed = {
    cause: "parked",
    stage: "rearm",
    repo: REPO,
    target: "PR #12",
    pr: 12,
    item: null,
    url: null,
    title: null,
    since: ANSWERED,
    reason: "parked",
    decisions: [decision],
    notified: null,
    workspaces: [],
  };
  return needView(need, { nowMs: Date.parse(ANSWERED), timeZone: "UTC" });
}

const optionsOf = (options: LineDecision["options"]) =>
  (options ?? []).map((o) => [o.number, o.name, o.recommended]);

describe("jig ask and the dashboard show one park alike", () => {
  it("shows the same options and the same choices for a disputed park", async () => {
    const digest = digestOf("scope");
    const { world: forge, listing } = world([
      ["maintainer", `answer ${PARK_KEY}: approve [${digest}]`],
      ["reviewer", `answer ${PARK_KEY}: choose Remove [${digest}]`],
    ]);
    const thread = await askThread(forge);
    const question = thread.find(
      (e) => e.kind === "question" && e.key === PARK_KEY,
    );
    const answers = thread.filter(
      (e) => e.kind === "answer" && e.key === PARK_KEY,
    );
    const decision = await lineDecision(listing);

    expect(question?.digest).toBe(digest);
    expect(optionsOf(question?.options)).toEqual([
      [1, "Keep", true],
      [2, "Remove", false],
    ]);
    expect(optionsOf(question?.options)).toEqual(optionsOf(decision.options));

    const chosen = (
      list: Array<{ author: string; option: string | undefined }>,
    ) => list.map((a) => [a.author, a.option]).sort();
    expect(
      chosen(
        answers.map((e) => ({ author: e.from, option: e.choice?.option })),
      ),
    ).toEqual([
      ["maintainer", "Keep"],
      ["reviewer", "Remove"],
    ]);
    expect(
      chosen(
        (decision.answers ?? []).map((a) => ({
          author: a.author,
          option: a.choice?.option,
        })),
      ),
    ).toEqual(
      chosen(
        answers.map((e) => ({ author: e.from, option: e.choice?.option })),
      ),
    );
    expect(decision.answerState).toBe("disputed");

    const card = cardOf(decision);
    expect(card.act).toBe("Decide");
    expect(card.answerNotes).toEqual([
      {
        state: "disputed",
        text: "Disputed, so it waits until the people answering agree: @maintainer chose Keep (the recommended option); @reviewer chose Remove.",
      },
    ]);
  }, 60_000);

  it("shows a stale answer and a free one alike", async () => {
    const { world: forge, listing } = world([
      ["maintainer", `answer ${PARK_KEY}: approve [000000000000]`],
      ["reviewer", `answer ${PARK_KEY}: keep it, but rename the flag`],
    ]);
    const thread = await askThread(forge);
    const byAuthor = (who: string) =>
      thread.find((e) => e.kind === "answer" && e.from === who);
    expect(byAuthor("maintainer")?.stale).toEqual({ digest: "000000000000" });
    expect(byAuthor("maintainer")?.choice).toBeUndefined();
    expect(byAuthor("reviewer")?.free).toBe(true);

    const decision = await lineDecision(listing);
    expect(decision.answerState).toBe("stale");
    const shown = (decision.answers ?? []).map((a) => [
      a.author,
      a.stale ?? null,
      a.free ?? false,
    ]);
    expect(shown.sort()).toEqual([
      ["maintainer", { digest: "000000000000" }, false],
      ["reviewer", null, true],
    ]);
    const [note] = cardOf(decision).answerNotes;
    expect(note?.state).toBe("stale");
    expect(note?.text).toStartWith("Stale, so it waits");
  }, 60_000);
});
