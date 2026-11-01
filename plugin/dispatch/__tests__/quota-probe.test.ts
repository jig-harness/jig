/**
 * `run.ts quota`: the wall an interactive session met, read from that
 * session's own Claude Code record in the account's configuration
 * directory, matched on the session id the tick minted; and whether the
 * session's last record is still that wall.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ProbedWall } from "../lib/quota-probe.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const SESSION = "5b0c1d2e-3f40-4152-8a6b-7c8d9e0f1a2b";
const CWD = "/work/example-repo-12";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function wallLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    cwd: CWD,
    sessionId,
    timestamp,
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: {
      content: [
        {
          type: "text",
          text: "You've hit your session limit · resets 6:40pm (UTC)",
        },
      ],
    },
  });
}

function probe(configDir: string, since: string): ProbedWall | null {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("DRIVE_PR_")) env[k] = v;
  env.CLAUDE_CONFIG_DIR = configDir;
  const done = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      RUN_TS,
      "quota",
      SESSION,
      CWD,
      since,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(done, 0);
  return JSON.parse(done.stdout.toString()) as ProbedWall | null;
}

describe("the quota probe for an interactive session", () => {
  it("reads the wall the session met from its own record, and whether it is still the last", () => {
    const config = mkdtempSync(join(tmpdir(), "dispatch-quota-"));
    dirs.push(config);
    const project = join(config, "projects", "-work-example-repo-12");
    mkdirSync(project, { recursive: true });
    const file = join(project, `${SESSION}.jsonl`);
    const at = new Date(Date.now() - 3 * 3_600_000);
    at.setUTCMilliseconds(0);
    const since = new Date(at.getTime() - 3_600_000).toISOString();
    // Another session's wall in the same directory is not this session's.
    writeFileSync(
      join(project, "other.jsonl"),
      `${wallLine("0f0f0f0f-0000-4000-8000-000000000000", new Date(at.getTime() + 60_000).toISOString())}\n`,
    );
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", cwd: CWD, sessionId: SESSION, timestamp: since })}\n${wallLine(SESSION, at.toISOString())}\n`,
    );

    const found = probe(config, since);
    expect(found).toMatchObject({
      observedAt: at.toISOString(),
      window: "short",
      last: true,
    });
    expect(Date.parse(found?.resetAt ?? "")).toBeGreaterThan(at.getTime());

    appendFileSync(
      file,
      `${JSON.stringify({ type: "user", cwd: CWD, sessionId: SESSION, timestamp: new Date().toISOString() })}\n`,
    );
    expect(probe(config, since)?.last).toBe(false);
    expect(probe(config, new Date().toISOString())).toBeNull();
  });
});
