/** Conditional reads share one cache implementation and retain this caller's process transport. */
import { createConditionalCache } from "../../../../shared/gh-conditional.ts";
import { ghCall, git } from "./proc.ts";
export type {
  CallContext,
  ConditionalGet,
  PrLiveness,
} from "../../../../shared/gh-conditional.ts";
export const {
  ghCacheDir,
  ghConditionalGet,
  ghConditionalProbe,
  resetProbeBaselines,
  readPrLiveness,
  checkSignalsUnchanged,
  cachedRepoView,
} = createConditionalCache({ ghCall, git });
