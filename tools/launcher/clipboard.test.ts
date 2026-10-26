import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the runner returns at the command's exit while a child it forked keeps its streams", async () => {
  // wl-copy and xclip fork a child that serves the clipboard.
  const { bin } = fakeCopier("sleep 3 &\nexit 0");
  const started = Date.now();
  expect(await copyRunner(bin)(["wl-copy"], "x", live())).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
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
