import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { followupCounts } from "./followup-view.ts";
import { Glyph } from "./icon-word.tsx";
import { FORGE_ICONS } from "./icons.ts";

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
      <Glyph of={FORGE_ICONS.merged} size={16} />
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
      <Glyph of={FORGE_ICONS.merged} />
      Merged · {label}
    </span>
  );
}
