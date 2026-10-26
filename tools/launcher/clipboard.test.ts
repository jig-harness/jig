import { expect, test } from "bun:test";
import { clipboardCommands, copyToClipboard } from "./clipboard.ts";

test("each platform's clipboard commands are tried in turn, and the first that takes the text wins", async () => {
  const tried: string[] = [];
  const took = await copyToClipboard("hello", "linux", async (argv, text) => {
    tried.push(`${argv.join(" ")}:${text}`);
    return argv[0] === "xclip";
  });
  expect(took).toBe("xclip");
  expect(tried).toEqual(["wl-copy:hello", "xclip -selection clipboard:hello"]);
});

test("no command that takes the text is null", async () => {
  expect(await copyToClipboard("x", "darwin", async () => false)).toBeNull();
  expect(clipboardCommands("darwin")).toEqual([["pbcopy"]]);
  expect(clipboardCommands("win32")).toEqual([["clip"]]);
});
