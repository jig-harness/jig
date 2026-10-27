import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Identity,
  identityOf,
  reapOwnedIdentities,
} from "../../lib/test-reap-children.ts";
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
 * Shell that waits until the fixture's directory holds a `release` file or is
 * gone, for 30 seconds at most. A fixture process runs this rather than a
 * plain sleep, so the test can end it by writing one file: that needs no pid
 * and no identity, and still works when taking the identity failed. The
 * directory's removal ends it too, because the run's temporary root can be
 * removed before the loop next looks for the file.
 */
const untilReleased =
  'd=$(dirname "$0"); n=0; while [ -d "$d" ] && [ ! -e "$d/release" ] && [ "$n" -lt 300 ]; do sleep 0.1; n=$((n + 1)); done';

/**
 * The identity of the process `pidFile` names, taken as soon as the process
 * has named itself and is still waiting for its release, so the pid names the
 * fixture and no process that reused it. Teardown reaps this identity rather
 * than reading the pid again.
 */
async function ownedIdentity(pidFile: string) {
  const pid = await writtenPid(pidFile);
  const identity = await identityOf(pid);
  if (identity === null)
    throw new Error(`process ${pid} ended before its identity was taken`);
  return identity;
}

/**
 * Ends the fixture's processes: releases them first, which needs nothing the
 * test may have failed to take, gives the owned process 2 seconds to leave on
 * its own, then reaps it, with its descendants, and fails the test unless
 * every one is witnessed gone.
 */
async function release(bin: string, identity: Identity | null) {
  writeFileSync(join(bin, "release"), "");
  if (identity === null) return;
  const deadline = Date.now() + 2_000;
  while (
    Date.now() < deadline &&
    (await identityOf(identity.pid))?.start === identity.start
  )
    await Bun.sleep(20);
  await reapOwnedIdentities([identity]);
}

test("the runner returns at the command's exit while a child it forked keeps its streams", async () => {
  // wl-copy and xclip fork a child that serves the clipboard.
  const { bin } = fakeCopier(
    `(${untilReleased}) &\necho $! > "$(dirname "$0")/child"\nexit 0`,
  );
  let child: Identity | null = null;
  try {
    const started = Date.now();
    const took = await copyRunner(bin)(["wl-copy"], "x", live());
    const elapsed = Date.now() - started;
    child = await ownedIdentity(join(bin, "child"));
    expect(took).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  } finally {
    await release(bin, child);
  }
});

test("the runner returns once its signal aborts, from a command that ignores SIGTERM", async () => {
  const { bin } = fakeCopier(
    `trap '' TERM\necho $$ > "$(dirname "$0")/pid"\n${untilReleased}`,
  );
  const launch = new AbortController();
  let command: Identity | null = null;
  try {
    const started = Date.now();
    const copying = copyRunner(bin)(["wl-copy"], "x", launch.signal);
    command = await ownedIdentity(join(bin, "pid"));
    launch.abort();
    expect(await copying).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  } finally {
    launch.abort();
    await release(bin, command);
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
