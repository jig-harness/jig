/**
 * The requests a person makes of the dispatcher, as the tick reads them,
 * written for `jig send` (`send/`):
 *
 * - **A command label** (`dispatch-command-label`): `drive` or `hold`
 *   under the repository's prefix, added to or removed from a pull request
 *   in one `gh pr edit` call. The tick reads `drive` to arm a drive on a
 *   pull request with no ledger and `hold` to keep every stage off it
 *   (`labels.ts`); it never adds either, and removes `drive` only once a
 *   ledger exists.
 * - **A pick-up assignment** (`dispatch-pickup-assignment`): the item
 *   assigned to the factory identity (`dispatch.identity`) and, when it is
 *   in none of the dispatch states (`dispatch.states`), moved to the first
 *   of them, through the tracker interface. The tick starts a pick-up for
 *   it only when the person who made the assignment can write to the
 *   repository (`sources/tracker.ts`), so writing it adds no authority.
 *
 * Each returns a failure as a value: the forge or the tracker refusing the
 * write, or an identity that names no user.
 */
import type {
  CanonicalState,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { editLabels } from "./forge.ts";
import { failureText } from "./text.ts";

/** Add (`add`) or remove a command label on pull request `pr` of `slug`. */
export async function writeCommandLabel(
  slug: string,
  pr: number,
  label: string,
  add: boolean,
  edit: typeof editLabels = editLabels,
): Promise<Outcome<void, "refused">> {
  try {
    await edit(slug, pr, add ? [label] : [], add ? [] : [label]);
    return ok(undefined);
  } catch (error) {
    return failed(
      "refused",
      `the forge refused to ${add ? "add" : "remove"} ${label} on pull request ${pr}: ${failureText(error)}`,
      error,
    );
  }
}

/** The tracker operations a pick-up assignment uses. */
export type AssignTracker = Pick<Tracker, "user" | "assign" | "transition">;

/**
 * Assign item `key` to the factory identity and, with `move`, move it to
 * that dispatch state; the assignment first, so an item never sits in a
 * dispatch state assigned to someone else.
 */
export async function assignPickup(
  tracker: AssignTracker,
  key: string,
  identity: string,
  move: CanonicalState | null,
): Promise<Outcome<void, "refused">> {
  try {
    const user = await tracker.user(identity);
    await tracker.assign(key, user);
    if (move !== null) await tracker.transition(key, move);
    return ok(undefined);
  } catch (error) {
    return failed(
      "refused",
      `the tracker did not take the assignment of ${key} to ${identity}: ${failureText(error)}`,
      error,
    );
  }
}
