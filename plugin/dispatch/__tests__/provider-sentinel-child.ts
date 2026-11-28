/**
 * Run in a child whose home is the test's own: a provider account's launch
 * that fails to resolve its credential, then one that resolves it and runs a
 * pass that prints it everywhere it can, through the wrapper's steps that
 * keep a record of each (`provider-sentinel.test.ts`). Prints what happened
 * as one JSON line.
 *
 * argv: the credential command's script, the failing command's script, the
 * workspace, the session id.
 */
import { ok } from "../../shared/outcome.ts";
import { currentIso } from "../../shared/time.ts";
import { dump } from "../../shared/yaml.ts";
import { settleUnreported } from "../lib/end-report.ts";
import {
  type LaunchRecord,
  newRecordId,
  readEnded,
  recordExit,
  writeRecord,
} from "../lib/launches.ts";
import { logEnded } from "../lib/log-ended.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import {
  launchCredential,
  redactedRan,
  stageEnvironment,
  stampProvider,
} from "../lib/provider-launch.ts";
import { runStage } from "../lib/run-stage.ts";
import { openSpool } from "../lib/runtime/process-spool.ts";
import { keepTranscriptCopy } from "../lib/transcript-copy.ts";

/** The value the test's credential command prints, which no record may hold. */
export const SENTINEL = "sentinel-credential-7f3a9c2e1b";
/** The session the pass's transcript is written under. */
export const SESSION = "0b4f6a2e-6c1d-4e2a-9f3b-5d8c7e6a1b2c";

/** What the child prints. */
export interface SentinelResult {
  refusedStarted: boolean;
  started: boolean;
  carried: string | undefined;
  provider: LaunchRecord["provider"];
  said: string | null;
  copied: string | null;
  ended: number;
  unlogged: string[];
}

async function main(): Promise<void> {
  const [credentialScript, failingScript, workspace, session] =
    process.argv.slice(2) as [string, string, string, string];

  const parsed = parseMachineConfigText(
    dump({
      credential_command: [process.execPath, credentialScript],
      accounts: [
        {
          name: "router",
          kind: "provider",
          harness: "claude-code",
          provider: "openrouter",
          base_url: "https://openrouter.ai/api",
          credential: "op://Jig/router/credential",
          spend_cap: { daily: "20.00" },
        },
      ],
    }),
    "machine",
  );
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  const machine = parsed.value;
  const account = machine.accounts[0] as (typeof machine.accounts)[number];
  const failing = {
    ...machine,
    credentials: {
      ...(machine.credentials as NonNullable<typeof machine.credentials>),
      credentialCommand: [process.execPath, failingScript],
    },
  };

  function launchRecord(id: string): LaunchRecord {
    const record: LaunchRecord = {
      version: 1,
      id,
      token: `token-${id}`,
      action: "pickup",
      repo: "example-org/alpha",
      repoPath: workspace,
      pr: null,
      item: "ENG-1",
      account: account.name,
      vendor: "claude",
      configDir: account.configDir,
      wallBackoffMs: 3_600_000,
      replaces: null,
      facts: "",
      createdAt: currentIso(),
      workspace: { id: "ws-1", path: workspace },
      attempts: [],
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
      sessionId: session,
    };
    stampProvider(record, account);
    writeRecord(record);
    return record;
  }

  const refused = launchRecord(newRecordId());
  const refusedStarted = await launchCredential(
    refused,
    async () => undefined,
    () => ok(failing),
  );

  const record = launchRecord(newRecordId());
  const started = await launchCredential(
    record,
    async () => undefined,
    () => ok(machine),
  );
  const env = stageEnvironment(process.env, record);
  const spool = openSpool(record.id, () => undefined);
  const PASS = `
  const key = process.env.ANTHROPIC_API_KEY;
  const { mkdirSync, writeFileSync } = require("node:fs");
  const dir = process.env.CLAUDE_CONFIG_DIR + "/projects/p";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/${session}.jsonl", JSON.stringify({ type: "assistant", text: "the key is " + key }) + "\\n");
  console.log("stdout " + key);
  console.error("stderr " + key);
  console.log("Question: is " + key + " the right key?");
  process.exit(1);
  `;
  const ran = redactedRan(
    await runStage([process.execPath, "-e", PASS], workspace, env, {
      keepOutput: true,
      deadlineSec: 0,
    }),
  );
  spool.write(
    Buffer.from(`${ran.output ?? ""}\nraw ${env.ANTHROPIC_API_KEY}\n`),
  );
  spool.close();
  recordExit(record.id, {
    at: currentIso(),
    code: ran.code,
    signal: null,
    session,
    ...(ran.output === undefined ? {} : { context: ran.output }),
    ...(ran.said === undefined ? {} : { said: ran.said }),
  });
  settleUnreported(
    record,
    {
      code: ran.code,
      signal: null,
      timedOut: false,
      ...(ran.output === undefined ? {} : { output: ran.output }),
    },
    session,
  );
  const copy = keepTranscriptCopy(record, session);
  const ended = [readEnded(record.id), readEnded(refused.id)].filter(
    (r) => r !== null,
  );
  const unlogged = await logEnded(ended, {
    all: ended,
    drives: null,
    merged: async () => null,
    nowIso: currentIso(),
  });
  const result: SentinelResult = {
    refusedStarted,
    started,
    carried: env.ANTHROPIC_API_KEY,
    provider: record.provider,
    said: ran.said ?? null,
    copied: copy?.transcript ?? null,
    ended: ended.length,
    unlogged,
  };
  console.log(JSON.stringify(result));
}

if (import.meta.main) await main();
