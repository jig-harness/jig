import { expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import {
  processEnvironment,
  processSettings,
} from "../lib/runtime/process-environment.ts";
import { world } from "./fixtures.ts";

it("refuses to configure the process runtime on Windows", () => {
  const config = resolve(import.meta.dir, "../lib/machine-config.ts");
  const child = Bun.spawnSync([
    process.execPath,
    "--eval",
    `
      import { parseMachineConfigText } from ${JSON.stringify(config)};
      Object.defineProperty(process, "platform", { value: "win32" });
      console.log(JSON.stringify(parseMachineConfigText("runtime: process", "machine")));
    `,
  ]);
  expectSpawnExit(child, 0);
  expect(JSON.parse(child.stdout.toString())).toMatchObject({
    ok: false,
    failure: { reason: expect.stringContaining("Linux and macOS") },
  });
});

it.skipIf(process.platform === "win32")(
  "reads the process runtime only from host configuration and refuses notices",
  () => {
    expect(parseMachineConfigText("", "machine")).toMatchObject({
      ok: true,
      value: { runtime: "orca" },
    });
    const configured = parseMachineConfigText(
      "runtime: process\nprocess:\n  env_keep: [GH_TOKEN]\n",
      "machine",
    );
    expect(configured).toMatchObject({
      ok: true,
      value: { runtime: "process", process: { envKeep: ["GH_TOKEN"] } },
    });
    expect(
      parseMachineConfigText(
        `runtime: process\nrepositories:\n  - path: ${JSON.stringify(import.meta.dir)}\n    stages: [pickup, notify]\n`,
        "machine",
      ),
    ).toMatchObject({
      ok: false,
      failure: { reason: expect.stringContaining("notify") },
    });
  },
);

it("binds only the chosen account and refuses credentials and loader controls in env_keep", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "LD_PRELOAD",
    "BUN_OPTIONS",
    "JIG_LAUNCH",
  ])
    expect(processSettings({ env_keep: [name] })).toMatchObject({
      ok: false,
      failure: { reason: expect.stringContaining(name) },
    });
  expect(processSettings({ path: "relative/bin" }).ok).toBe(false);
  const env = processEnvironment(
    {
      PATH: "/runner/bin",
      GH_TOKEN: "forge-fixture",
      GITHUB_TOKEN: "not-kept",
      HOME: "/fixture/home",
      JIG_HOME: "/fixture/jig",
      JIG_LAUNCH: "inherited",
      CLAUDE_CONFIG_DIR: "/another/account",
      CODEX_HOME: "/another/codex",
      CODEX_TEST: "not-kept",
      OPENAI_API_KEY: "not-kept",
      ANTHROPIC_AUTH_TOKEN: "not-kept",
      ANTHROPIC_CUSTOM_HEADERS: "not-kept",
      LC_CTYPE: "C",
    },
    { path: "/installed/bin", envKeep: ["GH_TOKEN"] },
    {
      vendor: "codex",
      configDir: "/selected/account",
    },
    "launch-record",
  );
  expect({ ...env }).toEqual({
    PATH: "/installed/bin",
    GH_TOKEN: "forge-fixture",
    HOME: "/fixture/home",
    JIG_HOME: "/fixture/jig",
    CODEX_HOME: "/selected/account",
    JIG_LAUNCH: "launch-record",
    LC_CTYPE: "C",
    ...(process.platform === "win32" ? { USERPROFILE: "/fixture/home" } : {}),
  });
});

it("drops relative entries from the schedule's inherited executable path", () => {
  const kept = resolve(import.meta.dir, "tools");
  const value = [".", "", "relative/bin", kept].join(delimiter);
  const env = processEnvironment(
    { PATH: value },
    { envKeep: [] },
    {
      vendor: "claude",
      configDir: resolve(import.meta.dir, "fixture-account"),
    },
  );
  expect(env.PATH).toBe(kept);
});

