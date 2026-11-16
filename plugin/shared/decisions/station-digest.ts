/** Dispatcher decision identity keeps the established hold spelling while its presentation makes the cost explicit. */
import { decisionDigest } from "./digest.ts";
import type { StationDecision } from "./station.ts";

/** Only the exact display-only hold rename shares its old identity; other edits still change the digest. Session-framed decisions use decisionDigest directly. */
export function dispatcherDecisionDigest(framed: StationDecision): string {
  const { decision } = framed;
  return decisionDigest({
    ...decision,
    call: {
      ...decision.call,
      options: decision.call.options.map((option) =>
        option.id === "hold" &&
        option.name === "I'll handle it — hide this card" &&
        option.summary ===
          "Nothing is done; the work stays where it is. The dispatcher hides this card for these facts and lists it again when they change."
          ? {
              ...option,
              name: "Leave it to me",
              summary:
                "The dispatcher takes no step on it for these facts and stops listing it under Needs you; it lists it again when they change.",
            }
          : option,
      ),
    },
  });
}
