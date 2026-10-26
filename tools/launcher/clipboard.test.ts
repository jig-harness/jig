import { expect, test } from "bun:test";
import { clipboardCommands, copyToClipboard } from "./clipboard.ts";

const live = () => new AbortController().signal;

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
