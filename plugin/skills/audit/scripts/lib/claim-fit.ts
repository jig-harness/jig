/**
 * The claim's start states beside the dispatcher's: `do_item.claim_from`
 * limits every claim, `dispatch.states` the items the dispatcher picks up,
 * and `dispatch.pool.states` the states of its ready pool.
 * Each is a repository's own choice, so a difference is not an error; but a
 * dispatched pickup in a state the claim refuses is launched only to be
 * refused, and a claim that allows a state the dispatcher never picks up
 * from is easy to miss, so a difference is reported.
 */
import type { Finding } from "./schema.ts";

type Config = Record<string, unknown>;

function listAt(
  config: Config,
  section: string,
  field: string,
): string[] | null {
  const [head, ...rest] = section.split(".");
  let part = config[head as string];
  for (const key of rest)
    part =
      part !== null && typeof part === "object" && !Array.isArray(part)
        ? (part as Record<string, unknown>)[key]
        : undefined;
  if (part === null || typeof part !== "object" || Array.isArray(part))
    return null;
  const value = (part as Record<string, unknown>)[field];
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null;
}

/** A warning when both lists are set and name different states. */
export function claimFromFindings(config: Config): Finding[] {
  const claimFrom = listAt(config, "do_item", "claim_from");
  const dispatch = listAt(config, "dispatch", "states");
  if (claimFrom === null || dispatch === null) return [];
  const refused = dispatch.filter((s) => !claimFrom.includes(s));
  const unused = claimFrom.filter((s) => !dispatch.includes(s));
  if (refused.length === 0 && unused.length === 0) return [];
  const parts = [
    ...(refused.length === 0
      ? []
      : [
          `the dispatcher picks up from ${refused.join(", ")}, which do_item.claim_from refuses, so those pickups are launched only to be refused`,
        ]),
    ...(unused.length === 0
      ? []
      : [
          `do_item.claim_from allows ${unused.join(", ")}, which dispatch.states never picks up from`,
        ]),
  ];
  return [
    {
      id: "rule:do_item.claim_from",
      severity: "warning",
      message: `do_item.claim_from and dispatch.states differ: ${parts.join("; ")}`,
    },
  ];
}

/**
 * A warning when the ready pool names a state `do_item.claim_from` refuses:
 * every pickup from it would be launched only to be refused.
 */
export function poolClaimFindings(config: Config): Finding[] {
  const claimFrom = listAt(config, "do_item", "claim_from");
  const pool = listAt(config, "dispatch.pool", "states");
  if (claimFrom === null || pool === null) return [];
  const refused = pool.filter((s) => !claimFrom.includes(s));
  if (refused.length === 0) return [];
  return [
    {
      id: "rule:dispatch.pool.states",
      severity: "warning",
      message: `dispatch.pool.states names ${refused.join(", ")}, which do_item.claim_from refuses, so every pickup from there is launched only to be refused`,
    },
  ];
}
