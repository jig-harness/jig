/** Conditional reads share one cache implementation and retain this caller's process transport. */
import { createConditionalCache } from "../../../../shared/gh-conditional.ts";
import * as proc from "./proc.ts";
import { git } from "./proc.ts";
export { withObservedEvaluation } from "../../../../shared/gh-conditional.ts";
export type {
  CallContext,
  ConditionalGet,
  PrLiveness,
} from "../../../../shared/gh-conditional.ts";
export const {
  ghCacheDir,
  ghConditionalGet,
  ghConditionalProbe,
  ghObservedSlurp,
  resetProbeBaselines,
  readPrLiveness,
  checkSignalsUnchanged,
  cachedRepoView,
} = createConditionalCache({
  // Looked up at each call, so a test that replaces this module's `ghCall`
  // replaces the transport of every read here too.
  ghCall: (args, opts) =>
    opts === undefined ? proc.ghCall(args) : proc.ghCall(args, opts),
  git,
});
