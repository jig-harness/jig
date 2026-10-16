/**
 * drive-pr's process layer (`scripts/lib/proc.ts`) is built on the plugin's
 * shared one, not a copy of it: the timeout reader is the same function, and
 * loading both modules in one process installs one cancellation forwarder per
 * signal, with one registry of process groups behind it.
 */
import { expect, it } from "bun:test";
import { join } from "node:path";
import * as review from "../../../shared/proc.ts";
import * as drive from "../scripts/lib/proc.ts";

it("re-exports the shared timeout reader rather than a copy", () => {
  expect(drive.readTimeoutEnv).toBe(review.readTimeoutEnv);
});

it("one forwarder per cancellation signal with both modules loaded", () => {
  const driveProc = join(import.meta.dir, "..", "scripts", "lib", "proc.ts");
  const reviewProc = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "shared",
    "proc.ts",
  );
  const r = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(driveProc)});
await import(${JSON.stringify(reviewProc)});
console.log(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s)).join(","));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString().trim()).toBe("1,1,1");
});

// POSIX process groups and pgrep.
it.skipIf(process.platform === "win32")(
  "a deadlined child is cancelled through the shared registry",
  async () => {
    // A child with a deadline runs in its own process group, which only the
    // forwarder can reach. Cancel the parent while the child sleeps: the child
    // must be gone once the parent is.
    const driveProc = join(import.meta.dir, "..", "scripts", "lib", "proc.ts");
    const parent = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { run } = await import(${JSON.stringify(driveProc)});
const p = run(["sleep", "29.731"], { timeoutSec: 60 });
setTimeout(() => {}, 60000);
await new Promise((r) => setTimeout(r, 300));
console.log("ready");
await p;`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = parent.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("ready");
    const pgrep = () =>
      Bun.spawnSync(["pgrep", "-f", "^sleep 29.731$"], { stdout: "pipe" })
        .stdout.toString()
        .trim();
    expect(pgrep()).not.toBe("");
    parent.kill("SIGTERM");
    await parent.exited;
    await Bun.sleep(500);
    expect(pgrep()).toBe("");
  },
  20_000,
);

it("uses the shared command-line boundary, so a shared refusal keeps its exit code", async () => {
  const sharedCli = await import("../../../shared/cli.ts");
  const driveCli = await import("../scripts/lib/cli.ts");
  expect(driveCli.ExitError).toBe(sharedCli.ExitError);
  expect(driveCli.runMain).toBe(sharedCli.runMain);
  expect(driveCli.fail).toBe(sharedCli.fail);
});
