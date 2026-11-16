import { expect, test } from "bun:test";
import { coalesce } from "../outbound/coalesce.ts";
import { httpTransport } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import { withLedgerWriter, type CallRecord } from "../outbound/ledger.ts";

test("identical concurrent and completed reads share their answer for one run", async () => {
  const reads = new Map<string, Promise<number>>();
  let sent = 0;
  const read = async () => ++sent;
  const first = coalesce(reads, "same", read);
  expect(coalesce(reads, "same", read)).toBe(first);
  expect(await first).toBe(1);
  expect(await coalesce(reads, "same", read)).toBe(1);
  expect(await coalesce(reads, "other", read)).toBe(2);
  expect(await coalesce(new Map(), "same", read)).toBe(3);
});

test("a failed read stays failed for the run, and invalidation permits a fresh read", async () => {
  const reads = new Map<string, Promise<string>>();
  let sent = 0;
  const read = async () => {
    sent += 1;
    if (sent === 1) throw new Error("offline");
    return "fresh";
  };
  await expect(coalesce(reads, "same", read)).rejects.toThrow("offline");
  await expect(coalesce(reads, "same", read)).rejects.toThrow("offline");
  expect(sent).toBe(1);
  reads.delete("same");
  expect(await coalesce(reads, "same", read)).toBe("fresh");
});

test("the transport ledger counts sends and cost before and after sharing identical reads", async () => {
  const events: CallRecord[] = [];
  const governor = budgetGovernor(memoryBudgetStore(), { share: () => null });
  const transport = httpTransport(
    "test-read-key",
    (async () =>
      new Response(JSON.stringify({ data: { value: 1 } }), {
        headers: { "x-complexity": "9" },
      })) as unknown as typeof fetch,
    governor,
  );
  const read = () => transport("query SharedReading { value }", {});
  await withLedgerWriter(
    (event) => events.push(event),
    async () => {
      await Promise.all([read(), read()]);
      const before = events.splice(0);
      expect(before.reduce((n, row) => n + (row.requests ?? 0), 0)).toBe(2);
      expect(before.reduce((n, row) => n + (row.cost ?? 0), 0)).toBe(18);
      const run = new Map();
      await Promise.all([
        coalesce(run, "reading", read),
        coalesce(run, "reading", read),
      ]);
    },
  );
  expect(events.map((row) => [row.operation, row.requests, row.cost])).toEqual([
    ["SharedReading", 1, 9],
  ]);
});
