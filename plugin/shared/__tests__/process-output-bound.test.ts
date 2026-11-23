import { expect, it } from "bun:test";
import { run } from "../proc.ts";

it("keeps no more than the buffer bound when one chunk crosses it", async () => {
  const done = await run(
    ["bun", "-e", "process.stdout.write('x'.repeat(50000))"],
    { timeoutSec: 20, maxBufferBytes: 100 },
  );
  expect(done.bufferExceeded).toBe(true);
  expect(done.stdout).toBe("x".repeat(100));
});

it("keeps a complete character that fits and drops one the bound cuts", async () => {
  const done = await run(
    ["bun", "-e", "process.stdout.write('\\u{FFFD}\\u00e9\\u00e9\\u00e9')"],
    { timeoutSec: 20, maxBufferBytes: 6 },
  );
  expect(done.bufferExceeded).toBe(true);
  // U+FFFD takes three bytes and each e-acute two: the bound's sixth byte is the first byte of the second e-acute, so that character is dropped.
  expect(done.stdout).toBe("\u{FFFD}\u00e9");
});
