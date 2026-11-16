import { ok as assert } from "node:assert/strict";
import { expect, test } from "bun:test";
import { fixture } from "../fixtures.ts";
import {
  ANSWER_POLL_MS,
  ANSWER_WAIT_MS,
  answerReadInterval,
  watchAnswer,
} from "./send-watch.ts";
test("a fake running clock bounds quicker reads and the tick's outcome stops them", () => {
  const line = fixture("loud").line;
  assert(line);
  const need = line.needs[0];
  assert(need);
  const decision = need.decisions[0];
  assert(decision);
  const url = "https://github.com/example-org/web/issues/7#issuecomment-8";
  watchAnswer(need.repo, need.target, [url], 100);
  expect(answerReadInterval(line, 101)).toBe(ANSWER_POLL_MS);
  expect(answerReadInterval(line, 100 + ANSWER_WAIT_MS - 1)).toBe(
    ANSWER_POLL_MS,
  );
  expect(answerReadInterval(line, 100 + ANSWER_WAIT_MS)).toBe(60_000);
  watchAnswer(need.repo, need.target, [url], 100);
  const settled = {
    ...line,
    needs: [
      {
        ...need,
        decisions: [
          {
            ...decision,
            acted: {
              option: "Run",
              author: "maintainer",
              outcome: "done" as const,
              detail: "Done",
              answer: `${url} 2026-11-15T00:00:00Z`,
            },
          },
        ],
      },
    ],
  };
  expect(answerReadInterval(settled, 101)).toBe(60_000);
});
