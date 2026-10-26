/**
 * The configuration's `defaults`: the settings every repository label starts
 * from, so a machine that opens every repository the same way needs no
 * entry per repository.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherConfigError, parseConfig, settingsFor } from "./config.ts";
import { launch } from "./launch.ts";
import type { Provider } from "./provider.ts";
import { getProvider } from "./providers/index.ts";
import type { Tracker } from "./tracker.ts";

test("configuration defaults apply to an empty file", () => {
  expect(parseConfig("", "c.yaml")).toEqual({
    tracker: "linear",
    providers: ["conductor"],
    skill: "/jig:do-item",
    repoLabelGroup: "Repo",
    repos: {},
    defaults: {},
  });
});

const SERVER = `
provider: [orca, conductor]
defaults:
  orca:
    repo: "{label}"
    environment: box
    clone: {url: "git@example.com:acme/{repo}.git", root: ~/dev}
repos:
  website:
    orca: {repo: acme-website}
  tool:
    orca: tool-local
`;

describe("settings for a label", () => {
  const config = parseConfig(SERVER, "c.yaml");

  test("an unlisted label has the defaults, its {label} read as the label", () => {
    expect(settingsFor(config, "docket")).toEqual({
      orca: {
        repo: "docket",
        environment: "box",
        clone: { url: "git@example.com:acme/{repo}.git", root: "~/dev" },
      },
    });
  });

  test("a listed label's mapping overrides the defaults key by key", () => {
    expect(settingsFor(config, "website")?.orca).toEqual({
      repo: "acme-website",
      environment: "box",
      clone: { url: "git@example.com:acme/{repo}.git", root: "~/dev" },
    });
  });

  test("a listed label's short form replaces the defaults whole", () => {
    expect(settingsFor(config, "tool")?.orca).toBe("tool-local");
  });

  test("without defaults, an unlisted label has no settings", () => {
    expect(
      settingsFor(parseConfig("repos: {}\n", "c.yaml"), "docket"),
    ).toBeUndefined();
  });

  test("defaults that are not a mapping are refused", () => {
    expect(() => parseConfig("defaults: [orca]\n", "c.yaml")).toThrow(
      "defaults must map a provider name to its settings",
    );
  });
});

/** A launch with `launcher.yaml` set to `yaml`, of an issue labelled `repoLabel`. */
async function launchWith(yaml: string, repoLabel: string | null) {
  const home = mkdtempSync(join(tmpdir(), "launcher-defaults-"));
  const opened: Array<{ provider: string; repo: unknown }> = [];
  const real = getProvider("orca");
  const recorder: Provider = {
    name: "orca",
    validateRepo: real.validateRepo,
    async open(request) {
      opened.push({ provider: "orca", repo: request.repo });
    },
  };
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
      providerNamed: (name) => (name === "orca" ? recorder : getProvider(name)),
      warn() {
        // warnings are not under test
      },
    });
    return opened;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("a launch with defaults", () => {
  test("routes a label with no entry to the defaults' provider", async () => {
    expect(await launchWith(SERVER, "docket")).toEqual([
      {
        provider: "orca",
        repo: {
          repo: "docket",
          environment: "box",
          clone: { url: "git@example.com:acme/{repo}.git", root: "~/dev" },
        },
      },
    ]);
  });

  test("still opens an issue with no label unrouted", async () => {
    expect(await launchWith(SERVER, null)).toEqual([
      { provider: "orca", repo: null },
    ]);
  });

  test("refuses defaults the provider cannot use before anything opens", async () => {
    const opening = launchWith(
      "provider: orca\ndefaults:\n  orca: {repo: '{label}', clone: {url: x}}\n",
      "docket",
    );
    await expect(opening).rejects.toBeInstanceOf(LauncherConfigError);
    await expect(opening).rejects.toThrow(
      "repos.{label}.orca.clone needs both url and root",
    );
  });
});
