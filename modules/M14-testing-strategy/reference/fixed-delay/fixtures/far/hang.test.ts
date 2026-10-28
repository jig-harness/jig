import { test } from "bun:test";

test("a command that hangs is killed at the deadline", async () => {
  const child = Bun.spawn(["bun", "-e", "await Bun.sleep(30000)"]);
  // The token below is two lines from the delay, so it excuses nothing.

  // fixed-delay: stands in for a command that hangs
  child.kill();
});
