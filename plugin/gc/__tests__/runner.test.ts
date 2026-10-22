import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollection } from "../runner.ts";
import type { CollectionKind, Proof } from "../types.ts";

function fixture(
  proofs: Proof[],
  drop: () => void = () => {
    /* Report fixtures have no removal. */
  },
) {
  let index = 0;
  const kind: CollectionKind = {
    name: "scratch",
    repository: "/fixture",
    declaration: "fixture base",
    inventory: async () => [{ id: "one", bytes: 42 }],
    prove: async () => proofs[Math.min(index++, proofs.length - 1)] as Proof,
    collect: async () => {
      drop();
      return { outcome: "collected", reason: "removed" };
    },
    describe: (resource) => resource.id,
    exclusive: async (body) => body(),
  };
  return kind;
}
const dead: Proof = { state: "dead", reason: "owner exited" };

test("report writes a receipt and never collects", async () => {
  let drops = 0;
  const root = mkdtempSync(join(tmpdir(), "gc-receipt-"));
  const { receipt, path } = await runCollection(
    [fixture([dead], () => drops++)],
    { collect: false, receiptRoot: root },
  );
  expect(drops).toBe(0);
  expect(receipt.resources[0]?.outcome).toBe("would-collect");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(receipt);
});

test("a revived resource vetoes collection at the drop", async () => {
  let drops = 0;
  const root = mkdtempSync(join(tmpdir(), "gc-receipt-"));
  const { receipt } = await runCollection(
    [
      fixture(
        [dead, { state: "live", reason: "owner resumed" }],
        () => drops++,
      ),
    ],
    { collect: true, receiptRoot: root },
  );
  expect(drops).toBe(0);
  expect(receipt.resources[0]).toMatchObject({
    outcome: "refused",
    reason: "owner resumed",
  });
});

test("collection follows a fresh proof and records size and lifecycle evidence", async () => {
  let drops = 0;
  const { receipt } = await runCollection([fixture([dead], () => drops++)], {
    collect: true,
    receiptRoot: mkdtempSync(join(tmpdir(), "gc-receipt-")),
  });
  expect(drops).toBe(1);
  expect(receipt.resources[0]).toMatchObject({
    outcome: "collected",
    proof: "owner exited",
    bytes: 42,
  });
});

test("inventory and partial collection failures exit 1 and keep a receipt", async () => {
  const first = fixture([dead], () => {
    throw new Error("permission denied");
  });
  const second = fixture([dead]);
  second.inventory = async () => {
    throw new Error("cannot enumerate");
  };
  const { receipt } = await runCollection([first, second], {
    collect: true,
    receiptRoot: mkdtempSync(join(tmpdir(), "gc-receipt-")),
  });
  expect(receipt.exitStatus).toBe(1);
  expect(receipt.resources.map((r) => r.outcome)).toEqual([
    "failed",
    "unverified",
  ]);
});

test("unreadable proof preserves the resource without failing the whole kind", async () => {
  const kind = fixture([dead]);
  kind.prove = async () => {
    throw new Error("unreadable identity");
  };
  const { receipt } = await runCollection([kind], {
    collect: true,
    receiptRoot: mkdtempSync(join(tmpdir(), "gc-receipt-")),
  });
  expect(receipt.exitStatus).toBe(0);
  expect(receipt.resources[0]?.outcome).toBe("unverified");
});

test("collection intent and proof exist on disk before removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-intent-"));
  const kind = fixture([dead], () => {
    const day = readdirSync(root)[0] as string;
    const filename = readdirSync(join(root, day)).find((name) =>
      name.endsWith(".json"),
    ) as string;
    const pending = JSON.parse(readFileSync(join(root, day, filename), "utf8"));
    expect(pending.completed).toBe(false);
    expect(pending.resources[0]).toMatchObject({
      proof: "owner exited",
      outcome: "unverified",
      reason: "collection started; completion not yet recorded",
    });
  });
  const { receipt } = await runCollection([kind], {
    collect: true,
    receiptRoot: root,
  });
  expect(receipt.completed).toBe(true);
  // The checks above run inside collect, where a failure becomes an outcome.
  expect(receipt.resources[0]?.outcome).toBe("collected");
});

test("a receipt failure prevents every collection action", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-no-receipt-"));
  const file = join(root, "not-a-directory");
  writeFileSync(file, "occupied");
  let drops = 0;
  await expect(
    runCollection([fixture([dead], () => drops++)], {
      collect: true,
      receiptRoot: file,
    }),
  ).rejects.toThrow();
  expect(drops).toBe(0);
});
