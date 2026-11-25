import { type Adoption, adopts, requiresManualTrustedDrive } from "../adopt.ts";
import { hasCommand, type LabelConfig } from "../labels.ts";
import { pickupAsked, type PickupArms } from "../pickup-arms.ts";
import type { DrivenPr } from "../types.ts";
import type { OpenPr } from "./ledgers.ts";

/** What a reading holds that decides whether a pull request with no ledger is armed. */
export interface ArmingReading {
  labels: LabelConfig | null;
  adoption: Adoption | null;
  nowMs: number;
  pickupArms?: PickupArms;
}

/**
 * A pull request with no ledger whose `drive` label asks for one, or which
 * the repository's adoption rule adopts: the plan arms it once per head
 * commit.
 */
export function unarmed(
  pr: OpenPr,
  base: Omit<DrivenPr, "class" | "why" | "evidence">,
  r: ArmingReading,
): DrivenPr | null {
  const asked = askedToArm(pr, r);
  if (asked === null) return null;
  // The once-per-head rule needs the commit it arms: without one nothing starts.
  if (typeof pr.headRefOid !== "string" || pr.headRefOid === "")
    return {
      ...base,
      class: "unplaced",
      why: `no drive ledger, and ${asked.asks}, but the pull request's head commit does not read, so the once-per-head rule cannot be kept; nothing is armed`,
      evidence: {},
    };
  return {
    ...base,
    class: "unarmed",
    why: `no drive ledger, and ${asked.asks}: arm a drive on any account`,
    evidence: { ledger: "none", headSha: pr.headRefOid, ...asked.evidence },
  };
}

/** What asks for a pull request with no ledger to be armed: a person's `drive` label, else the adoption rule; `null` when nothing does. */
function askedToArm(
  pr: OpenPr,
  r: ArmingReading,
): { asks: string; evidence: { adopted?: string; pickupArm?: true } } | null {
  const { labels, adoption } = r;
  if (labels !== null && hasCommand(labels, pr.labels, "drive"))
    return { asks: "a person's drive label asks for one", evidence: {} };
  if (requiresManualTrustedDrive(pr.author, adoption)) return null;
  if (pickupAsked(r.pickupArms, pr))
    return {
      asks: "its completed process pickup handed off the first drive",
      evidence: { pickupArm: true },
    };
  const adopted =
    adoption === null ? null : adopts(pr, adoption, labels, r.nowMs);
  return adopted === null
    ? null
    : {
        asks: "the repository's adoption rule (dispatch.adopt) adopts it",
        evidence: { adopted },
      };
}
