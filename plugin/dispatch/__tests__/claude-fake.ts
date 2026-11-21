/**
 * The Claude Code a wrapper starts in tests: it records how it was started
 * and runs until \`claude-exit\` appears, then prints \`claude-said\` when
 * there is one and exits with the code \`claude-exit\` holds (0 when empty).
 * With \`claude-stubborn\` present it ignores SIGTERM and leaves a tool
 * command running, whose pid it writes to \`claude-tool-pid\`.
 */
export const FAKE_CLAUDE = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
if (process.argv.includes("--max-budget-usd")) {
  const fixture = F + "/claude-sign-in";
  fs.appendFileSync(F + "/claude-sign-in-runs", "probe\\n");
  const outcome = fs.existsSync(fixture) ? fs.readFileSync(fixture, "utf8") : "success";
  if (outcome === "timeout") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  const response = {
    unauthorized: "Failed to authenticate: OAuth session expired",
    "rate-limited": "You've hit your session limit · resets unknown",
  }[outcome];
  const rejected = response !== undefined;
  console.log(JSON.stringify({
    is_error: rejected,
    result: response ?? "OK",
    total_cost_usd: 0,
  }));
  process.exit(rejected ? 1 : 0);
}
fs.appendFileSync(F + "/claude-runs.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  backgroundTasksOff: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null,
}) + "\\n");
if (fs.existsSync(F + "/claude-stubborn")) {
  process.on("SIGTERM", () => {});
  const tool = require("node:child_process").spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(F + "/claude-tool-pid", String(tool.pid));
}
const until = Date.now() + 60000;
while (!fs.existsSync(F + "/claude-exit") && Date.now() < until) Bun.sleepSync(50);
if (fs.existsSync(F + "/claude-said")) {
  const said = fs.readFileSync(F + "/claude-said");
  // With \`claude-split\` present, the first multi-byte character is cut between two writes.
  const stream = fs.existsSync(F + "/claude-stderr") ? process.stderr : process.stdout;
  const cut = fs.existsSync(F + "/claude-split") ? said.findIndex((b) => b >= 0xc0) + 1 : 0;
  if (cut > 0) {
    stream.write(said.subarray(0, cut));
    if (fs.existsSync(F + "/claude-interleave")) {
      Bun.sleepSync(150);
      (stream === process.stderr ? process.stdout : process.stderr).write("diagnostic\\n");
    }
    Bun.sleepSync(300);
  }
  stream.write(said.subarray(cut));
}
process.exit(Number(fs.existsSync(F + "/claude-exit") ? fs.readFileSync(F + "/claude-exit", "utf8") : 0) || 0);
`;
