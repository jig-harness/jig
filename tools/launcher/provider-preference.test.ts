import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config.ts";
import { chooseProvider } from "./launch.ts";
import type { Provider } from "./provider.ts";

const named = (name: string): Provider => ({
  name,
  validateRepo() {
    // any settings are valid
  },
  async open() {
    // nothing to open
  },
});

describe("provider", () => {
  test("is one name or a list in order of preference", () => {
    expect(parseConfig("provider: herdr\n", "c.yaml").providers).toEqual([
      "herdr",
    ]);
    expect(
      parseConfig("provider: [herdr, conductor]\n", "c.yaml").providers,
    ).toEqual(["herdr", "conductor"]);
  });

  test("an empty list or a repeated name is refused", () => {
    expect(() => parseConfig("provider: []\n", "c.yaml")).toThrow(
      "provider must be a non-empty string or a list",
    );
    expect(() => parseConfig("provider: [herdr, herdr]\n", "c.yaml")).toThrow(
      "provider lists a name more than once",
    );
  });

  test("an issue opens with the first provider its repository has settings for", () => {
    const providers = [named("herdr"), named("conductor")] as const;
    const pick = (settings?: Record<string, unknown>) =>
      chooseProvider(providers, settings).name;
    expect(pick({ conductor: "Alpha", herdr: "~/alpha" })).toBe("herdr");
    expect(pick({ conductor: "Beta" })).toBe("conductor");
    // An unrouted issue, or a repository with no entry for any, goes to the first.
    expect(pick(undefined)).toBe("herdr");
    expect(pick({ other: 1 })).toBe("herdr");
  });
});
