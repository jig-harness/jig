import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  classify,
  classifyLines,
  parseArgs,
  parsePatterns,
} from "./retry-classified.ts";

const gate = join(import.meta.dir, "retry-classified.ts"),
  fix = join(import.meta.dir, "fixtures"),
  bun = process.execPath,
  scratch = mkdtempSync(join(tmpdir(), "jig-retry-classified-"));
const transient = join(fix, "transient.txt"),
  permanent = join(fix, "permanent.txt");
let counters = 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync([bun, gate, ...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** A flaky command that fails `failures` times with `message`, and its run counter. */
function flaky(failures: number, message: string) {
  const counter = join(scratch, `counter-${counters++}`);
  const command = [
    bun,
    join(fix, "flaky.ts"),
    counter,
    String(failures),
    message,
  ];
  return { command, runs: () => Number(readFileSync(counter, "utf8")) };
}
const rateLimit = "error: API rate limit exceeded for installation ID 1234567.";
const forbidden = "error: Resource not accessible by integration (HTTP 403)";

test("a transient failure is retried until the command passes", () => {
  const { command, runs } = flaky(2, rateLimit);
  const result = run([
    "--transient",
    transient,
    "--attempts",
    "3",
    "--delay-ms",
    "1",
    ...command,
  ]);
  expectSpawnExit(result, 0, "transient then pass");
  expect(runs()).toBe(3);
  expect(result.stderr).toContain(
    "attempt 1 of 3 failed with a transient error",
  );
  expect(result.stderr).toContain(
    "attempt 2 of 3 failed with a transient error",
  );
  expect(result.stdout).toBe("attempt 3: done\n");
});

test("an error not classified as transient aborts at once with its message", () => {
  const { command, runs } = flaky(5, forbidden);
  const result = run([
    "--transient",
    transient,
    "--attempts",
    "3",
    "--",
    ...command,
  ]);
  expectSpawnExit(result, 1, "fatal");
  expect(runs()).toBe(1);
  expect(result.stderr).toContain(forbidden);
  expect(result.stderr).toContain(
    "not classified as transient; not retried, exit 1",
  );
  expect(result.stdout).toBe("attempt 1: working\n");
});

test("attempts run out: the last output, the count and the exit code", () => {
  const { command, runs } = flaky(5, rateLimit);
  const result = run([
    "--transient",
    transient,
    "--attempts",
    "2",
    "--delay-ms",
    "1",
    ...command,
  ]);
  expectSpawnExit(result, 1, "exhausted");
  expect(runs()).toBe(2);
  expect(result.stderr).toContain(rateLimit);
  expect(result.stderr).toContain("still failing after 2 attempt(s)");
});

test("a child's could-not-check status passes through unchanged", () => {
  const { command, runs } = flaky(
    1,
    "fixture-gate: could not check: input missing",
  );
  const result = run(["--transient", transient, ...command]);
  expectSpawnExit(result, 2, "could not check");
  expect(runs()).toBe(1);
  expect(result.stderr).toContain(
    "fixture-gate: could not check: input missing",
  );
});

test("a child's could-not-check is never retried, even beside a transient-looking line", () => {
  const { command, runs } = flaky(
    1,
    `fixture-gate: could not check\n${rateLimit}`,
  );
  const result = run(["--transient", transient, "--delay-ms", "1", ...command]);
  expectSpawnExit(result, 2, "could not check, transient-looking");
  expect(runs()).toBe(1);
  expect(result.stderr).toContain("could not check (exit 2); not retried");
});

test("a permanent pattern wins over a transient-looking line in the same output", () => {
  const mixed = `${rateLimit}\n${forbidden}`;
  const { command, runs } = flaky(5, mixed);
  const result = run([
    "--transient",
    transient,
    "--permanent",
    permanent,
    "--delay-ms",
    "1",
    ...command,
  ]);
  expectSpawnExit(result, 1, "permanent wins");
  expect(runs()).toBe(1);
  expect(result.stderr).toContain("failed with a permanent error");
  // Without the permanent list, any transient line authorizes the retry.
  const again = flaky(5, mixed);
  expectSpawnExit(
    run([
      "--transient",
      transient,
      "--delay-ms",
      "1",
      "--attempts",
      "2",
      ...again.command,
    ]),
    1,
    "no permanent list",
  );
  expect(again.runs()).toBe(2);
});

test("the delay doubles after each attempt, up to its ceiling", () => {
  const { command, runs } = flaky(3, rateLimit);
  const result = run([
    "--transient",
    transient,
    "--attempts",
    "4",
    "--delay-ms",
    "20",
    "--max-delay-ms",
    "30",
    ...command,
  ]);
  expectSpawnExit(result, 0, "backoff");
  expect(runs()).toBe(4);
  expect(
    [...result.stderr.matchAll(/retrying in (\d+) ms/g)].map((m) => m[1]),
  ).toEqual(["20", "30", "30"]);
  const defaults = parseArgs(["--transient", "t.txt", "gh"]);
  expect([defaults.delayMs, defaults.maxDelayMs]).toEqual([2000, 60_000]);
});

test("--delay-ms waits between attempts", () => {
  const { command, runs } = flaky(1, rateLimit);
  const before = Date.now();
  const result = run([
    "--transient",
    transient,
    "--delay-ms",
    "150",
    ...command,
  ]);
  expectSpawnExit(result, 0, "delay");
  expect(runs()).toBe(2);
  expect(Date.now() - before).toBeGreaterThanOrEqual(150);
});

test.skipIf(process.platform === "win32")(
  "a child killed by a signal is could-not-decide, not retried",
  () => {
    const result = run(["--transient", transient, bun, join(fix, "signal.ts")]);
    expectSpawnExit(result, 2, "signal");
    expect(result.stdout).toContain("started");
    expect(result.stderr).toContain(
      "killed by SIGTERM before it finished; not retried",
    );
  },
);

test("an executable that is not found is could-not-decide", () => {
  const result = run(["--transient", transient, "no-such-command-7f3a"]);
  expectSpawnExit(result, 2, "missing executable");
});

const recorded = (name: string) =>
  readFileSync(join(fix, "recorded", name), "utf8");

test("--classify answers for messages recorded from the real tool", () => {
  const limit = run(
    ["--transient", transient, "--classify"],
    recorded("rate-limit.txt"),
  );
  expectSpawnExit(limit, 0, "rate limit");
  expect(limit.stdout).toBe(
    "transient: ^error: API rate limit exceeded (The hosting service's rate limit: the quota refills, so the same call succeeds after a pause.)\n",
  );
  const reset = run(
    ["--transient", transient, "--classify"],
    recorded("reset.txt"),
  );
  expectSpawnExit(reset, 0, "reset");
  expect(reset.stdout).toStartWith("transient: connection reset by peer$");
  const denied = run(
    ["--transient", transient, "--classify"],
    recorded("forbidden.txt"),
  );
  expectSpawnExit(denied, 1, "forbidden");
  expect(denied.stdout).toBe("fatal: no transient pattern matches\n");
  const dns = run(
    ["--transient", transient, "--classify"],
    recorded("dns.txt"),
  );
  expectSpawnExit(dns, 0, "dns");
  expect(dns.stdout).toStartWith(
    "transient: ^fatal: unable to access '.*': Could not resolve host",
  );
  const missing = run(
    ["--transient", transient, "--permanent", permanent, "--classify"],
    recorded("not-found.txt"),
  );
  expectSpawnExit(missing, 1, "not found");
  expect(missing.stdout).toStartWith("fatal: permanent pattern matches");
  const forbiddenToo = run(
    ["--transient", transient, "--permanent", permanent, "--classify"],
    recorded("forbidden.txt"),
  );
  expectSpawnExit(forbiddenToo, 1, "forbidden, permanent");
});

test("--classify fails closed on an empty message", () => {
  const result = run(["--transient", transient, "--classify"], "  \n");
  expectSpawnExit(result, 2, "empty message");
  expect(result.stderr).toContain("nothing to classify");
});

const malformed: [string, string][] = [
  ["empty.txt", "no transient pattern"],
  ["comments-only.txt", "no transient pattern"],
  ["no-reason.txt", "pattern without a reason"],
  ["bad-pattern.txt", "does not compile"],
  ["does-not-exist.txt", "cannot read the pattern file"],
];
for (const [file, reason] of malformed)
  test(`a pattern file that is ${file} fails closed`, () => {
    const { command, runs } = flaky(0, "");
    const result = run(["--transient", join(fix, file), ...command]);
    expectSpawnExit(result, 2, file);
    expect(result.stderr).toContain(reason);
    expect(() => runs()).toThrow();
  });

for (const args of [
  [],
  [bun, "x.ts"],
  ["--transient", transient],
  ["--transient", transient, "--classify", bun, "x.ts"],
  ["--transient", transient, "--attempts", "0", bun, "x.ts"],
  ["--transient", transient, "--delay-ms", "soon", bun, "x.ts"],
  ["--transient", transient, "--frobnicate", bun, "x.ts"],
  [
    "--transient",
    transient,
    "--delay-ms",
    "50",
    "--max-delay-ms",
    "10",
    bun,
    "x.ts",
  ],
  ["--transient"],
  ["--transient", transient, "--permanent", "", bun, "x.ts"],
])
  test(`usage error: ${args.map((a) => a.replace(fix, "").replace(bun, "bun")).join(" ") || "(none)"}`, () => {
    const result = run(args);
    expectSpawnExit(result, 2, "usage");
    expect(result.stderr).toContain("usage:");
  });

test("parseArgs separates the options from the command", () => {
  const options = parseArgs([
    "--transient",
    "t.txt",
    "--attempts",
    "5",
    "gh",
    "--attempts",
    "1",
  ]);
  expect(options.command).toEqual(["gh", "--attempts", "1"]);
  expect(options.attempts).toBe(5);
  expect(
    parseArgs(["--transient", "t.txt", "--", "--odd-name"]).command,
  ).toEqual(["--odd-name"]);
});

test("classify reads the first matching line of a multi-line message", () => {
  const patterns = parsePatterns("# why\nfoo$\n\n# why\n^bar", "t");
  expect(classify("x\nbar y\nfoo", patterns)?.source).toBe("^bar");
  expect(classify("nothing here", patterns)).toBeUndefined();
  expect(classify("", patterns)).toBeUndefined();
});

test("parsePatterns keeps the reason of each group and needs one", () => {
  const patterns = parsePatterns("# a\n# b\nfoo\nbar\n\n# c\nbaz\n", "t");
  expect(patterns.map((p) => [p.source, p.reason])).toEqual([
    ["foo", "a b"],
    ["bar", "a b"],
    ["baz", "c"],
  ]);
  expect(() => parsePatterns("foo\n", "t")).toThrow(
    "t:1: pattern without a reason",
  );
  expect(() => parsePatterns("# a\nfoo\n\nbar\n", "t")).toThrow("t:4:");
  expect(() => parsePatterns("", "t")).toThrow("no transient pattern");
});

test("a permanent match anywhere decides; otherwise the first transient match", () => {
  const transientPatterns = parsePatterns("# why\nlimit", "t");
  const permanentPatterns = parsePatterns("# why\ndenied", "p", "permanent");
  expect(
    classifyLines(["limit", "denied"], transientPatterns, permanentPatterns)
      .permanent?.source,
  ).toBe("denied");
  expect(
    classifyLines(["limit", "ok"], transientPatterns, permanentPatterns)
      .transient?.source,
  ).toBe("limit");
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Poll until `ready` holds, failing after the deadline. */
async function until(ready: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

test.skipIf(process.platform === "win32")(
  "a cancelled wrapper stops the command, prints its output and does not retry",
  async () => {
    const pidFile = join(scratch, "hang.pid");
    const wrapper = Bun.spawn(
      [bun, gate, "--transient", transient, bun, join(fix, "hang.ts"), pidFile],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
      "the command to start",
    );
    const child = Number(readFileSync(pidFile, "utf8"));
    wrapper.kill("SIGTERM");
    expect(await wrapper.exited).toBe(2);
    expect(await new Response(wrapper.stdout).text()).toContain("started");
    expect(await new Response(wrapper.stderr).text()).toContain(
      "cancelled by SIGTERM during attempt 1; not retried",
    );
    await until(() => !alive(child), "the command to stop");
  },
);

test.skipIf(process.platform === "win32")(
  "a cancellation during the delay ends the wait, prints the attempt and does not retry",
  async () => {
    const { command, runs } = flaky(5, rateLimit);
    const wrapper = Bun.spawn(
      [bun, gate, "--transient", transient, "--delay-ms", "60000", ...command],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const reader = wrapper.stderr.getReader();
    let seen = "";
    const deadline = Date.now() + 10_000;
    while (!seen.includes("retrying in")) {
      if (Date.now() > deadline)
        throw new Error("timed out waiting for the delay");
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += new TextDecoder().decode(chunk.value);
    }
    const started = Date.now();
    wrapper.kill("SIGTERM");
    expect(await wrapper.exited).toBe(2);
    expect(Date.now() - started).toBeLessThan(10_000);
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    )
      seen += new TextDecoder().decode(chunk.value);
    expect(seen).toContain(
      "cancelled by SIGTERM before attempt 2; not retried",
    );
    expect(seen).toContain(rateLimit);
    expect(await new Response(wrapper.stdout).text()).toContain(
      "attempt 1: working",
    );
    expect(runs()).toBe(1);
  },
);

test("an output line too long to classify is not retried", () => {
  const result = run([
    "--transient",
    transient,
    "--permanent",
    permanent,
    "--delay-ms",
    "1",
    bun,
    join(fix, "long-line.ts"),
  ]);
  expectSpawnExit(result, 2, "long line");
  expect(result.stderr).toContain("could not be classified");
  expect(result.stderr).toContain("not retried");
});
