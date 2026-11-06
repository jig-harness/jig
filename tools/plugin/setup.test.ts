/**
 * `bun tools/plugin/setup.ts` installs, updates and checks the plugin from a
 * checkout, through the plugin's own code (`plugin/runtime/harness.ts`),
 * against stand-in `claude` and `codex` commands that log every call.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { DEFAULT_SOURCE, PLUGIN_ID } from "../../plugin/runtime/harness.ts";
import { parse } from "./setup.ts";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()),
  ),
);

let scratch: string;
beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-setup-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("setup defaults to the Jig repository and rejects unknown flags", () => {
  const noMarketplace = { ...process.env, JIG_MARKETPLACE: undefined };
  expect(parse([], noMarketplace)).toEqual({
    check: false,
    source: DEFAULT_SOURCE,
    explicit: false,
    defaulted: true,
    only: null,
  });
  expect(parse(["--check", "--codex", "--source", "/x"])).toEqual({
    check: true,
    source: "/x",
    explicit: true,
    defaulted: false,
    only: "codex",
  });
  expect(parse(["--channel", "latest"], noMarketplace)).toEqual({
    check: false,
    source: `${DEFAULT_SOURCE}#latest`,
    explicit: true,
    defaulted: false,
    only: null,
  });
  expect(() => parse(["--source"])).toThrow("needs a marketplace source");
  expect(() => parse(["--bogus"])).toThrow("unknown argument");
  expect(() => parse(["--channel", "beta"])).toThrow(
    "--channel needs one of: latest, stable",
  );
  expect(() =>
    parse(["--channel", "stable", "--source", `${DEFAULT_SOURCE}#v0.3.0`]),
  ).toThrow("contradict each other");
  expect(() => parse(["--channel", "stable", "--source", "/src/jig"])).toThrow(
    "has no channels",
  );
});

/**
 * Run setup.ts against stub `claude`/`codex` commands that log every call and
 * answer the list queries from STUB_* environment JSON.
 */
function runSetup(
  args: string[],
  stub: Record<string, string>,
): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
} {
  const bin = mkdtempSync(join(scratch, "stub-bin-"));
  const log = join(bin, "calls.log");
  for (const tool of ["claude", "codex"])
    writeFileSync(
      join(bin, tool),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tool)} + " " + args + "\\n");
const key = ("STUB_${tool}_" + args).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
if (process.env.STUB_SLEEP === args) await Bun.sleep(10_000);
if (process.env[key] !== undefined) console.log(process.env[key]);
`,
      { mode: 0o755 },
    );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "setup.ts"), ...args],
    {
      env: {
        ...env,
        // Never the machine's own Codex configuration.
        CODEX_HOME: join(scratch, "no-codex-home"),
        ...stub,
        JIG_MARKETPLACE: "",
        PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n")
    : [];
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
  };
}

const registeredHere = JSON.stringify([
  { name: "jig", source: "directory", path: "/src/jig" },
]);
const userInstall = JSON.stringify([
  { id: PLUGIN_ID, scope: "user", version: "0.2.0", enabled: true },
]);

test.skipIf(process.platform === "win32")(
  "setup refuses a conflicting source before changing anything",
  () => {
    const result = runSetup(["--claude", "--source", DEFAULT_SOURCE], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
    });
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain("is registered from /src/jig");
    expect(result.calls).toEqual([
      "claude --version",
      "claude plugin marketplace list --json",
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup updates the user-scope install and refreshes a Git Codex marketplace",
  () => {
    const result = runSetup([], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: JSON.stringify({
        marketplaces: [
          {
            name: "jig",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      }),
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expectSpawnExit(result, 0);
    expect(result.calls).toContain("claude plugin update jig@jig --scope user");
    expect(result.calls).not.toContain("claude plugin update jig@jig");
    const codex = result.calls.filter((call) =>
      call.startsWith("codex plugin"),
    );
    expect(codex).toEqual([
      "codex plugin marketplace list --json",
      "codex plugin marketplace upgrade jig",
      // The version it updates from, for the result.
      "codex plugin list --json",
      "codex plugin add jig@jig",
      "codex plugin list --json",
      "codex plugin marketplace list --json",
    ]);
    // A machine registered from main is told how to follow a channel.
    expect(result.stderr).toContain(
      "codex: jig@jig follows main, the source address",
    );
    expect(result.stdout).toContain(
      "codex: jig@jig 0.2.0 enabled, following main, the source address",
    );
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup installs a fresh machine at the channel asked for",
  () => {
    const result = runSetup(["--channel", "latest"], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: "[]",
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: '{"marketplaces":[]}',
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expectSpawnExit(result, 0);
    expect(result.calls).toContain(
      `claude plugin install jig --marketplace ${DEFAULT_SOURCE}#latest`,
    );
    expect(result.calls).toContain(
      `codex plugin marketplace add ${DEFAULT_SOURCE} --ref latest`,
    );
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup refuses to move a machine to another channel without the removal",
  () => {
    const codexHome = mkdtempSync(join(scratch, "codex-home-"));
    writeFileSync(
      join(codexHome, "config.toml"),
      `[marketplaces.jig]\nsource_type = "git"\nsource = "${DEFAULT_SOURCE}"\nref = "latest"\n`,
    );
    const result = runSetup(["--codex", "--channel", "stable"], {
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: JSON.stringify({
        marketplaces: [
          {
            name: "jig",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      }),
      CODEX_HOME: codexHome,
    });
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain(
      `registered from ${DEFAULT_SOURCE}#latest, not ${DEFAULT_SOURCE}#stable`,
    );
    expect(result.stderr).toContain("codex plugin marketplace remove jig");
    expect(result.calls).toEqual([
      "codex --version",
      "codex plugin marketplace list --json",
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup bounds a stalled tool command",
  () => {
    const result = runSetup(["--claude"], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_SLEEP: "plugin marketplace update jig",
      JIG_SETUP_TIMEOUT_SECONDS: "1",
    });
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain("did not finish within 1s");
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup never skips a tool it could not inspect",
  () => {
    // A stalled version probe is an error, not "not on PATH": --check must
    // not pass for the other tool alone.
    const result = runSetup(["--check"], {
      STUB_SLEEP: "--version",
      JIG_SETUP_TIMEOUT_SECONDS: "1",
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain("claude --version did not finish");
    expect(result.stdout).not.toContain("not on PATH");
    // A harness that fails does not stop the next one.
    expect(result.stderr).toContain("codex --version did not finish");
  },
  30_000,
);
