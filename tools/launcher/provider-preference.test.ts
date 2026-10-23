import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherConfigError, parseConfig } from "./config.ts";
import { install } from "./install.ts";
import { chooseProvider, launch } from "./launch.ts";
import type { Provider } from "./provider.ts";
import { getProvider } from "./providers/index.ts";
import type { Tracker } from "./tracker.ts";

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

/** A launch with `launcher.yaml` set to `yaml`, of an issue labelled `repoLabel`. */
async function launchWith(yaml: string, repoLabel: string | null) {
  const home = mkdtempSync(join(tmpdir(), "launcher-preference-"));
  const opened: Array<{ provider: string; repo: unknown }> = [];
  const recorder = (name: string): Provider => ({
    ...named(name),
    async open(request) {
      opened.push({ provider: name, repo: request.repo });
    },
  });
  const tracker: Tracker = {
    name: "fake",
    launchEnvironment: {},
    async read() {
      return {
        cache: null,
        repoLabel,
        warnings: [],
        assignToOpener: async () => ({ assigned: true }),
      };
    },
  };
  try {
    mkdirSync(join(home, ".linear"), { recursive: true });
    writeFileSync(join(home, ".linear", "launcher.yaml"), yaml);
    await launch("ENG-1", "eng-1", {
      home,
      env: {},
      tracker,
      // A registered name records its opening; any other is looked up for real.
      providerNamed: (name) =>
        ["herdr", "conductor"].includes(name)
          ? recorder(name)
          : getProvider(name),
      warn() {
        // warnings are not under test
      },
    });
    return opened;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const PREFERENCE = `
provider: [herdr, conductor]
repos:
  both:
    herdr: ~/both
    conductor: Both
  web:
    conductor: Website
`;

describe("a launch with a provider list", () => {
  test("opens with the second provider, given its own settings, when the first has none", async () => {
    expect(await launchWith(PREFERENCE, "web")).toEqual([
      { provider: "conductor", repo: "Website" },
    ]);
  });

  test("prefers the first provider a repository has settings for", async () => {
    expect(await launchWith(PREFERENCE, "both")).toEqual([
      { provider: "herdr", repo: "~/both" },
    ]);
  });

  test("opens an unrouted issue with the first provider", async () => {
    for (const label of [null, "unknown"])
      expect(await launchWith(PREFERENCE, label)).toEqual([
        { provider: "herdr", repo: null },
      ]);
  });

  test("refuses an unknown name anywhere in the list as a configuration error", async () => {
    const opening = launchWith("provider: [conductor, nowhere]\n", null);
    await expect(opening).rejects.toBeInstanceOf(LauncherConfigError);
    await expect(opening).rejects.toThrow('unknown provider "nowhere"');
  });
});

describe("install --check with a provider list", () => {
  const check = (yaml: string) => {
    const home = mkdtempSync(join(tmpdir(), "launcher-preference-"));
    try {
      mkdirSync(join(home, ".linear"), { recursive: true });
      writeFileSync(join(home, ".linear", "launcher.yaml"), yaml);
      return install({
        home,
        bun: process.execPath,
        script: join(import.meta.dirname, "launch.ts"),
        env: {},
        check: true,
      }).lines.join("\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test("refuses an unknown second provider", () => {
    expect(check("provider: [conductor, nowhere]\n")).toContain(
      'unknown provider "nowhere"',
    );
  });

  test("validates the second provider's settings", () => {
    expect(
      check("provider: [conductor, herdr]\nrepos:\n  app:\n    herdr: 7\n"),
    ).toContain("repos.app.herdr");
  });
});

test("malformed YAML is a configuration error naming the file", () => {
  let thrown: unknown;
  try {
    parseConfig("provider: [\n", "c.yaml");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LauncherConfigError);
  expect(String(thrown)).toContain("c.yaml: ");
  expect((thrown as Error).cause).toBeDefined();
});
