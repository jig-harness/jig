/**
 * dispatch --apply: a follow-up whose pass stopped on a question for a
 * person and wrote a closing report. The failed follow-up's need shows the
 * report's `question` and framed `decision` where it shows the pass's
 * `Question:` line, with the report's `concluded` beside them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { readRecord } from "../lib/launches.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

const HEAD = "feature/9-done";
const QUESTION = "Which version does this merge ship in?";
const CONCLUDED =
  "Updated the website; the release tag waits on the version to ship in.";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** PR #9 merged, with its workspace; one account, `followup` enabled from before the merge. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("merged", [mergedPr(9, HEAD, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 9, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["followup"], {
    followup_since: "2026-10-30T00:00:00Z",
  });
  return w;
}

describe("a follow-up's closing report on What needs you", () => {
  it("shows the report's question and decision, with what the run concluded", async () => {
    const w = fixture();
    const receipt = await applyTick(w, false);
    const [started] = (receipt.repos[0]?.launches ?? []) as Array<{
      record?: string;
    }>;
    const id = String(started?.record);
    const token = readRecord(id, dispatchState(w))?.token ?? "";
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      "Question: which version does this merge ship in?\n",
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    const file = join(w.root, "report.json");
    writeFileSync(
      file,
      JSON.stringify({
        schema: "closing-report/v1",
        concluded: CONCLUDED,
        question: QUESTION,
        decision: {
          schema: "parked-decision/v1",
          class: "scope",
          call: {
            id: "a",
            question: QUESTION,
            options: [
              { id: "minor", name: "Minor", summary: "1.3.0.", pay: ["None."] },
              { id: "patch", name: "Patch", summary: "1.2.1.", pay: ["None."] },
            ],
            recommended: "minor",
            why: "The merge adds a command.",
          },
          steps: [],
          alreadyDone: "The website is updated.",
        },
        suggested_next: {
          step: "Choose the version.",
          owner: "person",
          act: "Decide",
        },
        cause: "needs-person",
      }),
    );
    expectSpawnExit(await w.dispatch(["report", id, token, file]), 0);
    w.setWorkspaces([]);

    const after = await applyTick(w, false);
    const action = (after.repos[0]?.actions ?? []).find(
      (a) => a.cause === "followup-failed",
    );
    expect(action?.evidence).toMatchObject({
      question: QUESTION,
      concluded: CONCLUDED,
    });
    const answer = await w.dispatch(["line", "--json"]);
    expectSpawnExit(answer, 0);
    const parsed = JSON.parse(answer.stdout) as {
      value: { line: LineSnapshot };
    };
    const need = parsed.value.line.needs.find((n) => n.target === "PR #9");
    expect(need).toMatchObject({
      cause: "followup-failed",
      question: QUESTION,
      concluded: CONCLUDED,
    });
    expect(need?.decisions[0]).toMatchObject({
      question: QUESTION,
      decisionClass: "scope",
      answer: { framedBy: "session" },
    });
  });
});
