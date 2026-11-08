import { JigError } from "./errors.ts";

/** An expected collection refusal or unavailable proof, preserved in receipts. */
export class GcError extends JigError {
  override name = "GcError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super("refused", reason, options);
  }
}
