/** Apply a sign-in answer to the account shared by all of its launch lanes. */
import { swallow } from "../../../shared/errors.ts";
import { currentMs, isoFromMs } from "../../../shared/time.ts";
import type { TickReceipt } from "../../receipts.ts";
import {
  recordAccountSignInSuccess,
  recordAccountStartupProblem,
} from "../account-startup.ts";
import { passEnvironment, type IdentityCheck } from "../accounts.ts";
import { checkClaudeSignIn, type SignInCheck } from "../claude-sign-in.ts";
import type { MachineAccount } from "../machine-config.ts";
import {
  processEnvironment,
  type ProcessSettings,
} from "../runtime/process-environment.ts";
import { writeWall } from "../walls.ts";
import type { ApplyState } from "./launch.ts";

export type SignInChecks = Map<string, SignInCheck | "tick-deadline">;

export async function prelaunchSignIn(
  state: ApplyState,
  account: MachineAccount,
  identity: IdentityCheck,
  settings: ProcessSettings | undefined,
  hasTime: boolean,
): Promise<IdentityCheck> {
  state.signInChecks ??= new Map();
  const checks = state.signInChecks;
  const prior = checks.get(account.name);
  if (prior === "tick-deadline") return identity;
  if (prior !== undefined) return admission(prior, identity);
  if (!hasTime) {
    checks.set(account.name, "tick-deadline");
    return identity;
  }
  const selected = { vendor: account.vendor, configDir: account.configDir };
  const env =
    settings === undefined
      ? passEnvironment(process.env, selected)
      : processEnvironment(process.env, settings, selected);
  const checked = await checkClaudeSignIn(account.configDir, env, state.root);
  checks.set(account.name, checked);
  const observed = isoFromMs(checked.at);
  try {
    if (checked.failure === null)
      recordAccountSignInSuccess(account, observed, state.root);
    else if (checked.failure === "unauthorized") {
      writeWall(
        {
          account: account.name,
          vendor: account.vendor,
          configDir: account.configDir,
          source: "Claude Code sign-in probe refused",
          resetAt: isoFromMs(currentMs() + state.machine.wallBackoffMs),
        },
        state.root,
      );
      recordAccountStartupProblem(account, "sign-in", observed, state.root);
    }
  } catch (error) {
    swallow(error, "the account sign-in check could not be recorded");
  }
  return admission(checked, identity);
}

function admission(check: SignInCheck, identity: IdentityCheck): IdentityCheck {
  return check.failure === "unauthorized"
    ? { ok: false, reason: "Claude Code rejected the account sign-in" }
    : identity;
}

export function signInFallbackReport(
  checks?: SignInChecks,
): Pick<TickReceipt, "signInFallbacks"> {
  const fallback = [...(checks ?? [])].flatMap(([account, check]) => {
    const failure = check === "tick-deadline" ? check : check.failure;
    return failure !== null && failure !== "unauthorized"
      ? [{ account, failure }]
      : [];
  });
  return fallback.length === 0 ? {} : { signInFallbacks: fallback };
}
