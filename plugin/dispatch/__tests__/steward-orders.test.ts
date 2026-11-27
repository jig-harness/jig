import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb } from "../lib/state.ts";
import {
  keepStewardRun,
  stewardRecords,
  submitStewardRecords,
  type RefusedOrder,
  type StewardDigest,
} from "../lib/steward.ts";
import {
  judgesOrders,
  orderByStewardRecords,
  refusedOrders,
  STEWARD_ORDERED,
  unshownRefusals,
} from "../lib/steward-orders.ts";
import type { WantedItem } from "../lib/types.ts";

const REPO = "example/repo";
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "steward-orders-"));
});
afterEach(() => {
  closeStateDb(root);
  rmSync(root, { recursive: true, force: true });
});

function item(key: string, createdAt = "2026-01-01T00:00:00Z"): WantedItem {
  return {
    key,
    title: "Task",
    url: null,
    state: "Todo",
    assignee: "alex",
    assignedBy: "writer",
    queueRank: { unblocks: 0 },
    queueIssue: {
      identifier: key,
      title: "Task",
      url: null,
      type: "task",
      priority: 2,
      size: "small",
      state: { id: "todo", name: "Todo", type: "unstarted" },
      createdAt,
      assignee: { id: "a", name: "alex" },
      labels: [],
      isEpic: false,
      hasOpenChildren: false,
      truncated: [],
    },
  };
}

/** Keep a run whose digest queue holds `keys` and lists `refused`, then submit `targets` as one order record. */
function submitOrder(
  run: string,
  keys: string[],
  targets: string[],
  refused: RefusedOrder[] = [],
): void {
  keepRun(run, keys, refused);
  const kept = submitStewardRecords(
    run,
    [{ kind: "order", targets, reason: "only age separates them" }],
    root,
  );
  expect(kept).toEqual({ ok: true, value: "submitted" });
}

function keepRun(
  run: string,
  keys: string[],
  refused: RefusedOrder[] = [],
): void {
  const digest: StewardDigest = {
    version: 1,
    repo: REPO,
    drives: [],
    needs: [],
    queue: keys.map((k) => item(k).queueIssue as never),
    passes: [],
    failures: [],
    load: null,
    refused,
  };
  keepStewardRun(run, digest, Date.now(), root);
}

test("an order for two wanted items created seconds apart is refused with its reason", () => {
  submitOrder("run-1", ["#11", "#12"], ["#12", "#11"]);
  const items = [
    item("#11", "2026-01-01T00:00:00Z"),
    item("#12", "2026-01-01T00:00:03Z"),
  ];
  const ordered = orderByStewardRecords(REPO, items, true, root);
  expect(ordered.map((i) => i.key)).toEqual(["#11", "#12"]);
  const [record] = stewardRecords(REPO, root);
  expect(record).toMatchObject({
    applied: true,
    effect: "refused",
    refusal: {
      reason: "#12 and #11 do not tie: their creation times differ",
    },
  });
});

test("an order naming an item the tick does not want is refused with its reason", () => {
  submitOrder("run-1", ["#11", "#12"], ["#12", "#11"]);
  orderByStewardRecords(REPO, [item("#11")], true, root);
  expect(stewardRecords(REPO, root)[0]).toMatchObject({
    effect: "refused",
    refusal: { reason: "#12 is not among the items this tick wants" },
  });
});

test("a tick that does not apply judges nothing, and a tied order is taken and kept ordering", () => {
  submitOrder("run-1", ["#1", "#2"], ["#2", "#1"]);
  const items = [item("#1"), item("#2")];
  expect(
    orderByStewardRecords(REPO, items, false, root).map((i) => i.key),
  ).toEqual(["#2", "#1"]);
  expect(stewardRecords(REPO, root)[0]).toMatchObject({
    applied: false,
    effect: null,
  });
  orderByStewardRecords(REPO, items, true, root);
  expect(stewardRecords(REPO, root)[0]).toMatchObject({
    applied: true,
    effect: STEWARD_ORDERED,
    refusal: null,
  });
  expect(
    orderByStewardRecords(REPO, items, true, root).map((i) => i.key),
  ).toEqual(["#2", "#1"]);
});

