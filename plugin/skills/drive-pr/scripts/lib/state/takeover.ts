/**
 * `takeovers`: the record a `drive.ts --take-over` leaves in the drive state,
 * one entry per takeover, oldest first. It says who stopped driving and who
 * took over (the working-tree actor and the hashed billing account of each),
 * the doctor verdict that admitted it, the round it resumed at, and the held
 * items not verified as pushed and reopened, and whether the reconciliation ran.
 *
 * Optional in a stored state, like `drivenBranch`: a state file written
 * before the field existed reads as no takeovers, since nothing about a
 * drive in progress changes when the field appears. A value that is present
 * must be well-formed.
 */
import { fail, failFrom } from "../cli.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { isAccountHash } from "../identity.ts";
import { isActorId } from "./actor.ts";
import type { StateStore } from "./store.ts";

/**
 * What a takeover is admitted against: the doctor's `WEDGED`, a `DEAD`
 * holder, or, across clones, a `STALE` ledger heartbeat (`lib/driver/ledger.ts`).
 */
export const TAKEOVER_VERDICTS = ["WEDGED", "DEAD", "STALE"] as const;

export interface TakeoverRecord {
  /** When the takeover was recorded. */
  at: string;
  /** The working tree that drove before, `null` when it could not be named. */
  fromActor: string | null;
  /** The account the previous driver's pass billed, hashed; `null` unknown. */
  fromAccount: string | null;
  /** The working tree that drives now. */
  toActor: string;
  /** The account this driver's pass bills, hashed; `null` unknown. */
  toAccount: string | null;
  /** `WEDGED`, `DEAD` for a holder whose process was gone, `STALE` across clones. */
  verdict: (typeof TAKEOVER_VERDICTS)[number];
  /** The durable round the drive resumed at. */
  round: number;
  /** Held items not stamped as pushed, reopened by the takeover. */
  reopened: string[];
  /** `reconcile-replied-threads.ts` ran and exited 0 before the first triage. */
  reconciled?: boolean;
}

function isNullableAccount(v: unknown): boolean {
  return v === null || isAccountHash(v);
}

function isNullableActor(v: unknown): boolean {
  return v === null || (typeof v === "string" && isActorId(v));
}

export function isTakeoverRecord(v: unknown): v is TakeoverRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.at === "string" &&
    Number.isFinite(Date.parse(t.at)) &&
    isNullableActor(t.fromActor) &&
    isNullableAccount(t.fromAccount) &&
    typeof t.toActor === "string" &&
    isActorId(t.toActor) &&
    isNullableAccount(t.toAccount) &&
    TAKEOVER_VERDICTS.includes(t.verdict as TakeoverRecord["verdict"]) &&
    typeof t.round === "number" &&
    Number.isInteger(t.round) &&
    t.round >= 0 &&
    Array.isArray(t.reopened) &&
    t.reopened.every(
      (k) => typeof k === "string" && k.length > 0 && !/[\n\r]/.test(k),
    ) &&
    (t.reconciled === undefined || typeof t.reconciled === "boolean")
  );
}

/** Absent, or a list of well-formed records: what a stored state may hold. */
export function isOptionalTakeovers(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isTakeoverRecord));
}

/**
 * `drive-state.ts takeover <PR>`: append the record `drive.ts --take-over`
 * hands over on standard input as JSON (`fromActor`, `fromAccount`,
 * `toAccount`, `verdict`, `reopened`). The taking tree's actor, the time and
 * the round are this command's own, never the caller's.
 */
export async function recordTakeover(
  store: StateStore,
  raw: string,
  toActor: string,
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return failFrom(e, 2, "takeover: standard input must be a JSON object");
  }
  if (!isRecord(parsed))
    return fail(2, "takeover: standard input must be a JSON object");
  const input = parsed;
  let invalid = "";
  await store.update((s) => {
    const record = {
      at: new Date().toISOString(),
      fromActor: input.fromActor ?? null,
      fromAccount: input.fromAccount ?? null,
      toActor,
      toAccount: input.toAccount ?? null,
      verdict: input.verdict,
      round: s.rounds,
      reopened: input.reopened ?? [],
      ...(input.reconciled === undefined
        ? {}
        : { reconciled: input.reconciled }),
    };
    if (!isTakeoverRecord(record)) {
      invalid = JSON.stringify(input);
      return s;
    }
    return { ...s, takeovers: [...(s.takeovers ?? []), record] };
  });
  if (invalid !== "")
    return fail(2, `takeover: not a well-formed takeover record: ${invalid}`);
  return 0;
}
