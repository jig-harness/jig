/**
 * What the plugin reads from each agent harness's own lists: the user-scope
 * install, Claude Code's project- and local-scope installs, where the
 * marketplace is registered from and what it follows.
 * Installing and updating through stand-in harnesses runs from a checkout in
 * `tools/plugin/setup.test.ts`, and through `jig upgrade` in
 * `plugin/__tests__/upgrade-doctor.test.ts`.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import {
  claudeMarketplace,
  claudeScopedInstalls,
  claudeUserInstall,
  codexInstall,
  codexMarketplace,
  DEFAULT_SOURCE,
  describeSource,
  followsMain,
  PLUGIN_ID,
  refreshScoped,
  sameSource,
} from "../harness.ts";

test("only the user-scope Claude Code install counts", () => {
  // `claude plugin list --json` lists one entry per scope; a project install
  // made for another directory must neither satisfy nor fail the check.
  const project = {
    id: PLUGIN_ID,
    scope: "project",
    projectPath: "/elsewhere",
    version: "0.1.0",
    enabled: false,
  };
  const user = {
    id: PLUGIN_ID,
    scope: "user",
    version: "0.2.0",
    enabled: true,
  };
  expect(claudeUserInstall([project])).toBeNull();
  expect(claudeUserInstall([project, user])).toEqual({
    version: "0.2.0",
    enabled: true,
  });
  expect(claudeUserInstall({ unexpected: true })).toBeNull();
  expect(
    codexInstall({
      installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: false }],
    }),
  ).toEqual({ version: "0.2.0", enabled: false });
  expect(codexInstall({ installed: [] })).toBeNull();
});

test("the project- and local-scope Claude Code installs, each with its directory", () => {
  expect(
    claudeScopedInstalls([
      { id: PLUGIN_ID, scope: "user", version: "0.2.0", enabled: true },
      {
        id: PLUGIN_ID,
        scope: "project",
        projectPath: "/repo",
        version: "0.1.0",
        enabled: true,
      },
      {
        id: PLUGIN_ID,
        scope: "local",
        projectPath: "/other",
        version: "0.1.5",
        enabled: false,
      },
      { id: "other@elsewhere", scope: "project", projectPath: "/repo" },
      { id: PLUGIN_ID, scope: "project", version: "0.1.0" },
    ]),
  ).toEqual([
    { scope: "project", project: "/repo", version: "0.1.0", enabled: true },
    { scope: "local", project: "/other", version: "0.1.5", enabled: false },
  ]);
  expect(claudeScopedInstalls({ unexpected: true })).toEqual([]);
});

test.skipIf(
  skipsOnWindows("powershell", "the stand-in claude is a POSIX script"),
)(
  "an install record in a form this release does not know is left as it was, naming the install",
  () => {
    const root = mkdtempSync(join(tmpdir(), "jig-scoped-"));
    const gone = join(root, "deleted");
    const claude = join(root, "claude");
    writeFakeProgram(
      claude,
      `#!/bin/sh\necho '${JSON.stringify([{ id: PLUGIN_ID, scope: "project", projectPath: gone, version: "0.1.0", enabled: true }])}'\n`,
    );
    const record = join(root, "installed_plugins.json");
    const text = JSON.stringify({ version: 3, plugins: {} });
    writeFileSync(record, text);
    const lines: string[] = [];
    const results = refreshScoped(
      claude,
      (line) => lines.push(line),
      null,
      record,
    );
    expect(results).toEqual([
      expect.objectContaining({
        project: gone,
        outcome: "left",
        detail: expect.stringContaining("not in the form this release edits"),
      }),
    ]);
    expect(readFileSync(record, "utf8")).toBe(text);
    expect(lines.at(-1)).toContain(`for ${gone} (project scope): left`);
  },
);

test("where a marketplace is registered from, and what it follows", () => {
  expect(
    claudeMarketplace([
      {
        name: "jig",
        source: "git",
        url: "https://github.com/jig-harness/jig.git",
        ref: "v0.2.0",
      },
    ]),
  ).toEqual({
    location: "https://github.com/jig-harness/jig.git#v0.2.0",
    git: true,
  });
  expect(
    claudeMarketplace([{ name: "jig", source: "directory", path: "/src/jig" }]),
  ).toEqual({ location: "/src/jig", git: false });
  expect(
    codexMarketplace({
      marketplaces: [
        {
          name: "jig",
          marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
        },
      ],
    }),
  ).toEqual({ location: DEFAULT_SOURCE, git: true });
  // Codex's list leaves the ref out; its config.toml carries it.
  expect(
    codexMarketplace(
      {
        marketplaces: [
          {
            name: "jig",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      },
      { marketplaces: { jig: { source: DEFAULT_SOURCE, ref: "stable" } } },
    ),
  ).toEqual({ location: `${DEFAULT_SOURCE}#stable`, git: true });
  expect(codexMarketplace({ marketplaces: [] })).toBeNull();
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#stable`, git: true }),
  ).toBe("the stable channel");
  expect(describeSource({ location: DEFAULT_SOURCE, git: true })).toBe(
    "main, the source address",
  );
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#v0.3.0`, git: true }),
  ).toBe("v0.3.0, pinned");
  // Naming main outright still follows main; only a version tag is a pin.
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#main`, git: true }),
  ).toBe("main, the source address");
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#feature`, git: true }),
  ).toBe("the ref feature");
  expect(followsMain(undefined)).toBe(true);
  expect(followsMain("main")).toBe(true);
  expect(followsMain("refs/heads/main")).toBe(true);
  expect(followsMain("stable")).toBe(false);
  expect(describeSource({ location: "/src/jig", git: false })).toBe(
    "the directory /src/jig",
  );
  // A channel is a ref: following one channel does not satisfy the other.
  expect(
    sameSource(`${DEFAULT_SOURCE}#latest`, `${DEFAULT_SOURCE}#stable`),
  ).toBe(false);
  expect(sameSource(`${DEFAULT_SOURCE}#v0.2.0`, DEFAULT_SOURCE)).toBe(true);
  // A requested release must not be satisfied by an unpinned registration.
  expect(sameSource(DEFAULT_SOURCE, `${DEFAULT_SOURCE}#v0.2.0`)).toBe(false);
  expect(sameSource("https://github.com/jig-harness/jig", DEFAULT_SOURCE)).toBe(
    true,
  );
  expect(
    sameSource(`${DEFAULT_SOURCE}#v0.1.0`, `${DEFAULT_SOURCE}#v0.2.0`),
  ).toBe(false);
  expect(sameSource("/src/jig", DEFAULT_SOURCE)).toBe(false);
});
