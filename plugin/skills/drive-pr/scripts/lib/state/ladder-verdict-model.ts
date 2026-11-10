/** Stored decline-ladder evidence and its validation, independent of state I/O. */
import { isRecord } from "../../../../../shared/guards.ts";

export interface RecordedLadderVerdict {
  key: string;
  stance: "accepted" | "declined";
  round: number;
}

export function isVerdict(value: unknown): value is RecordedLadderVerdict {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    value.key !== "" &&
    !/[\n\r]/.test(value.key) &&
    (value.stance === "accepted" || value.stance === "declined") &&
    typeof value.round === "number" &&
    Number.isSafeInteger(value.round) &&
    value.round >= 0
  );
}

export function isOptionalLadderVerdicts(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every(isVerdict))
  );
}
