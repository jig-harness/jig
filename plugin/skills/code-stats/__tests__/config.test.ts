import { describe, expect, test } from "bun:test";
import {
  areaDescriptions,
  areaNames,
  DEFAULT_AREA,
  globProblem,
  parseCodeStatsConfig,
} from "../scripts/lib/config.ts";

const area = (over: Record<string, unknown> = {}) => ({
  name: "web",
  paths: ["apps/web/**"],
  ...over,
});

describe("parseCodeStatsConfig", () => {
  test("absent, everything defaults", () => {
    const config = parseCodeStatsConfig(undefined);
    expect(config.configuredAreas).toBe(false);
    expect(config.defaultArea).toBe(DEFAULT_AREA);
    expect(config.kinds).toEqual([]);
    expect(config.modules).toBeNull();
    expect(config.classifyCommand).toBeNull();
    expect(areaNames(config).at(-1)).toBe("production");
  });

  test("an area named __proto__ keeps its own description", () => {
    const config = parseCodeStatsConfig({
      areas: [area({ name: "__proto__", description: "Odd but allowed" })],
    });
    const own = (o: object) =>
      Object.getOwnPropertyDescriptor(o, "__proto__")?.value;
    const descriptions = areaDescriptions(config);
    expect(own(descriptions)).toBe("Odd but allowed");
    expect(own(JSON.parse(JSON.stringify(descriptions)))).toBe(
      "Odd but allowed",
    );
  });

  test("areas replace the default list, in order, with the default area last", () => {
    const config = parseCodeStatsConfig({
      areas: [area(), area({ name: "docs", paths: ["docs/**"] })],
      default_area: "other-stuff",
    });
    expect(areaNames(config)).toEqual(["web", "docs", "other-stuff"]);
  });

  test.each([
    [[], "code_stats must be a mapping"],
    [{ area: [] }, "code_stats has unknown field area"],
    [{ areas: "web" }, "code_stats.areas must be a list"],
    [{ areas: ["web"] }, "code_stats.areas[0] must be a mapping"],
    [
      { areas: [area({ name: "" })] },
      "code_stats.areas[0].name must be a nonempty name",
    ],
    [{ areas: [area({ name: "a/b" })] }, "must not hold a /"],
    [
      { areas: [area(), area()] },
      'code_stats.areas[1].name "web" repeats an earlier area',
    ],
    [
      { areas: [area({ paths: "apps/**" })] },
      "code_stats.areas[0].paths must be a nonempty list of globs",
    ],
    [
      { areas: [area({ paths: [] })] },
      "code_stats.areas[0].paths must be a nonempty list of globs",
    ],
    [
      { areas: [area({ paths: ["apps/{web"] })] },
      'code_stats.areas[0].paths[0] "apps/{web" opens a { it never closes',
    ],
    [
      { areas: [area({ content: "yes" })] },
      "code_stats.areas[0].content must be true or false",
    ],
    [
      { areas: [area({ owner: "x" })] },
      "code_stats.areas[0] has unknown key owner",
    ],
    [{ default_area: "" }, "code_stats.default_area must be a nonempty name"],
    [{ kinds: ["test"] }, "code_stats.kinds must be a mapping"],
    [
      { kinds: { tests: ["a/**"] } },
      'code_stats.kinds has unknown kind "tests"',
    ],
    [
      { kinds: { test: "a/**" } },
      "code_stats.kinds.test must be a nonempty list of globs",
    ],
    [{ kinds: { test: ["/abs/**"] } }, "is absolute"],
    [
      { modules: "apps/*" },
      "code_stats.modules must be a nonempty list of globs",
    ],
    [{ modules: ["../x/*"] }, "has a .. segment"],
    [
      { classify_command: "" },
      "code_stats.classify_command must be a shell command",
    ],
    [
      { classify_command: ["a"] },
      "code_stats.classify_command must be a shell command",
    ],
  ] as const)("refuses %j", (section, message) => {
    expect(() => parseCodeStatsConfig(section)).toThrow(message);
  });

  test("kinds keep the order they are written in", () => {
    const config = parseCodeStatsConfig({
      kinds: { fixture: ["acceptance/fixtures/**"], test: ["acceptance/**"] },
    });
    expect(config.kinds.map((k) => `${k.kind}:${k.pattern.pattern}`)).toEqual([
      "fixture:acceptance/fixtures/**",
      "test:acceptance/**",
    ]);
  });
});

describe("globProblem", () => {
  test.each([
    ["apps/**", null],
    ["**/*.{ts,tsx}", null],
    ["src/[abc]/*.ts", null],
    ["a\\{b", null],
    ["", "is empty"],
    ["src/[abc", "opens a [ it never closes"],
    ["src/{a,b", "opens a { it never closes"],
    ["src/a}", "closes a { it never opened"],
    ["src\\", "ends with a lone backslash"],
  ] as const)("%j → %j", (pattern, problem) => {
    expect(globProblem(pattern)).toBe(problem);
  });
});
