/** What an ended launch hands to: a station, a person's act, or nobody. */
import {
  parseAddress,
  checkKey,
  resolveRepository,
} from "../../shared/address.ts";
import { swallow } from "../../shared/errors.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { actOfClass } from "../../shared/acts.ts";
import type { FramedResult } from "./framed-result.ts";
import type { LaunchAction } from "./launches.ts";
import type { SessionResult } from "./session-result-types.ts";

export type NextOwner =
  | { address: string }
  | { person: string; act: string }
  | { none: string };

/** Read a launch's separately owned result handoff; old records have none. */
export function readNext(value: string | null | undefined): NextOwner | null {
  if (value == null) return null;
  try {
    const n: unknown = JSON.parse(value);
    return normalizeNext(n);
  } catch (error) {
    swallow(
      error,
      "a historic launch handoff that does not read is left unknown",
    );
    return null;
  }
}

/** Validate a persisted handoff before any consumer renders it. */
export function normalizeNext(n: unknown): NextOwner | null {
  if (!isMapping(n)) return null;
  const keys = Object.keys(n);
  if (keys.length === 1 && typeof n.address === "string") {
    const address = parseAddress(n.address);
    if (!address.ok) return null;
    const a = address.value;
    // Persisted handoffs must resolve without a checkout or dispatch configuration.
    if (!resolveRepository(a.repo, { known: [], checkout: null }).ok)
      return null;
    if (a.station !== "pickup" && !checkKey(a.station, a.key, null).ok)
      return null;
    return { address: n.address };
  }
  if (
    keys.length === 2 &&
    typeof n.person === "string" &&
    n.person.trim() &&
    typeof n.act === "string" &&
    n.act.trim()
  )
    return { person: n.person, act: n.act };
  if (keys.length === 1 && typeof n.none === "string" && n.none.trim())
    return { none: n.none };
  return null;
}

/** The handoff fixed by the line; unknown ends explicitly keep no next owner. */
export function derivedNext(
  stage: LaunchAction,
  cls: string,
  reason: string,
): NextOwner {
  if ((stage === "rearm" || stage === "takeover") && cls === "converged")
    return { person: "repository maintainer", act: "merge the pull request" };
  if (stage === "followup" && cls === "converged")
    return { none: "the follow-up is complete" };
  if (cls === "merged")
    return { none: "this drive ended after the pull request merged" };
  return { none: `no handoff was recorded: ${reason}` };
}

/**
 * The handoff of a pass parked on the decision it framed: the person who
 * answers it, and the act its class asks for (`actOfClass`) with its
 * question.
 */
export function parkedNext(framed: FramedResult): NextOwner {
  const { decision } = framed;
  return {
    person: "repository maintainer",
    act: `${actOfClass(decision.class)} (${decision.class}): ${decision.call.question}`,
  };
}

/** What an ended pickup or follow-up recorded, as its ended row's handoff reads it. */
export interface EndedAnswer {
  result: SessionResult | null;
  /** The handoff the session recorded with its result. */
  next: NextOwner | null;
  framed?: FramedResult | undefined;
  class: string;
  reason: string;
}

/**
 * An ended row's handoff: a parked pass's is the person and act its
 * decision names, a pickup's done or waiting one the handoff it recorded
 * (`null` when it recorded none), and any other the line's (`derivedNext`).
 */
export function endedNext(
  stage: LaunchAction,
  ended: EndedAnswer,
): NextOwner | null {
  if (ended.result === "parked" && ended.framed !== undefined)
    return parkedNext(ended.framed);
  if (
    stage === "pickup" &&
    (ended.result === "done" || ended.result === "waits")
  )
    return ended.next;
  return derivedNext(stage, ended.class, ended.reason);
}

/** Text form shared by the operator's answer and the outcome's readers. */
export function nextText(next: NextOwner): string {
  if ("address" in next) return next.address;
  if ("person" in next) return `person: ${next.person} — ${next.act}`;
  return `none: ${next.none}`;
}