test("the next digest marks the refused order, and the same order on the same facts is not kept again", () => {
  submitOrder("run-1", ["#11", "#12"], ["#12", "#11"]);
  const items = [
    item("#11", "2026-01-01T00:00:00Z"),
    item("#12", "2026-01-01T00:00:03Z"),
  ];
  orderByStewardRecords(REPO, items, true, root);
  const refused = refusedOrders(REPO, items, root);
  expect(refused).toEqual([
    {
      record: 1,
      kind: "order",
      targets: ["#12", "#11"],
      refusal: "#12 and #11 do not tie: their creation times differ",
    },
  ]);

  submitOrder("run-2", ["#11", "#12"], ["#12", "#11"], refused);
  expect(stewardRecords(REPO, root)).toHaveLength(1);

  // Changed facts take the refusal out of the digest, so the steward's next order is kept.
  const changed = [item("#11"), item("#12")];
  expect(refusedOrders(REPO, changed, root)).toEqual([]);
  submitOrder("run-3", ["#11", "#12"], ["#12", "#11"], []);
  expect(stewardRecords(REPO, root)).toHaveLength(2);
});

test("only an applying tick with a complete read of the queue keeps its verdict", () => {
  expect(judgesOrders(true, { claimed: [] })).toBe(true);
  expect(judgesOrders(false, { claimed: [] })).toBe(false);
  expect(judgesOrders(true, { claimed: null })).toBe(false);
  expect(judgesOrders(true, { claimed: [], partial: true })).toBe(false);
});

test("an order outside its own digest is refused, and a later tick never changes a verdict", () => {
  submitOrder("run-1", ["#1"], ["#2", "#1"]);
  const items = [item("#1"), item("#2")];
  orderByStewardRecords(REPO, items, true, root);
  expect(stewardRecords(REPO, root)[0]).toMatchObject({
    effect: "refused",
    refusal: { reason: "the order names an item outside its own digest" },
  });
  orderByStewardRecords(REPO, [item("#1")], true, root);
  expect(stewardRecords(REPO, root)[0]?.refusal?.reason).toBe(
    "the order names an item outside its own digest",
  );
});

test("a taken order that stops tying stays taken and orders nothing while it does not tie", () => {
  submitOrder("run-1", ["#1", "#2"], ["#2", "#1"]);
  orderByStewardRecords(REPO, [item("#1"), item("#2")], true, root);
  const apart = [item("#1"), item("#2", "2026-02-01T00:00:00Z")];
  expect(
    orderByStewardRecords(REPO, apart, true, root).map((i) => i.key),
  ).toEqual(["#1", "#2"]);
  expect(stewardRecords(REPO, root)[0]).toMatchObject({
    effect: STEWARD_ORDERED,
    refusal: null,
  });
});

test("the digest lists the latest refusal per list of targets, and none once no target is wanted", () => {
  submitOrder("run-1", ["#1", "#2"], ["#2", "#1"]);
  submitOrder("run-2", ["#1", "#2"], ["#2", "#1"]);
  const items = [item("#1"), item("#2", "2026-01-01T00:00:03Z")];
  orderByStewardRecords(REPO, items, true, root);
  expect(refusedOrders(REPO, items, root).map((r) => r.record)).toEqual([2]);
  submitOrder("run-3", ["#7", "#8"], ["#8", "#7"]);
  orderByStewardRecords(REPO, items, true, root);
  expect(stewardRecords(REPO, root)[2]?.effect).toBe("refused");
  expect(refusedOrders(REPO, items, root).map((r) => r.record)).toEqual([2]);
});

test("a permutation of a refused order's targets is not kept again", () => {
  submitOrder("run-1", ["#11", "#12"], ["#12", "#11"]);
  const items = [
    item("#11", "2026-01-01T00:00:00Z"),
    item("#12", "2026-01-01T00:00:03Z"),
  ];
  orderByStewardRecords(REPO, items, true, root);
  const refused = refusedOrders(REPO, items, root);
  submitOrder("run-2", ["#11", "#12"], ["#11", "#12"], refused);
  expect(stewardRecords(REPO, root)).toHaveLength(1);
});

test("a refusal for an item outside its digest does not suppress the order once a later digest holds it", () => {
  submitOrder("run-1", ["#11"], ["#12", "#11"]);
  const outside = [item("#11"), item("#12")];
  orderByStewardRecords(REPO, outside, true, root);
  const refused = refusedOrders(REPO, outside, root);
  expect(refused).toHaveLength(1);
  submitOrder("run-2", ["#11", "#12"], ["#12", "#11"], refused);
  expect(stewardRecords(REPO, root)).toHaveLength(2);
});

test("a refusal no recent digest listed is owed a steward pass", () => {
  submitOrder("run-1", ["#11", "#12"], ["#12", "#11"]);
  const items = [
    item("#11", "2026-01-01T00:00:00Z"),
    item("#12", "2026-01-01T00:00:03Z"),
  ];
  orderByStewardRecords(REPO, items, true, root);
  expect(unshownRefusals(REPO, items, 20, root)).toBe(1);
  submitOrder("run-2", ["#11"], ["#11"], refusedOrders(REPO, items, root));
  expect(unshownRefusals(REPO, items, 20, root)).toBe(0);
});
