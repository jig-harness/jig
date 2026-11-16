import { expect, test } from "bun:test";
import { decisionDigest } from "../decisions/digest.ts";
import { dispatcherDecisionDigest } from "../decisions/station-digest.ts";
import {
  frameStationDecision,
  type StationDecision,
} from "../decisions/station.ts";

const frame = () =>
  frameStationDecision({
    kind: "drive",
    pr: 7,
    exit: "1",
    started: null,
    failedRearm: null,
  });

test("dispatcher identity aliases only the exact hold display pair, retaining every other field", () => {
  const framed = frame();
  const digest = dispatcherDecisionDigest(framed);
  const legacy = structuredClone(framed.decision);
  const hold = legacy.call.options.find((o) => o.id === "hold");
  expect(hold).toBeDefined();
  if (hold === undefined) return;
  hold.name = "Leave it to me";
  hold.summary =
    "The dispatcher takes no step on it for these facts and stops listing it under Needs you; it lists it again when they change.";
  expect(digest).toBe(decisionDigest(legacy));
  // A session's ordinary content digest does not alias the display pair.
  expect(decisionDigest(framed.decision)).not.toBe(digest);
  const changes: Array<(f: StationDecision) => void> = [
    (f) => {
      f.decision.call.question += " Changed";
    },
    (f) => {
      f.decision.alreadyDone += " Changed";
    },
    (f) => {
      for (const o of f.decision.call.options)
        if (o.id === "hold") o.name += " Changed";
    },
    (f) => {
      for (const o of f.decision.call.options)
        if (o.id === "hold") o.summary += " Changed";
    },
    (f) => {
      for (const o of f.decision.call.options)
        if (o.id === "hold") o.pay.push("Another cost");
    },
    (f) => {
      for (const o of f.decision.call.options)
        if (o.id !== "hold") o.summary += " Changed";
    },
  ];
  for (const change of changes) {
    const edited = frame();
    change(edited);
    expect(dispatcherDecisionDigest(edited)).not.toBe(digest);
  }
});
