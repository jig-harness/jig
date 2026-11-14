import { JigError } from "../../../../../shared/outcome.ts";

/**
 * `Tracker.assignedBy`'s definite answer that no user made the assignment:
 * the history, read in full, holds no assignment of the account, or the one
 * it holds was made by no user (an integration or an automation). Unlike a
 * failed or refused read, it stays true until the issue changes, so a caller
 * may keep it by the issue's update time.
 */
export class AssignerUnknown extends JigError<"assigner-unknown"> {
  override name = "AssignerUnknown";
  constructor(reason: string) {
    super("assigner-unknown", reason);
  }
}
