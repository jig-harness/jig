import { expect, it } from "bun:test";
import { run } from "../proc.ts";

it("keeps no more than the buffer bound when one chunk crosses it", async () => {
  const done = await run(
    ["bun", "-e", "process.stdout.write('x'.repeat(50000))"],
    { timeoutSec: 20, maxBufferBytes: 100 },
  );
  expect(done.bufferExceeded).toBe(true);
  expect(Buffer.byteLength(done.stdout)).toBeLessThanOrEqual(100);
});
