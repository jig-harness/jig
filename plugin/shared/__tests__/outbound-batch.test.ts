import { expect, test } from "bun:test";
import { batch } from "../outbound/batch.ts";

test("reads unique keys in bounded chunks and preserves answer order", async () => {
  const calls: number[][] = [];
  const result = await batch([1, 2, 1, 3, 4, 5], 2, async (keys) => {
    calls.push([...keys]);
    return keys.map((key) => `answer-${key}`);
  });
  expect(calls).toEqual([[1, 2], [3, 4], [5]]);
  expect(result).toEqual([
    "answer-1",
    "answer-2",
    "answer-3",
    "answer-4",
    "answer-5",
  ]);
});

test("sends no request for no keys and refuses an invalid cap", async () => {
  let calls = 0;
  const read = async (_keys: readonly number[]) => {
    calls++;
    return [];
  };
  expect(await batch([], 2, read)).toEqual([]);
  await expect(batch([1], 0, read)).rejects.toThrow("positive integer");
  expect(calls).toBe(0);
});
