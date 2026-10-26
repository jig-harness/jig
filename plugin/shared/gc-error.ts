/** An expected collection refusal or unavailable proof, preserved in receipts. */
export class GcError extends Error {
  override name = "GcError";
}
/** Bad configuration is distinct from a failed inventory or removal. */
export class GcConfigurationError extends GcError {
  override name = "GcConfigurationError";
}
