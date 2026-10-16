import { expect, test } from "bun:test";
import { strictOptions } from "./cli.ts";

const usage = "usage: example [--output <file>] [<input>]";
const options = { output: { type: "string" } } as const;

test("options and positionals parse", () => {
  const { values, positionals } = strictOptions(
    {
      args: ["--output", "out.txt", "in.txt"],
      options,
      allowPositionals: true,
    },
    usage,
  );
  expect(values.output).toBe("out.txt");
  expect(positionals).toEqual(["in.txt"]);
});

const usageErrors: [string, string[], boolean][] = [
  ["an unknown option", ["--frobnicate"], true],
  ["a value missing after a flag", ["--output"], true],
  ["a stray positional", ["in.txt"], false],
];
for (const [label, args, allowPositionals] of usageErrors)
  test(`${label} is an error that carries the usage line`, () => {
    expect(() =>
      strictOptions({ args, options, allowPositionals }, usage),
    ).toThrow(usage);
  });
