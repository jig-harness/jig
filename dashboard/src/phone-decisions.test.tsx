import { ok as assert } from "node:assert/strict";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  frameStationDecision,
  stationOptionId,
} from "../../plugin/shared/decisions/station.ts";
import { choiceInText } from "../../plugin/shared/decision-card.ts";
import { sendTargetOf } from "./send-target.ts";
import { NoSendReason } from "./send.tsx";
import { ActedAnswers, AnsweredHolds } from "./needs.tsx";
import { confirmationSignature } from "./confirmation.ts";
import { decisionRows, rowAnswer, withText } from "./picking.ts";
import { needView } from "./needs-view.ts";
import { fixture } from "../fixtures.ts";
import { decisionOf } from "../../plugin/dispatch/lib/line-decision.ts";

const HOLD = "I'll handle it — hide this card";
test("hold tells the person the work stays undone and accepts both labels", () => {
  const { call } = frameStationDecision({
    kind: "drive",
    pr: 7,
    exit: "1",
    started: null,
    failedRearm: null,
  }).decision;
  const hold = call.options.find((o) => o.id === "hold");
  expect(hold?.name).toBe(HOLD);
  expect(hold?.summary).toContain(
    "Nothing is done; the work stays where it is.",
  );
  expect(stationOptionId("Leave it to me")).toBe("hold");
  expect(
    choiceInText(
      "choose Leave it to me",
      call.options,
      (o) => o.id === call.recommended,
      true,
    )?.option.id,
  ).toBe("hold");
  expect(
    choiceInText(
      `choose ${HOLD}`,
      [{ id: "hold", name: "Leave it to me" }],
      () => false,
      true,
    )?.option.name,
  ).toBe("Leave it to me");
  expect(
    choiceInText(
      "choose Leave it to me",
      [
        { id: "leave", name: "Leave it to me" },
        { id: "hide", name: HOLD },
      ],
      () => false,
    )?.option.id,
  ).toBe("leave");
});

test("station-card own words recognize the retired hold label as a choice", () => {
  const { decision } = frameStationDecision({
    kind: "drive",
    pr: 7,
    exit: "1",
    started: null,
    failedRearm: null,
  });
  const [row] = decisionRows([
    {
      ...decisionOf({ key: "drive", kind: "finding", lines: [], decision }),
      answer: {
        station: "drive",
        address: "drive@example-org/web#7",
        on: "pull-request",
        framedBy: "dispatcher",
      },
    },
  ]);
  assert(row);
  const answer = rowAnswer(
    row,
    withText(row, null, "free", "choose Leave it to me", 0),
  );
  expect(answer.fault).toContain("choosing");
  expect(answer.fault).toContain(HOLD);
});

test("a session option named hold has no dispatcher alias", () => {
  const [row] = decisionRows([
    {
      ...decisionOf({
        key: "session",
        kind: "finding",
        lines: [],
        decision: {
          schema: "parked-decision/v1",
          class: "scope",
          call: {
            id: "a",
            question: "Who should handle this?",
            options: [
              {
                id: "hold",
                name: HOLD,
                summary: "Hide it.",
                pay: ["Work remains."],
              },
              {
                id: "leave",
                name: "Leave it to me",
                summary: "Keep it.",
                pay: ["You do it."],
              },
            ],
            recommended: "leave",
            why: "The session owns this choice.",
          },
          steps: [],
          alreadyDone: "Read the request.",
        },
      }),
      answer: {
        station: "drive",
        address: "drive@example-org/web#7",
        on: "pull-request",
        framedBy: "session",
      },
    },
  ]);
  assert(row);
  expect(
    rowAnswer(row, withText(row, null, "free", "choose Leave it to me", 0))
      .fault,
  ).toContain("choosing Leave it to me");
});
test("station cards target the comment reader's issue or pull request", () => {
  for (const [on, url, pr] of [
    ["issue", "https://github.com/example-org/web/issues/17", null],
    ["pull-request", "https://github.com/example-org/web/pull/17", 17],
  ] as const) {
    expect(
      sendTargetOf({
        repo: "example-org/web",
        pr,
        url,
        parked: false,
        answerOn: on,
        target: pr === null ? "#17" : "PR #17",
      }),
    ).toEqual({ to: { repo: "example-org/web", number: 17 } });
  }
});
test("an option card without a token explains how to paste one", () => {
  const n = fixture("loud").line?.needs[0];
  assert(n);
  const need = needView(n, { nowMs: 0, timeZone: "UTC" });
  expect(
    renderToStaticMarkup(
      <NoSendReason
        hasToken={false}
        fault={null}
        need={{
          ...need,
          send: { to: { repo: "example-org/web", number: 17 } },
        }}
      />,
    ),
  ).toContain("Paste a GitHub token");
});

test("tick outcomes distinguish carried out, refused with detail, and held", () => {
  for (const [outcome, word] of [
    ["done", "carried out"],
    ["refused", "refused"],
    ["held", "held"],
  ] as const) {
    const html = renderToStaticMarkup(
      <ActedAnswers
        need={{
          acted: [
            {
              key: "pickup",
              option: "Release",
              author: "maintainer-a",
              outcome,
              detail: "The claim changed.",
            },
          ],
        }}
      />,
    );
    expect(html).toContain(word);
    expect(html).toContain("The claim changed.");
  }
  expect(
    renderToStaticMarkup(
      <AnsweredHolds
        line={{
          answeredHolds: [
            {
              repo: "example-org/web",
              target: "#17",
              why: "maintainer-a chose hold; it returns when its facts change",
            },
          ],
        }}
      />,
    ),
  ).toContain("maintainer-a chose hold");
});

test("confirmation changes with the note, destination, or credential", () => {
  const source = fixture("picks").line?.needs[0];
  assert(source);
  const n = needView(source, {
    nowMs: 0,
    timeZone: "UTC",
  });
  const row = n.rows[0];
  assert(row);
  const answer = rowAnswer(row, null);
  const before = confirmationSignature(n, [answer], 0);
  expect(
    confirmationSignature(n, [{ ...answer, note: "Only after review" }], 0),
  ).not.toBe(before);
  expect(
    confirmationSignature(
      { ...n, send: { to: { repo: "example-org/other", number: 17 } } },
      [answer],
      0,
    ),
  ).not.toBe(before);
  expect(confirmationSignature(n, [answer], 1)).not.toBe(before);
});

test("an issue destination is checked against its configured tracker repository", () => {
  const base = {
    repo: "example-org/web",
    pr: null,
    url: "https://github.com/example-org/tasks/issues/17",
    parked: false,
    answerOn: "issue" as const,
    answerRepository: "example-org/tasks",
    target: "#17",
  };
  expect(sendTargetOf(base)).toEqual({
    to: { repo: "example-org/tasks", number: 17 },
  });
  expect(
    "absent" in
      sendTargetOf({
        ...base,
        url: "https://github.com/example-org/other/issues/17",
      }),
  ).toBe(true);
  expect(
    "absent" in sendTargetOf({ ...base, answerRepository: "example-org/web" }),
  ).toBe(true);
});
