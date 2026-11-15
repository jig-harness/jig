/**
 * dispatch --apply: a pickup that stopped on a question for a person and
 * wrote a closing report. *What needs you* shows the report's `question`
 * and its framed `decision` where it shows the pass's `Question:` line,
 * with the report's `concluded` beside them as context; the report changes
 * what the need says, never whether there is one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { readRecord } from "../lib/launches.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

const QUESTION = "Should the export keep the old column?";
const CONCLUDED = "Stopped: the export's old column still has readers.";

const DECISION = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: QUESTION,
    options: [
      { id: "keep", name: "Keep it", summary: "It stays.", pay: ["Width."] },
      { id: "drop", name: "Drop it", summary: "It goes.", pay: ["Breaks."] },
    ],
    recommended: "keep",
    why: "Readers of the column still exist.",
  },
  steps: [],
  alreadyDone: "The scouts ran.",
};

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** Issue #12 assigned to the factory identity by a writer, one account, `pickup` enabled. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
  return w;
}

/** Launch the pickup, let its pass say `said` and exit 1, and record `report` as its closing report. */
async function stopped(
  w: World,
  said: string,
  report: Record<string, unknown>,
): Promise<string> {
  const receipt = await applyTick(w, false);
  const [started] = (receipt.repos[0]?.launches ?? []) as Array<{
    record?: string;
  }>;
  const id = String(started?.record);
  const token = readRecord(id, dispatchState(w))?.token ?? "";
  await waitFor("the pass", () => claudeRuns(w).length === 1);
  writeFileSync(join(w.dir, "claude-said"), said);
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("the exit", () => exitWritten(w, id));
  const file = join(w.root, "report.json");
  writeFileSync(file, JSON.stringify(report));
  expectSpawnExit(await w.dispatch(["report", id, token, file]), 0);
  return id;
}

async function needOf(w: World) {
  await applyTick(w, false);
  const answer = await w.dispatch(["line", "--json"]);
  expectSpawnExit(answer, 0);
  const parsed = JSON.parse(answer.stdout) as {
    value: { line: LineSnapshot };
  };
  return parsed.value.line.needs.find((n) => n.target === "#12");
}

describe("a pickup's closing report on What needs you", () => {
  it("shows the report's question and its framed decision, with what the run concluded", async () => {
    const w = fixture();
    await stopped(w, "Question: keep the column?\n", {
      schema: "closing-report/v1",
      concluded: CONCLUDED,
      question: QUESTION,
      decision: DECISION,
      suggested_next: {
        step: "Choose whether the column stays.",
        owner: "person",
        act: "Decide",
      },
      cause: "needs-person",
    });
    const need = await needOf(w);
    expect(need).toMatchObject({
      cause: "pickup-question",
      question: QUESTION,
      concluded: CONCLUDED,
    });
    expect(need?.decisions[0]).toMatchObject({
      key: "pickup",
      question: QUESTION,
      decisionClass: "scope",
      answer: { station: "pickup", framedBy: "session" },
    });
  });

  it("keeps the Question: line where the report asks nothing, with what the run concluded", async () => {
    const w = fixture();
    await stopped(w, "Question: keep the column?\n", {
      schema: "closing-report/v1",
      concluded: CONCLUDED,
      suggested_next: { step: "Ask the readers.", owner: "person", act: "Do" },
    });
    const need = await needOf(w);
    expect(need).toMatchObject({
      cause: "pickup-question",
      question: "keep the column?",
      concluded: CONCLUDED,
    });
  });
});
