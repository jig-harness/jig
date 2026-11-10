/** The newest tick's needs for this repository, with its source recorded once. */
import { readLine } from "../../dispatch/lib/line-store.ts";
import type { LineNeed } from "../../dispatch/lib/dashboard-contract.ts";
import type { AskContext } from "./station.ts";

export function lineNeeds(ctx: AskContext): LineNeed[] {
  if (ctx.dispatcher === null) return [];
  const line = readLine(ctx.dispatcher);
  ctx.reading.note(
    line.ok
      ? { record: "dispatch-tick-line", read: true, local: true }
      : {
          record: "dispatch-tick-line",
          read: false,
          local: true,
          detail: line.failure.reason,
        },
  );
  return line.ok && line.value !== null
    ? line.value.needs.filter((n) => n.repo === ctx.address.repo)
    : [];
}
