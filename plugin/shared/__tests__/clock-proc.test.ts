import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "../clock.ts";
import { ChildFailure, run, STDERR_TAIL_BYTES } from "../proc.ts";

describe("systemClock", () => {
  test("now reads the time", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  test("sleep waits at least the time asked", async () => {
    const start = performance.now();
    await systemClock.sleep(30);
    expect(performance.now() - start).toBeGreaterThanOrEqual(25);
  });

  test("sleep ends early, and leaves no listener, when its signal aborts", async () => {
    const controller = new AbortController();
    let listeners = 0;
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners--;
      remove(...args);
    }) as typeof signal.removeEventListener;
    await systemClock.sleep(1, signal);
    expect(listeners).toBe(0);
    const start = performance.now();
    const pending = systemClock.sleep(60_000, signal);
    controller.abort();
    await pending;
    expect(performance.now() - start).toBeLessThan(5_000);
    await systemClock.sleep(60_000, signal);
  });
});

describe("run's stderr tail", () => {
  const LAST = "the last line of the error output";
  const noisy = (code: number) => [
    process.execPath,
    "-e",
    `process.stderr.write("first line\\n" + "x".repeat(10000) + "\\n${LAST}\\n"); process.exit(${code});`,
  ];

  test("keeps the last 4 KiB of a failed child's error output", async () => {
    const r = await run(noisy(3));
    expect(r.code).toBe(3);
    expect(r.stderr).toStartWith("first line");
    expect(Buffer.byteLength(r.stderrTail)).toBe(STDERR_TAIL_BYTES);
    expect(r.stderrTail.trimEnd()).toEndWith(LAST);
    expect(r.stderrTail).not.toContain("first line");
  });

  test("is empty when the child succeeds", async () => {
    const r = await run(noisy(0));
    expect(r.code).toBe(0);
    expect(r.stderrTail).toBe("");
  });

  test("holds the reason a child could not start", async () => {
    const r = await run(["jig-no-such-command-for-this-test"]);
    expect(r.spawnFailed).toBe(true);
    expect(r.stderrTail).not.toBe("");
  });

  test("travels on a ChildFailure, which names the command but not its arguments", async () => {
    const argv = [...noisy(3)];
    const failure = new ChildFailure(argv, await run(argv));
    expect(failure.message).toBe(`${process.execPath} exited 3`);
    const result = await run(argv);
    expect(new ChildFailure(["gh", "api", "graphql"], result).command).toBe(
      "gh api",
    );
    expect(new ChildFailure(["gh", "--repo=o/r"], result).command).toBe("gh");
    expect(new ChildFailure(["git", "a=b"], result).command).toBe("git");
    expect(
      new ChildFailure(["curl", "https://user:secret@example.org/x"], result)
        .command,
    ).toBe("curl");
    expect(new ChildFailure(["/usr/bin/git", "fetch"], result).command).toBe(
      "/usr/bin/git fetch",
    );
    expect(
      new ChildFailure(["git", "https://user:secret@example.org/x"], result)
        .command,
    ).toBe("git");
    expect(failure.message).not.toContain("repeat");
    expect(failure.stderrTail.trimEnd()).toEndWith(LAST);
  });
});

describe("run's reapGroup", () => {
  test.skipIf(process.platform === "win32")(
    "stops a background job that holds the captured output open",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "jig-reap-"));
      try {
        const late = join(dir, "late.txt");
        const r = await run(["sh", "-c", `(sleep 1; touch '${late}') &`], {
          timeoutSec: 10,
          reapGroup: true,
        });
        expect(r.code).toBe(0);
        expect(r.groupSurvived).toBe(true);
        // The job would have written a second after the command returned.
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          expect(existsSync(late)).toBe(false);
          await Bun.sleep(200);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "reports nothing when the command leaves nothing behind",
    async () => {
      const r = await run(["sh", "-c", "true"], {
        timeoutSec: 10,
        reapGroup: true,
      });
      expect(r.code).toBe(0);
      expect(r.groupSurvived).toBe(false);
    },
  );
});
