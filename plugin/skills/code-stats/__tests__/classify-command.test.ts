import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseClassifyOutput,
  runClassifyCommand,
} from "../scripts/lib/classify-command.ts";
import { temporary, write } from "./helpers.ts";

const AREAS = new Set(["web", "production"]);
const PATHS = ["apps/web/a.ts", "apps/web/b.ts"];

/** A command that prints `body` (a JS expression over the stdin lines) and exits `code`. */
function fakeCommand(body: string, code = 0): string {
  const dir = temporary("code-stats-command-");
  const script = join(dir, "classify.ts");
  write(
    dir,
    "classify.ts",
    `const lines = (await Bun.stdin.text()).split("\\n").filter(Boolean);
process.stdout.write(${body});
process.exitCode = ${code};
`,
  );
  return `"${process.execPath}" "${script}"`;
}

describe("runClassifyCommand", () => {
  test("receives the paths on standard input; its values override", async () => {
    const command = fakeCommand(
      `lines.map((p) => JSON.stringify({ path: p, area: "web", kind: "test", language: "Script", module: "web" })).join("\\n")`,
    );
    const overrides = await runClassifyCommand(
      temporary(),
      command,
      PATHS,
      AREAS,
    );
    expect(Object.fromEntries(overrides)).toEqual({
      "apps/web/a.ts": {
        area: "web",
        kind: "test",
        language: "Script",
        module: "web",
      },
      "apps/web/b.ts": {
        area: "web",
        kind: "test",
        language: "Script",
        module: "web",
      },
    });
  });

  test("a non-zero exit is an error naming the command", async () => {
    const command = fakeCommand(`""`, 3);
    await expect(
      runClassifyCommand(temporary(), command, PATHS, AREAS),
    ).rejects.toThrow(/classify_command .* failed \(exit 3/);
  });

  test("bad output from a real command is refused", async () => {
    const command = fakeCommand(`"not json\\n"`);
    await expect(
      runClassifyCommand(temporary(), command, PATHS, AREAS),
    ).rejects.toThrow("output line 1 is not JSON");
  });
});

describe("parseClassifyOutput", () => {
  const tracked = new Set(PATHS);
  const parse = (text: string) => parseClassifyOutput(text, tracked, AREAS);

  test("a path with no fields keeps every earlier value; blank lines are skipped", () => {
    expect(Object.fromEntries(parse('\n{"path":"apps/web/a.ts"}\n\n'))).toEqual(
      { "apps/web/a.ts": {} },
    );
  });

  test.each([
    ["[1]", "line 1 is not a JSON object"],
    ['{"path":"apps/web/a.ts","owner":"x"}', "has unknown key owner"],
    [
      '{"path":"apps/web/c.ts"}',
      '"apps/web/c.ts", which is not a tracked file',
    ],
    ['{"area":"web"}', "line 1 has no path"],
    ['{"path":"apps/web/a.ts","area":"mobile"}', 'the unknown area "mobile"'],
    ['{"path":"apps/web/a.ts","kind":"tests"}', 'the unknown kind "tests"'],
    [
      '{"path":"apps/web/a.ts","module":""}',
      "a module that is not a nonempty string",
    ],
    [
      '{"path":"apps/web/a.ts"}\n{"path":"apps/web/a.ts"}',
      "line 2 names apps/web/a.ts a second time",
    ],
  ] as const)("refuses %s", (text, message) => {
    expect(() => parse(text)).toThrow(message);
  });
});
