import { ledgerDriverRecord } from "./ledger-render-context.ts";
import { readLedgerSnapshot } from "./ledger-forge.ts";
import { fail, failFrom } from "../cli.ts";
/** Admission against the exact redacted ledger renderer, under the state lock. */
import {
  checkParkedDecision,
  DECISION_BYTE_LIMIT,
  type ParkedDecision,
} from "../../../../../shared/decisions/park.ts";
import type { DriveState } from "./schema.ts";
import {
  effectiveClaims,
  type LedgerClaimRef,
  ledgerFromState,
  renderLedger,
} from "./ledger.ts";
import { ledgerDriverFromEnv } from "./ledger-mirror.ts";
import { localWriter } from "../../../../../shared/records/writer.ts";

export interface ParkAdmissionContext {
  generation: number;
  claims: LedgerClaimRef[];
  stateDir?: string;
}

/** Observe forge metadata before taking the synchronous state lock. */
export async function parkAdmissionContext(
  pr: string,
  stateDir?: string,
): Promise<ParkAdmissionContext | undefined> {
  const driver = ledgerDriverFromEnv();
  if (driver === null) return undefined;
  const snapshot = await readLedgerSnapshot(pr, driver.login);
  if (typeof snapshot === "string")
    fail(2, `park: cannot verify ledger capacity: ${snapshot}`);
  const claims =
    driver.claim === null ||
    snapshot.claims.some((c) => c.id === driver.claim?.id)
      ? snapshot.claims
      : [...snapshot.claims, driver.claim];
  return {
    ...(stateDir === undefined ? {} : { stateDir }),
    generation: snapshot.maxGeneration,
    claims: effectiveClaims(claims).map((c) => ({
      id: c.id,
      clone: c.claim.clone,
      generation: c.claim.generation,
    })),
  };
}

export function parkAdmissionProblem(
  state: DriveState,
  decision: ParkedDecision,
  context?: ParkAdmissionContext,
): string | null {
  const size = new TextEncoder().encode(JSON.stringify(decision)).length;
  if (size > DECISION_BYTE_LIMIT)
    return `decision is ${size} bytes; limit is ${DECISION_BYTE_LIMIT} bytes`;
  const driver = ledgerDriverFromEnv();
  const ledger = ledgerFromState(state, {
    generation:
      Math.max(state.ledgerGeneration ?? 0, context?.generation ?? 0) + 1,
    driver: ledgerDriverRecord(driver, context?.stateDir, String(state.pr)),
    narrative: [],
    claims:
      context?.claims ??
      (driver?.claim == null
        ? []
        : [
            {
              id: driver.claim.id,
              clone: driver.claim.claim.clone,
              generation: driver.claim.claim.generation,
            },
          ]),
  });
  const rendered = renderLedger(
    ledger,
    undefined,
    localWriter("forge", driver?.login),
  );
  return "error" in rendered
    ? `decision is ${size} bytes; ${rendered.error}`
    : null;
}

export function readParkedDecision(
  text: string,
  parkClass: string,
): ParkedDecision {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    failFrom(
      error,
      2,
      `park: expected ParkedDecision JSON, not Markdown. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const decisionBytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (decisionBytes > DECISION_BYTE_LIMIT)
    fail(
      2,
      `park: decision is ${decisionBytes} bytes; limit is ${DECISION_BYTE_LIMIT} bytes.`,
    );
  const problems = checkParkedDecision(value, parkClass);
  const parsed = problems.length
    ? { problems }
    : { decision: value as ParkedDecision };
  if ("problems" in parsed)
    fail(
      2,
      "park: the decision record is incomplete:",
      ...parsed.problems.map((p) => `  - ${p}`),
    );
  return parsed.decision;
}
