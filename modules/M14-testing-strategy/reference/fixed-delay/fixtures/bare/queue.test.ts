import { expect, test } from "bun:test";
import { enqueue, read } from "./queue";

test("a message arrives", async () => {
  enqueue("hello");
  await Bun.sleep(5000);
  expect(read()).toBe("hello");
});