it.skipIf(process.platform !== "linux")(
  "opens, launches and reads a process-owned worktree without Orca",
  async () => {
    const w = world();
    const runner = join(w.root, "process-fixture.ts");
    const port = resolve(import.meta.dir, "../lib/runtime/port.ts");
    const runtime = resolve(import.meta.dir, "../lib/runtime/process.ts");
    const launches = resolve(import.meta.dir, "../lib/launches.ts");
    const output = resolve(import.meta.dir, "../lib/runtime/process-spool.ts");
    const owner = resolve(
      import.meta.dir,
      "../../shared/process-worktree-owner.ts",
    );
    const helper = resolve(
      import.meta.dir,
      "../../../lib/test-helpers/expect-spawn-exit.ts",
    );
    const processTable = resolve(
      import.meta.dir,
      "../../shared/process-table.ts",
    );
    try {
      writeFileSync(join(w.dir, "drive-hold"), "");
      writeFileSync(join(w.dir, "drive-output"), "the final output\n");
      writeFileSync(
        runner,
        `
import { expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from ${JSON.stringify(helper)};
import { dispatched } from ${JSON.stringify(port)};
import { processRuntime } from ${JSON.stringify(runtime)};
import { openSpool, processRunDirectory } from ${JSON.stringify(output)};
import { readEnded, writeRecord } from ${JSON.stringify(launches)};
import { readWorktreeOwner } from ${JSON.stringify(owner)};
import { processTable } from ${JSON.stringify(processTable)};

const until = performance.now() + 15_000;
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  while (performance.now() < until) {
    const actual = read();
    if (actual !== undefined) return actual;
    await Bun.sleep(20);
  }
  throw new Error("the dispatch fixture timed out");
}
const repo = { path: process.cwd(), slug: "example-org/example-repo", defaultBranch: "main" };
const git = (...argv: string[]) => {
  const out = Bun.spawnSync(["git", ...argv]);
  expectSpawnExit(out, 0);
  return out.stdout.toString().trim();
};
git("remote", "add", "origin", repo.path);
git("fetch", "origin");
git("remote", "set-head", "origin", "--auto");
const id = "20261118T141627Z-11111111";
const named = dispatched("rearm", "#7", id);
const runtime = processRuntime({ runtimeTimeoutMs: 8_000, workspaceTimeoutMs: 8_000,
  process: { envKeep: ["DISPATCH_FAKE_DIR", "JIG_DISPATCH_DRIVE_SCRIPT", "GH_TOKEN"] } });
const primary = await runtime.launch({ path: repo.path }, { kind: "headless",
  record: id, title: named.name, mark: named.mark }, "fixture", "unused");
expect(primary).toMatchObject({
  ok: false, detail: expect.stringContaining("primary checkout"),
});
const opened = await runtime.openWorkspace(repo, { item: "#7", branch: "7-test",
  tracker: "github", dispatched: named });
if (!opened.ok || opened.workspace === undefined) throw new Error(opened.detail);
const ws = opened.workspace;
const admin = git("-C", ws.path, "rev-parse", "--absolute-git-dir");
const token = "process-fixture-token";
writeRecord({
  version: 1, id, token, runtime: "process", action: "rearm", repo: repo.slug,
  repoPath: repo.path, item: null, pr: 7, account: "fixture", vendor: "claude",
  configDir: join(process.cwd(), "selected-account"), wallBackoffMs: 3600000,
  facts: "fixture", createdAt: Temporal.Now.instant().toString(), replaces: null,
  workspace: ws, attempts: [], agentId: null, model: null, effort: null,
  released: false, command: null, marker: null, mark: named.mark,
});
const started = await runtime.launch(ws, { kind: "headless", record: id,
  title: named.name, mark: named.mark }, "fixture", token);
if (!started.ok) throw new Error(started.detail);
const dir = process.env.DISPATCH_FAKE_DIR!;
try {
  await waitFor(() => {
    const read = readWorktreeOwner(admin);
    return read.ok && (read.value?.processes.length ?? 0) >= 3 ? read.value : undefined;
  });
  const sessions = await runtime.sessions(repo, {
    keys: null, branchPattern: "", pullRequests: [{number: 7, head: "7-test"}],
  });
  if (!sessions.ok) throw new Error(sessions.reason);
  expect(sessions.workspaces.find((w) => w.id === ws.id)).toMatchObject({
    prs: [7], agents: [{ id, state: "working" }],
  });
  const active = await runtime.endRun({ id, workspace: ws, runtime: "process" });
  expect(active).toMatchObject({ ok: false, outlived: true });
} finally {
  rmSync(join(dir, "drive-hold"), {force: true});
}
const ended = await waitFor(() => readEnded(id) ?? undefined);
expect(ended.state).toMatchObject({
  kind: "ended", exit: { code: 0 },
  process: { supervision: { child: { pgid: expect.any(Number) } } },
});
const spool = join(process.env.HOME!, ".local", "state", "jig", "dispatch", "runs", id, "output.log");
await waitFor(() => existsSync(spool) && readFileSync(spool, "utf8").includes("the final output")
  ? true : undefined);
const recorded = JSON.parse(readFileSync(join(dir, "drive-runs.jsonl"), "utf8").trim());
expect(recorded).toMatchObject({
  configDir: join(repo.path, "selected-account"), token: null, codexHome: null,
  anthropicKey: null, openaiKey: null, launch: id,
});
let outerFinished = false;
while (performance.now() < until) {
  const rows = await processTable();
  if (rows !== null && !rows.some((row) => row.args.includes(id) && !row.stat.startsWith("Z"))) {
    outerFinished = true;
    break;
  }
  await Bun.sleep(20);
}
expect(outerFinished).toBe(true);
if (existsSync(join(dir, "orca-calls.log"))) throw new Error("used Orca");
const overflowId = "20261118T141627Z-22222222";
const overflow = openSpool(overflowId, (error) => { throw error; });
const block = Buffer.from(("x".repeat(1023) + "\\n").repeat(64));
overflow.write(Buffer.from("first output"));
for (let i = 0; i < 70; i++) overflow.write(block);
overflow.write(Buffer.from("the final output"));
overflow.close();
const tail = readFileSync(join(processRunDirectory(overflowId), "output.log"));
expect(tail.byteLength).toBe(4 * 1024 * 1024);
expect(tail.includes("first output")).toBe(false);
expect(tail.subarray(-16).toString()).toBe("the final output");
const redactedId = "20261118T141627Z-33333333";
const redacted = openSpool(redactedId, (error) => { throw error; });
redacted.write(Buffer.from("Authorization: Bearer ghp_abc"));
redacted.write(Buffer.from("defghijklmnopqrstuvwxyz0123456789\\n"));
redacted.close();
const secretOutput = readFileSync(join(processRunDirectory(redactedId), "output.log"), "utf8");
expect(secretOutput).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
expect(secretOutput).toContain("[redacted]");
const boundaryId = "20261118T141627Z-44444444";
const boundary = openSpool(boundaryId, (error) => { throw error; });
boundary.write(Buffer.from("prefix gh"));
boundary.write(Buffer.concat([Buffer.from("p_" + "a".repeat(36) + "\\n"), Buffer.alloc(32729, "x")]));
expect(readFileSync(join(processRunDirectory(boundaryId), "output.log"), "utf8")).toBe("");
boundary.close();
const boundaryOutput = readFileSync(join(processRunDirectory(boundaryId), "output.log"), "utf8");
expect(boundaryOutput).not.toContain("ghp_" + "a".repeat(36));
expect(boundaryOutput).toContain("[redacted]");
const splitId = "20261118T141627Z-55555555";
const split = openSpool(splitId, (error) => { throw error; });
split.write(Buffer.from("password= "));
split.write(Buffer.from("sensitive\\n" + "x".repeat(32760)));
split.close();
expect(readFileSync(join(processRunDirectory(splitId), "output.log"), "utf8")).not.toContain("sensitive");
const longId = "20261118T141627Z-66666666";
const long = openSpool(longId, (error) => { throw error; });
long.write(Buffer.from("token="));
const run = Buffer.alloc(64 * 1024, "y");
for (let i = 0; i < 50; i++) long.write(run);
long.write(Buffer.from("\\nafter\\n"));
long.close();
const longOutput = readFileSync(join(processRunDirectory(longId), "output.log"), "utf8");
expect(longOutput).not.toContain("yyyy");
expect(longOutput).toContain("oversized line dropped");
expect(longOutput.endsWith("\\nafter\\n")).toBe(true);
const newlineId = "20261118T141627Z-77777777";
const newline = openSpool(newlineId, (error) => { throw error; });
newline.write(Buffer.from("password=\\n"));
newline.write(Buffer.from("sensitive" + " ".repeat(32768)));
newline.close();
expect(readFileSync(join(processRunDirectory(newlineId), "output.log"), "utf8")).not.toContain("sensitive");
const suffixId = "20261118T141627Z-88888888";
const suffix = openSpool(suffixId, (error) => { throw error; });
suffix.write(Buffer.alloc(65536, "y"));
suffix.write(Buffer.from("\\nafter\\n"));
suffix.close();
const suffixOutput = readFileSync(join(processRunDirectory(suffixId), "output.log"), "utf8");
expect(suffixOutput).not.toContain("yyyy");
expect(suffixOutput).toContain("after");

`,
      );
      // Ensure the detached process backend is used in this isolated fixture,
      // even when the test host runs a real systemd user manager.
      const child = await w.dispatch([], runner, {
        XDG_RUNTIME_DIR: join(w.root, "absent-manager"),
        ORCA_CLI_COMMAND: join(w.root, "must-not-run-orca"),
        ANTHROPIC_API_KEY: "not-kept",
        OPENAI_API_KEY: "not-kept",
        CODEX_HOME: join(w.root, "wrong-account"),
      });
      expectSpawnExit(child, 0);
      expect(existsSync(join(w.dir, "drive-runs.jsonl"))).toBe(true);
    } finally {
      w.close();
    }
  },
  30_000,
);
