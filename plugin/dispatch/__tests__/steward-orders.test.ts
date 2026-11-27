import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb } from "../lib/state.ts";
import {
  keepStewardRun,
  stewardRecords,
  submitStewardRecords,
  type StewardDigest,
} from "../lib/steward.ts";
import {
  orderByStewardRecords,
  refusedOrders,
  STEWARD_ORDERED,
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
  refused: StewardDigest["refused"] = [],
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
  const kept = submitStewardRecords(
    run,
    [{ kind: "order", targets, reason: "only age separates them" }],
    root,
  );
  expect(kept).toEqual({ ok: true, value: "submitted" });
}

test("an order for two wanted items created seconds apart is refused with its reason", () => {
  submitOrder("run-1", ["#924", "#925"], ["#925", "#924"]);
  const items = [
    item("#924", "2026-01-01T00:00:00Z"),
    item("#925", "2026-01-01T00:00:03Z"),
  ];
  const ordered = orderByStewardRecords(REPO, items, true, root);
  expect(ordered.map((i) => i.key)).toEqual(["#924", "#925"]);
  const [record] = stewardRecords(REPO, root);
  expect(record).toMatchObject({
    applied: true,
    effect: "refused",
    refusal: {
      reason: "#925 and #924 do not tie: their creation times differ",
    },
  });
});

test("an order naming an item the tick does not want is refused with its reason", () => {
  submitOrder("run-1", ["#924", "#925"], ["#925", "#924"]);
  orderByStewardRecords(REPO, [item("#924")], true, root);
  expect(stewardRecords(REPO, root)[0]).toMatchObject({
    effect: "refused",
    refusal: { reason: "#925 is not among the items this tick wants" },
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
  submitOrder("run-1", ["#924", "#925"], ["#925", "#924"]);
  const items = [
    item("#924", "2026-01-01T00:00:00Z"),
    item("#925", "2026-01-01T00:00:03Z"),
  ];
  orderByStewardRecords(REPO, items, true, root);
  const refused = refusedOrders(REPO, items, root);
  expect(refused).toEqual([
    {
      record: 1,
      kind: "order",
      targets: ["#925", "#924"],
      refusal: "#925 and #924 do not tie: their creation times differ",
    },
  ]);

  submitOrder("run-2", ["#924", "#925"], ["#925", "#924"], refused);
  expect(stewardRecords(REPO, root)).toHaveLength(1);

  // Changed facts take the refusal out of the digest, so the steward's next order is kept.
  const changed = [item("#924"), item("#925")];
  expect(refusedOrders(REPO, changed, root)).toEqual([]);
  submitOrder("run-3", ["#924", "#925"], ["#925", "#924"], []);
  expect(stewardRecords(REPO, root)).toHaveLength(2);
});
