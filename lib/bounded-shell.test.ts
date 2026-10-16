import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell, timeoutSec } from "./bounded-shell.ts";

const cwd = tmpdir();

test("a command past its deadline is killed and reported as timed out", async () => {
  const started = Date.now();
  const result = await runShell("sleep 30", { cwd, timeoutSec: 0.5 });
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).toBe(-1);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a command the shell cannot parse is reported, not thrown", async () => {
  const result = await runShell("echo (", { cwd });
  expect(result.cannotParse).toBe(true);
  expect(result.timedOut).toBe(false);
});

test("an ordinary command keeps its exit code and output", async () => {
  const result = await runShell("echo 7; exit 3", { cwd });
  expect(result).toMatchObject({
    exitCode: 3,
    stdout: "7\n",
    stdoutTruncated: false,
    timedOut: false,
    cannotParse: false,
  });
});

/** A Bun command line for the shell, its path in forward slashes on every platform. */
const bun = (script: string) =>
  `"${process.execPath.replaceAll("\\", "/")}" -e "${script}"`;

/** Whether a process is still alive, polled until it is gone or the deadline passes. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

// The command's end ends the descendant where the shell counts the command
// ended once its own process exits, and the deadline does elsewhere.
test("an external descendant holding the output is ended, by the command's end or the deadline", async () => {
  const started = Date.now();
  const result = await runShell(
    bun(
      "const c = Bun.spawn([process.execPath, '-e', 'console.log(process.pid); setTimeout(() => {}, 30000)'], { stdout: 'pipe', stderr: 'inherit' }); const { value } = await c.stdout.getReader().read(); process.stdout.write(value); process.exit(0)",
    ),
    { cwd, timeoutSec: 1 },
  );
  expect(Date.now() - started).toBeLessThan(10_000);
  const pid = Number(result.stdout.trim());
  expect(pid).toBeGreaterThan(0);
  expect(await goneWithin(pid, 5_000)).toBe(true);
}, 20_000);

test("output past what is kept is reported as truncated", async () => {
  const long = await runShell(bun("process.stdout.write('x'.repeat(70000))"), {
    cwd,
  });
  expect(long.stdoutTruncated).toBe(true);
  expect(long.stdout.length).toBe(64 * 1024);
  const short = await runShell("echo 7", { cwd });
  expect(short.stdoutTruncated).toBe(false);
  expect(short.stderrTruncated).toBe(false);
});

// Windows runs the command inside the child, which keeps its output.
test.skipIf(process.platform === "win32")(
  "the child holds a command's output no longer than it takes to pass it on",
  () => {
    const peak = (command: string) =>
      Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "bounded-shell.ts"), command],
        { cwd, stdout: "ignore", stderr: "ignore" },
      ).resourceUsage.maxRSS;
    // Compared with a command that prints nothing, so the unit cancels out.
    expect(peak("yes | head -c 200000000")).toBeLessThan(3 * peak("true"));
  },
  60_000,
);

test("the deadline comes from the environment and refuses nonsense", () => {
  expect(timeoutSec({})).toBe(1800);
  expect(timeoutSec({ JIG_COMMAND_TIMEOUT_SEC: "5" })).toBe(5);
  expect(() => timeoutSec({ JIG_COMMAND_TIMEOUT_SEC: "0" })).toThrow(
    "positive number",
  );
  expect(() => timeoutSec({ JIG_COMMAND_TIMEOUT_SEC: "soon" })).toThrow(
    "positive number",
  );
});
