/**
 * `push-hold-recheck.ts` and the pre-push hook entry that runs it.
 *
 * The end-to-end probe — a hold sent DURING a guarded push's hook window
 * aborts that push — lives in `drive-pr-round.test.ts`'s `guarded-push.ts`
 * block, next to the fake-`git` harness it needs. This file owns the two
 * halves that need no such harness: the script's own contract, and the
 * documented hook entry run the way a hook manager runs it. Where the entry
 * sits in a repository's hook order is that repository's wiring (it must run
 * last, so nothing after it reopens the window it closes).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  appendDirective,
  holdAbortUnmarkedSentinel,
  inboxPath,
} from "../scripts/lib/state/mailbox.ts";
import { recheckHookEntry } from "./push-hold-recheck-hook.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");

async function runScript(env: Record<string, string>) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "push-hold-recheck.ts")), {
    // Not `...process.env` alone: an ambient DRIVE_PR_* from a live drive
    // running this suite would otherwise leak into the probe.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...env,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
}

describe("push-hold-recheck.ts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drive-pr-hold-recheck-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const armed = (pr = "999") => ({
    DRIVE_PR_HOLD_RECHECK_PR: pr,
    DRIVE_PR_MAILBOX_DIR: dir,
  });

  it("is a no-op when the push was not armed by guarded-push.ts", async () => {
    // A hold IS active — proving the script did not so much as look.
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = await runScript({ DRIVE_PR_MAILBOX_DIR: dir });
    expect(r.exitCode).toBe(0);
  });

  it("passes when no hold was ever sent", async () => {
    const r = await runScript(armed());
    expect(r.exitCode).toBe(0);
  });

  it("aborts (exit 17) while a hold-push directive is active, naming how to clear it", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = await runScript(armed());
    expect(r.exitCode).toBe(17);
    expect(r.stderr).toContain("hold-push");
    expect(r.stderr).toContain("--command resume --target hold-push");
  });

  it("passes again once a matching resume clears the hold", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    await appendDirective(dir, "999", "orchestrator", "resume", {
      target: "hold-push",
    });
    const r = await runScript(armed());
    expect(r.exitCode).toBe(0);
  });

  it("is not stopped by another PR's hold", async () => {
    await appendDirective(dir, "111", "orchestrator", "hold-push");
    const r = await runScript(armed("999"));
    expect(r.exitCode).toBe(0);
  });

  it("canonicalizes a zero-padded PR the way `mailbox.ts send` stores it", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = await runScript(armed("0999"));
    expect(r.exitCode).toBe(17);
  });

  it("fails closed on a directive log it cannot parse", async () => {
    // A torn tail — the interrupted-write artifact `foldGateState` refuses
    // to guess about. Unknown hold state must never read as "no hold".
    writeFileSync(inboxPath(dir), '{"id":"m-1","ts":"2026-01-01T00:0');
    const r = await runScript(armed());
    expect(r.exitCode).toBe(17);
  });

  it("fails closed AND marks the abort when the mailbox state cannot be read at all", async () => {
    // A mailbox "directory" that is a regular file: resolving/locking it
    // throws rather than folding to a hold. The throw must take the same
    // marked-abort path, so the wrapper reports exit 17, not a generic 1.
    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "x");
    const marker = join(dir, "aborted-unreadable");
    const r = await runScript({
      DRIVE_PR_HOLD_RECHECK_PR: "999",
      DRIVE_PR_MAILBOX_DIR: notADir,
      DRIVE_PR_HOLD_RECHECK_ABORT_FILE: marker,
    });
    expect(r.exitCode).toBe(17);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain("could not be read");
  });

  it("refuses when the PR variable is set but EMPTY (set is not unset)", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = await runScript(armed(""));
    expect(r.exitCode).toBe(2);
  });

  it("marks its own hold abort in the file guarded-push.ts named, and only then", async () => {
    const marker = join(dir, "aborted");
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const held = await runScript({
      ...armed(),
      DRIVE_PR_HOLD_RECHECK_ABORT_FILE: marker,
    });
    expect(held.exitCode).toBe(17);
    expect(existsSync(marker)).toBe(true);

    const clear = join(dir, "clear-marker");
    await appendDirective(dir, "999", "orchestrator", "resume", {
      target: "hold-push",
    });
    const ok = await runScript({
      ...armed(),
      DRIVE_PR_HOLD_RECHECK_ABORT_FILE: clear,
    });
    expect(ok.exitCode).toBe(0);
    expect(existsSync(clear)).toBe(false);
  });

  it("still aborts (17) and says so in-band when the abort marker cannot be written", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    // A path under a directory that does not exist: writeFileSync throws.
    const r = await runScript({
      ...armed(),
      DRIVE_PR_HOLD_RECHECK_ABORT_FILE: join(dir, "no-such-dir", "marker"),
      DRIVE_PR_HOLD_RECHECK_NONCE: "n-123",
    });
    expect(r.exitCode).toBe(17);
    expect(r.stderr).toContain(holdAbortUnmarkedSentinel("n-123"));
    // A sentinel without this push's nonce would be forgeable.
    expect(holdAbortUnmarkedSentinel("n-123")).not.toBe(
      holdAbortUnmarkedSentinel("other"),
    );
  });

  it("refuses when the PR variable is set but is not a PR number", async () => {
    const r = await runScript(armed("not-a-pr"));
    expect(r.exitCode).toBe(2);
  });
});

describe("the pre-push hook entry for the hold recheck", () => {
  describe("the entry itself, run the way the hook runs it", () => {
    const run = (env: Record<string, string>) => {
      return Bun.spawnSync(["sh", "-c", recheckHookEntry()], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...env,
        },
        stdout: "ignore",
        stderr: "pipe",
      });
    };
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "drive-pr-hold-recheck-hook-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("skips before bun starts when the push was not armed", () => {
      // The script itself also returns 0 when unarmed, so exit 0 alone would
      // not tell a shell-level skip from a bun start on every developer
      // push — the cost the entry's gate exists to avoid. A `bun` that
      // records its invocation and fails distinguishes them: the entry must
      // exit 0 without ever having run it.
      const stubDir = mkdtempSync(join(tmpdir(), "drive-pr-hold-recheck-bun-"));
      try {
        const ran = join(stubDir, "bun-ran");
        writeFakeProgram(
          join(stubDir, "bun"),
          `#!/bin/sh\n: > "${ran}"\nexit 99\n`,
        );
        const r = run({
          PATH: [
            stubDir,
            dirname(Bun.which("sh") ?? "/bin/sh"),
            "/usr/bin",
            "/bin",
          ].join(delimiter),
        });
        expect(r.exitCode).toBe(0);
        expect(existsSync(ran)).toBe(false);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it("aborts the push (non-zero) when armed and a hold is active", async () => {
      await appendDirective(dir, "999", "orchestrator", "hold-push");
      const r = run({
        DRIVE_PR_HOLD_RECHECK_PR: "999",
        DRIVE_PR_MAILBOX_DIR: dir,
      });
      expect(r.exitCode).toBe(17);
      expect(r.stderr.toString()).toContain("hold-push");
    });

    it("lets the push through when armed and no hold is active", () => {
      const r = run({
        DRIVE_PR_HOLD_RECHECK_PR: "999",
        DRIVE_PR_MAILBOX_DIR: dir,
      });
      expect(r.exitCode).toBe(0);
    });
  });
});
