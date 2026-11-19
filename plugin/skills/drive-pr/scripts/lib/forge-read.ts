/**
 * How a drive's read of the forge failed: one of the failure classes every
 * outbound call reports (`shared/outbound/failure.ts`), or `malformed` when
 * the forge answered with something that does not read.
 */
import type { FailureClass } from "../../../../shared/outbound/failure.ts";
import {
  type GhRun,
  ghRunFailure,
} from "../../../../shared/outbound/github.ts";

export type ForgeReadCode = FailureClass | "malformed";

/** The class of a `gh` run that exited non-zero. */
export function forgeReadClass(run: GhRun): FailureClass {
  return ghRunFailure(run)?.code ?? "invalid";
}
