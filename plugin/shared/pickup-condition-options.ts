/** The two options that name what a pickup waits on, shared by the commands that write a pickup hold. */
import { option, optional, string, type Message } from "./vendor/optique.mjs";

export function pickupConditionOptions(descriptions: {
  merged: Message;
  closed: Message;
}) {
  return {
    untilMerged: optional(
      option("--until-merged", string({ metavar: "PR" }), {
        description: descriptions.merged,
      }),
    ),
    untilClosed: optional(
      option("--until-closed", string({ metavar: "ITEM" }), {
        description: descriptions.closed,
      }),
    ),
  };
}
