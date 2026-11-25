/**
 * The reviewer sticky comment the drive-pr suites stub: its backlog blob and
 * the body builder. Split from the harness to keep it within the size ratchet.
 */

export const HEAD = "a91d4f7c05444444444444444444444444444444";

const backlogEntries = [
  {
    fingerprint: "b9a7a18089043564",
    path: "AGENTS.md",
    line: null,
    severity: "medium",
    dimension: "correctness",
    // Present on one fixture entry and absent on the sibling below,
    // so `decodeBacklog`'s value-present and value-absent (→ 'unknown') paths
    // are both exercised by the same shared fixture every other test here
    // already reuses.
    category: "drift",
    comment:
      "The Linear section claims issue creation is blocked unless Context is present.",
    firstRound: 6,
    reason: "winddown-deferred",
  },
  // No `reason`/`firstRound`: a plain "Beyond this PR" carry-forward. The
  // one-head grace keys on backlog MEMBERSHIP, so this entry must
  // get exactly the same treatment there as the wind-down-reasoned one above.
  // `reason` is NOT retired: past that one head it still selects the separate,
  // round-bounded exemption, which this entry does not get — the
  // two rules are stacked, not one superseding the other.
  {
    fingerprint: "c773d9fdb7974e6d",
    path: "AGENTS.md",
    line: null,
    severity: "low",
    dimension: "maintainability",
    comment:
      "hand-maintains the count of the four bullets immediately below it.",
  },
];

export type StickyBacklog = boolean | "winddown-only" | "blocking-only";

export function stickyBody(
  opts: {
    sha?: string;
    backlog?: StickyBacklog;
    unanchored?: number;
    /** `null` omits the `ai-review-round` marker, as a format regression would. */
    round?: number | null;
  } = {},
): string {
  const sha = opts.sha ?? HEAD;
  const entries =
    opts.backlog === "winddown-only"
      ? backlogEntries.slice(0, 1)
      : opts.backlog === "blocking-only"
        ? backlogEntries.map((entry) => ({ ...entry, blocking: true }))
        : backlogEntries;
  const backlogBlob = Buffer.from(JSON.stringify(entries)).toString("base64");
  return [
    "<!-- ai-code-review -->",
    "### 🟡 Some headline",
    "",
    "Found 1 cross-file contract gap in the latest delta.",
    "",
    "### 🎯 correctness",
    "",
    "- `.claude/agents/review-arbiter.md:31` — 🟡 **medium** (high confidence, quick) — The arbiter’s sensitivity input omits the shared-schema exception.",
    ...(opts.unanchored
      ? [
          "",
          `> ${opts.unanchored} finding(s) without a diff-anchorable line are in the summary above only.`,
        ]
      : []),
    "",
    ...(opts.backlog === false
      ? []
      : [
          "<details><summary>🗂️ <b>Beyond this PR</b></summary>",
          "",
          "- `AGENTS.md` — 🟡 **medium** (correctness · adjacent) — The Linear section claims…",
          "",
          "</details>",
        ]),
    "",
    `<!-- ai-reviewed-sha: ${sha} -->`,
    ...(opts.round === null
      ? []
      : [`<!-- ai-review-round: ${opts.round ?? 7} -->`]),
    ...(opts.backlog === false
      ? []
      : [`<!-- ai-review-backlog: ${backlogBlob} -->`]),
  ].join("\n");
}
