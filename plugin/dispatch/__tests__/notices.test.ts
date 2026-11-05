import { expect, test } from "bun:test";
import { type Cause, fitting } from "../lib/actions/notify.ts";
import type { Workspace } from "../lib/runtime/port.ts";
import { failed, ok } from "../../shared/outcome.ts";
import {
  type ListedClaim,
  standing,
} from "../../shared/records/forge-claims.ts";
import { FOLLOWUP_CLAIM, markerStanding } from "../lib/followup-marker.ts";
import { parkNotice } from "../lib/notices.ts";
import type { DrivenPr } from "../lib/types.ts";

function parked(lines: string[][]): DrivenPr {
  return {
    number: 9,
    title: "t",
    url: "https://example.test/pull/9",
    why: "w",
    evidence: { generation: 3 },
    waiting: lines.map((l, i) => ({ kind: "thread", key: `k${i}`, lines: l })),
  } as unknown as DrivenPr;
}

test("a park message cut to its bound keeps the answer instructions and the URL", () => {
  const long = ["x".repeat(2500)];
  const { text } = parkNotice("o/r", parked([long, long, long]));
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("answer <key>");
  expect(text.endsWith("https://example.test/pull/9")).toBe(true);
});

const TICK = { kind: "tick", record: "r1" } as const;
const AT = "2026-11-04T09:30:00.000Z";

/** A trusted follow-up marker, as the forge-claims module lists one; `null` for one whose record does not read. */
function marker(id: number, payload: Record<string, unknown> | null) {
  return {
    id,
    login: "drive-bot",
    association: "MEMBER",
    createdAt: AT,
    trusted: true,
    record:
      payload === null
        ? failed("unreadable", "its record does not read")
        : ok({
            key: "followup",
            at: AT,
            payload: { pr: 9, ...payload },
            legacy: false,
          }),
  } satisfies ListedClaim;
}

/** How marker 7, just posted, stands in `listing`. */
const seen = (listing: ListedClaim[]) =>
  ok(standing(FOLLOWUP_CLAIM, listing, { id: 7, key: "followup", at: AT }));

const tick = (record: string) => ({ run: "tick", record });
const manual = (outcome: string) => ({ run: "manual", outcome });

test("a read-back that lacks the posted marker reports it missing", () => {
  expect(markerStanding(seen([marker(9, tick("r1"))]), TICK).kind).toBe(
    "missing",
  );
  expect(
    markerStanding(seen([marker(7, tick("r1")), marker(9, tick("r2"))]), TICK)
      .kind,
  ).toBe("stands");
});

test("an earlier trusted marker wins, whatever its record says", () => {
  const back = markerStanding(
    seen([marker(5, null), marker(7, tick("r1"))]),
    TICK,
  );
  expect(back.kind === "earlier" && back.marker.id).toBe(5);
});

test("a posted marker edited to another body is not the claim", () => {
  expect(markerStanding(seen([marker(7, null)]), TICK).kind).toBe("altered");
  expect(markerStanding(seen([marker(7, tick("r2"))]), TICK).kind).toBe(
    "altered",
  );
});

test("a manual claim marked done between the post and the read-back is kept, not altered", () => {
  const running = [marker(7, manual("running"))];
  const done = [marker(7, manual("done"))];
  expect(markerStanding(seen(running), { kind: "manual" }).kind).toBe("stands");
  expect(markerStanding(seen(done), { kind: "manual" }).kind).toBe("done");
  expect(markerStanding(seen(done), TICK).kind).toBe("altered");
});

test("a notice key longer than its bound is cut and still tells two keys apart", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `ws-${i}`).join(", ");
  const a = parkNotice(`o/r ${ids(2000)}`, parked([["a"]]));
  const b = parkNotice(`o/r ${ids(1999)}`, parked([["a"]]));
  expect(a.key.length).toBeLessThanOrEqual(200);
  expect(a.text.length).toBeLessThanOrEqual(4000);
  expect(a.key).not.toBe(b.key);
});

test("a notice that does not fit beside an unread comment waits and a later one that fits goes", () => {
  const cause = (n: number) =>
    ({ notice: { key: `k${n}`, text: "x".repeat(n) } }) as unknown as Cause;
  const workspace = {
    unread: true,
    comment: `[jig dispatch: old]\n${"y".repeat(15_000)}`,
  } as unknown as Workspace;
  const { send, later } = fitting(workspace, [cause(2000), cause(500)]);
  expect(send.map((c) => c.notice.key)).toEqual(["k500"]);
  expect(later.map((c) => c.notice.key)).toEqual(["k2000"]);
});

test("a read notices card keeps its marks in the budget, so a full batch is cut to what fits", () => {
  const mark = "⚙ dispatched · notices";
  const cause = (n: number) =>
    ({ notice: { key: `k${n}`, text: "x".repeat(n) } }) as unknown as Cause;
  const workspace = {
    unread: false,
    comment: mark,
  } as unknown as Workspace;
  const batch = [4000, 4000, 4000, 3980].map(cause);
  const { send, later } = fitting(workspace, batch);
  const joined = send.map((c) => c.notice.text).join("\n\n");
  expect(`${mark}\n\n${joined}`.length).toBeLessThanOrEqual(16_000);
  expect(later.length).toBeGreaterThan(0);
});

test("a decision quoting a key line never reads as a message of its own", () => {
  const { text } = parkNotice(
    "o/r",
    parked([["quoted:", "", "[jig dispatch: b]", "more"]]),
  );
  expect(text.match(/\[jig dispatch: /g)?.length).toBe(1);
});
