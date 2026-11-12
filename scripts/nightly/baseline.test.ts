import { describe, expect, test } from "bun:test";
import { isUnnamed, platformName, readBaseline } from "./baseline.ts";

const VALID = `version: 1
groups:
  - platform: windows
    issue: "#12"
    reason: Paths are spelled with backslashes.
    tests:
      lib/a.test.ts:
        - "outer > spells the path"
        - (unnamed)
  - platform: macos
    issue: "#13"
    reason: The fixture's clock differs.
    tests:
      lib/a.test.ts:
        - "outer > spells the path"
`;

describe("the known-failure baseline", () => {
  test("names each platform as the baseline does", () => {
    expect(platformName("darwin")).toBe("macos");
    expect(platformName("win32")).toBe("windows");
    expect(platformName("linux")).toBe("linux");
  });

  test("a hook's failure is unnamed, at the top or inside blocks", () => {
    expect(isUnnamed("(unnamed)")).toBe(true);
    expect(isUnnamed("outer > (unnamed)")).toBe(true);
    expect(isUnnamed("outer > the (unnamed) case")).toBe(false);
  });

  test("reads one entry per test and platform, each with its group's reason and issue", () => {
    const { entries, problems } = readBaseline(VALID);
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      {
        platform: "windows",
        issue: "#12",
        reason: "Paths are spelled with backslashes.",
        file: "lib/a.test.ts",
        name: "outer > spells the path",
      },
      {
        platform: "windows",
        issue: "#12",
        reason: "Paths are spelled with backslashes.",
        file: "lib/a.test.ts",
        name: "(unnamed)",
      },
      {
        platform: "macos",
        issue: "#13",
        reason: "The fixture's clock differs.",
        file: "lib/a.test.ts",
        name: "outer > spells the path",
      },
    ]);
  });

  test("a test recorded twice for one platform is a problem, and counted once", () => {
    const twice = `${VALID}  - platform: windows
    issue: "#14"
    reason: Again.
    tests:
      lib/a.test.ts: ["outer > spells the path"]
`;
    const { entries, problems } = readBaseline(twice);
    expect(entries).toHaveLength(3);
    expect(problems).toEqual([
      {
        where: "group 3, lib/a.test.ts",
        problem: '"outer > spells the path" is recorded twice for windows',
      },
    ]);
  });

  test.each([
    ["not YAML", "groups: [", /./],
    ["no version", "groups: []\n", /version: 1/],
    [
      "an unknown top-level field",
      "version: 1\ngroups: []\nextra: 1\n",
      /nothing else/,
    ],
    [
      "an unknown platform",
      VALID.replace("platform: macos", "platform: beos"),
      /platform must be/,
    ],
    [
      "an issue without its number sign",
      VALID.replace('"#13"', '"13"'),
      /#<number>/,
    ],
    [
      "no reason",
      VALID.replace("reason: The fixture's clock differs.", 'reason: ""'),
      /reason/,
    ],
    [
      "an unknown group field",
      VALID.replace("    tests:\n", "    owner: x\n    tests:\n"),
      /unknown field "owner"/,
    ],
    [
      "a Windows path",
      VALID.replace(
        '      lib/a.test.ts:\n        - "outer',
        '      "lib\\\\a.test.ts":\n        - "outer',
      ),
      /forward slashes/,
    ],
    [
      "a path out of the repository",
      VALID.replaceAll("lib/a.test.ts", "../a.test.ts"),
      /forward slashes/,
    ],
    [
      "a file without names",
      VALID.replace(
        '        - "outer > spells the path"\n        - (unnamed)\n',
        "        []\n",
      ),
      /full names/,
    ],
  ])("refuses %s", (_what, raw, problem) => {
    const { problems } = readBaseline(raw);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.map((p) => p.problem).join("\n")).toMatch(problem);
  });
});
