/** The dispatcher checks the account through Claude Code without reading its credentials. */
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { readJsonFile, writeJsonFile } from "../../shared/gh-cache-storage.ts";
import {
  credentialKey,
  defaultGovernor,
  isRateLimited,
} from "../../shared/outbound/budget.ts";
import type { FailureClass } from "../../shared/outbound/failure.ts";
import { recordCall } from "../../shared/outbound/ledger.ts";
import { run, type RunResult } from "../../shared/proc.ts";
import { currentMs } from "../../shared/time.ts";
import { stateRoot } from "../receipts.ts";
import { signInPhrase } from "./session-startup.ts";

export const SIGN_IN_TIMEOUT_SEC = 8;
const REUSE_MS = 10 * 60_000;
const NO_ANSWER_REUSE_MS = 60_000;

/** Check the Claude profile even when the tick's shell names another provider. */
function probeEnvironment(env: Record<string, string>): Record<string, string> {
  const isolated: Record<string, string> = {
    ...env,
    DISABLE_NONESSENTIAL_MODEL_CALLS: "1",
  };
  for (const key of Object.keys(isolated))
    if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_))/i.test(key))
      delete isolated[key];
  return isolated;
}

export type SignInCheck = { failure: FailureClass | null; at: number };
type Probe = Pick<
  RunResult,
  "stdout" | "stderr" | "code" | "timedOut" | "spawnFailed"
>;

function resultOf(child: Probe): {
  failure: FailureClass | null;
  cost: number | null;
} {
  let json: unknown;
  try {
    json = JSON.parse(child.stdout);
  } catch {
    json = null;
  }
  const result = isMapping(json) ? json : {};
  const cost =
    typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
  if (child.timedOut || child.spawnFailed)
    return { failure: "unreachable", cost };
  if (child.code === 0 && result.is_error === false)
    return { failure: null, cost };
  if (
    signInPhrase(child.stderr) !== undefined ||
    signInPhrase(
      typeof result.result === "string" ? result.result : child.stdout,
    ) !== undefined
  )
    return { failure: "unauthorized", cost };
  return { failure: "invalid", cost };
}

/** A local auth status may report a stored but expired login. A tool-free,
 * bounded Haiku print call exercises the same sign-in path as a pass. */
export async function checkClaudeSignIn(
  configDir: string,
  env: Record<string, string>,
  root = stateRoot(),
): Promise<SignInCheck> {
  const credential = credentialKey("claude", configDir);
  const dir = join(root, "claude-sign-in");
  const file = join(dir, `${credential.split(":").at(-1)}.json`);
  const cached = readJsonFile(file);
  const at = currentMs();
  const failure = cached?.failure;
  if (
    typeof cached?.at === "number" &&
    cached.at <= at &&
    (failure === null ||
      failure === "unauthorized" ||
      failure === "unreachable" ||
      failure === "invalid" ||
      failure === "rate-limited") &&
    at - cached.at < (failure === null ? REUSE_MS : NO_ANSWER_REUSE_MS)
  )
    return { failure, at: cached.at };

  let answer: ReturnType<typeof resultOf>;
  let requests = 0;
  try {
    defaultGovernor().admit("claude", credential);
    const child = await run(
      [
        "claude",
        "--print",
        "--output-format",
        "json",
        "--model",
        "haiku",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--max-budget-usd",
        "0.02",
        "--",
        "Reply OK.",
      ],
      {
        timeoutSec: SIGN_IN_TIMEOUT_SEC,
        maxBufferBytes: 32 * 1024,
        reapGroup: true,
        cwd: configDir,
        env: probeEnvironment(env),
      },
    );
    requests = child.spawnFailed ? 0 : 1;
    answer = resultOf(child);
  } catch (error) {
    answer = {
      failure: isRateLimited(error) ? "rate-limited" : "unreachable",
      cost: null,
    };
  }
  recordCall({
    system: "claude",
    credential,
    operation: "sign-in probe",
    requests,
    cost: answer.cost,
    unit: "USD",
    durationMs: currentMs() - at,
    failure: answer.failure,
  });
  const check = { failure: answer.failure, at: currentMs() };
  writeJsonFile(dir, file, check);
  return check;
}
