import { expect, test } from "bun:test";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { queued } from "../fixture-line.ts";
import { fixture } from "../fixtures.ts";
import { prStanding } from "./pr-standing.ts";

class FixtureError extends Error {}

const clock = { nowMs: Date.parse("2026-11-08T12:00:00Z"), timeZone: "UTC" };

function line(name: Parameters<typeof fixture>[0]): LineSnapshot {
  const l = fixture(name).line;
  if (!l) throw new FixtureError(`Missing fixture line for ${name}`);
  return l;
}

const merged = {
  state: "MERGED" as const,
  title: "Done",
  isDraft: false,
  url: "https://github.com/acme/widget/pull/1",
  checkedAt: "2026-11-08T11:59:00.000Z",
};

test("a PR the line does not hold and the forge did not read is unknown, in words", () => {
  const s = prStanding(null, "acme/widget", 1, null, clock);
  expect(s.kind).toBe("unknown");
  expect(s.facts[0]).toContain("forge was not read");
});

test("a need names its cause and the reason the tick gave", () => {
  const l = line("loud");
  const need = l.needs.find((n) => n.pr !== null && n.stuckRecord == null);
  if (!need || need.pr === null)
    throw new FixtureError("No PR need in fixture");
  const s = prStanding(l, need.repo, need.pr, null, clock);
  expect(s.kind).toBe("needs-person");
  expect(s.tone).toBe("needs");
  expect(s.facts).toContain(need.reason);
});

test("a merged PR is done, and a failed follow-up on it still needs a person", () => {
  const l = line("loud");
  const need = l.needs.find((n) => n.pr !== null);
  if (!need || need.pr === null)
    throw new FixtureError("No PR need in fixture");
  l.needs = [{ ...need, stage: "followup", cause: "followup-failed" }];
  l.sessions = [];
  const s = prStanding(l, need.repo, need.pr, merged, clock);
  expect(s.tone).toBe("needs");
  expect(s.label).toBe("Merged; follow-up failed");
  expect(prStanding(null, "acme/widget", 1, merged, clock).kind).toBe("merged");
});

test("a forge read of an open draft outside the line is quiet", () => {
  const s = prStanding(
    null,
    "acme/widget",
    1,
    { ...merged, state: "OPEN", isDraft: true },
    clock,
  );
  expect(s.kind).toBe("draft");
  expect(s.tone).toBe("quiet");
});

const entry = (
  o: Partial<Parameters<typeof queued>[0]> & { holdWaited?: number },
) =>
  queued({
    source: "label drive",
    group: "starts",
    repo: "acme/widget",
    pr: 7,
    title: "Work",
    why: "waiting for a slot",
    ...o,
  });

function queueOnly(q: ReturnType<typeof queued>): LineSnapshot {
  const l = line("quiet");
  l.needs = [];
  l.sessions = [];
  l.queue = [q];
  return l;
}

test("a merged PR with a follow-up queued keeps the follow-up's progress", () => {
  const q = entry({ source: "merged" });
  const s = prStanding(queueOnly(q), "acme/widget", 7, merged, clock);
  expect(s.label).toBe("Merged; awaiting follow-up");
  expect(s.facts).toContain(q.why);
});

test("queued work the dispatcher reported or refused is not called queued", () => {
  const label = (group: "reported" | "never") =>
    prStanding(queueOnly(entry({ group })), "acme/widget", 7, null, clock)
      .label;
  expect(label("never")).toBe("Refused, will not start");
  expect(label("reported")).toBe("Reported, not started");
});

test("a held queue entry says how long it has waited", () => {
  const q = entry({
    source: "held",
    group: "held",
    hold: { leader: 1, area: "docs", waited: 2 * 3_600_000 },
  });
  const s = prStanding(queueOnly(q), "acme/widget", 7, null, clock);
  expect(s.facts.some((f) => f.startsWith("Waited "))).toBe(true);
});
