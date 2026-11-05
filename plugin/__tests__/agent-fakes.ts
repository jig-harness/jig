/**
 * Stand-ins for the agent tools, `claude` and `codex`, for the lifecycle
 * tests: each logs its arguments and keeps the plugin it has installed in a
 * state file, so a test can say what the release channel offers next
 * (`newest`) and see an upgrade take each tool there. Each answers the
 * commands the plugin runs (`--version`, `plugin list --json`,
 * `plugin marketplace list --json`, and the update and install commands) and
 * refuses any other with exit 2. `claude plugin list --json` names the plugin
 * copy it holds, which is what the launcher runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";

const SOURCE = "https://github.com/jig-harness/jig.git";

export interface Release {
  version: string;
  /** The plugin copy that release installs. */
  path: string;
}

/** What the channel offers next, and what each tool has installed and refreshed. */
export interface AgentState {
  newest: Release;
  claude: Release & { enabled: boolean; snapshot: Release };
  codex: Release & { enabled: boolean; snapshot: Release };
}

const CLAUDE = `
if (line === "--version") console.log("2.1.300 (Claude Code)");
else if (line === "plugin list --json")
  console.log(JSON.stringify([{ id: "jig@jig", scope: "user", version: tool.version, enabled: tool.enabled, installPath: tool.path }]));
else if (line === "plugin marketplace list --json")
  console.log(JSON.stringify([{ name: "jig", source: "git", url: SOURCE, ref: "stable" }]));
else if (line === "plugin marketplace update jig") tool.snapshot = state.newest;
else if (line === "plugin update jig@jig --scope user") Object.assign(tool, tool.snapshot);
else refuse();
`;

const CODEX = `
if (line === "--version") console.log("codex-cli 0.159.0");
else if (line === "plugin list --json")
  console.log(JSON.stringify({ installed: [{ pluginId: "jig@jig", version: tool.version, enabled: tool.enabled }] }));
else if (line === "plugin marketplace list --json")
  console.log(JSON.stringify({ marketplaces: [{ name: "jig", marketplaceSource: { sourceType: "git", source: SOURCE } }] }));
else if (line === "plugin marketplace upgrade jig") tool.snapshot = state.newest;
else if (line === "plugin add jig@jig") Object.assign(tool, tool.snapshot);
else refuse();
`;

function fakeSource(name: "claude" | "codex", state: string, log: string) {
  return `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const SOURCE = ${JSON.stringify(SOURCE)};
const line = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + line + "\\n");
const state = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const tool = state[${JSON.stringify(name)}];
function refuse() {
  console.error("unexpected: " + line);
  process.exit(2);
}
${name === "claude" ? CLAUDE : CODEX}
writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
`;
}

/**
 * Writes `claude` and `codex` into `bin`, each with `installed` on the
 * channel's newest release, and Codex's configuration (under `home`) naming
 * the channel its marketplace follows.
 */
export function writeAgentFakes(options: {
  bin: string;
  home: string;
  state: string;
  log: string;
  installed: Release;
}): {
  read(): AgentState;
  update(change: (state: AgentState) => void): void;
  calls(): string[];
} {
  const { installed } = options;
  const initial: AgentState = {
    newest: installed,
    claude: { ...installed, enabled: true, snapshot: installed },
    codex: { ...installed, enabled: true, snapshot: installed },
  };
  writeFileSync(options.state, JSON.stringify(initial));
  writeFileSync(options.log, "");
  for (const name of ["claude", "codex"] as const)
    writeFakeProgram(
      join(options.bin, name),
      fakeSource(name, options.state, options.log),
    );
  const codexHome = join(options.home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    `[marketplaces.jig]\nsource_type = "git"\nsource = "${SOURCE}"\nref = "stable"\n`,
  );
  const read = (): AgentState =>
    JSON.parse(readFileSync(options.state, "utf8"));
  return {
    read,
    update: (change) => {
      const state = read();
      change(state);
      writeFileSync(options.state, JSON.stringify(state));
    },
    calls: () => readFileSync(options.log, "utf8").split("\n").filter(Boolean),
  };
}
