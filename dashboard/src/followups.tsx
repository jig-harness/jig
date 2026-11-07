import { GitMerge } from "lucide-react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { followupCounts } from "./followup-view.ts";

/** Visible even when the queue or running panels are collapsed. */
export function FollowupSummary({
  line,
  nowMs,
}: {
  line: LineSnapshot | null;
  nowMs: number;
}) {
  if (line === null) return null;
  const counts = Object.entries(followupCounts(line, nowMs));
  return (
    <section className="followupSummary sm" aria-label="Post-merge follow-ups">
      <GitMerge size={16} aria-hidden="true" />
      <span>
        Merged PRs at last tick:{" "}
        {counts.length === 0
          ? "no follow-ups recorded"
          : counts
              .map(([label, count]) => `${count} ${label.toLowerCase()}`)
              .join(" · ")}
        .
      </span>
    </section>
  );
}

export function FollowupBadge({ label }: { label: string | null }) {
  if (label === null) return null;
  return (
    <span className="chip followupBadge">
      <GitMerge size={14} aria-hidden="true" />
      Merged · {label}
    </span>
  );
}
