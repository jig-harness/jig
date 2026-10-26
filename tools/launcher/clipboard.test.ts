import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityOf, reapIdentities } from "../../lib/test-reap-children.ts";
import { clipboardCommands, copyRunner, copyToClipboard } from "./clipboard.ts";

const live = () => new AbortController().signal;

/** A directory holding a `wl-copy` that writes stdin to `taken`, then runs `then`. */
function fakeCopier(then: string) {
  const bin = mkdtempSync(join(tmpdir(), "clipboard-"));
  const taken = join(bin, "taken");
  writeFileSync(
    join(bin, "wl-copy"),
    `#!/bin/sh\ncat > '${taken}'\n${then}\n`,
    { mode: 0o755 },
  );
  return { bin, taken };
}

test("the runner finds the command on the PATH it is given, not this process's", async () => {
  const { bin, taken } = fakeCopier("exit 0");
  expect(await copyRunner(bin)(["wl-copy"], "hello", live())).toBe(true);
  expect(readFileSync(taken, "utf8")).toBe("hello");
  expect(await copyRunner(join(bin, "missing"))(["wl-copy"], "x", live())).toBe(
    false,
  );
});

/**
 * The pid `pidFile` names once its writer has finished it. The shell creates
 * the file before `echo` fills it, so an empty or partial file is waited out,
 * and contents that never name a process above init fail the test rather than
 * reach a signal: `process.kill(0, …)` signals the whole process group.
 */
async function writtenPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
    if (/^\d+\n$/.test(text) && Number(text) > 1) return Number(text);
    if (Date.now() > deadline)
      throw new Error(
        `${pidFile} never named a process: ${JSON.stringify(text)}`,
      );
    await Bun.sleep(20);
  }
}

/**
 * Ends the process `pidFile` names, with its descendants, and witnesses it
 * gone by the process table, which counts a zombie as gone.
 */
async function reap(pidFile: string) {
  if (!existsSync(pidFile)) return;
  const identity = await identityOf(await writtenPid(pidFile));
  if (identity === null) return;
  const report = await reapIdentities([identity]);
  if (report === null || report.survived.length > 0)
    throw new Error(`process ${identity.pid} was not witnessed gone`);
}

test("the runner returns at the command's exit while a child it forked keeps its streams", async () => {
  // wl-copy and xclip fork a child that serves the clipboard.
  const { bin } = fakeCopier(
    'sleep 30 &\necho $! > "$(dirname "$0")/child"\nexit 0',
  );
  try {
    const started = Date.now();
    expect(await copyRunner(bin)(["wl-copy"], "x", live())).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await reap(join(bin, "child"));
  }
});

test("the runner returns once its signal aborts, from a command that ignores SIGTERM", async () => {
  const { bin } = fakeCopier(
    'trap \'\' TERM\necho $$ > "$(dirname "$0")/pid"\nexec sleep 30',
  );
  const launch = new AbortController();
  try {
    const started = Date.now();
    const copying = copyRunner(bin)(["wl-copy"], "x", launch.signal);
    await writtenPid(join(bin, "pid"));
    launch.abort();
    expect(await copying).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  } finally {
    await reap(join(bin, "pid"));
  }
});

test("each platform's clipboard commands are tried in turn, and the first that takes the text wins", async () => {
  const tried: string[] = [];
  const took = await copyToClipboard(
    "hello",
    live(),
    "linux",
    async (argv, text) => {
      tried.push(`${argv.join(" ")}:${text}`);
      return argv[0] === "xclip";
    },
  );
  expect(took).toBe("xclip");
  expect(tried).toEqual(["wl-copy:hello", "xclip -selection clipboard:hello"]);
});

test("no command that takes the text is null", async () => {
  expect(
    await copyToClipboard("x", live(), "darwin", async () => false),
  ).toBeNull();
  expect(clipboardCommands("darwin")).toEqual([["pbcopy"]]);
  expect(clipboardCommands("win32")).toEqual([["clip"]]);
});

test("a cancelled launch tries no further command, and each command gets the launch's signal", async () => {
  const launch = new AbortController();
  const tried: string[] = [];
  const took = await copyToClipboard(
    "x",
    launch.signal,
    "linux",
    async (argv, _text, signal) => {
      tried.push(argv[0] ?? "");
      expect(signal).toBe(launch.signal);
      launch.abort();
      return false;
    },
  );
  expect(took).toBeNull();
  expect(tried).toEqual(["wl-copy"]);
});
