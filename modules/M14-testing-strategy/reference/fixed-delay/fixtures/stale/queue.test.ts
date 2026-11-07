import { expect, test } from "bun:test";
import { pollUntil } from "./poll-until";
import { enqueue, read } from "./queue";

test("a message arrives", async () => {
  enqueue("hello");
  // fixed-delay: the queue needs a moment to deliver
  const message = await pollUntil({
    check: () => read(),
    waitingFor: "the message to arrive",
    deadlineMs: 5000,
    intervalMs: 50,
  });
  expect(message).toBe("hello");
});
