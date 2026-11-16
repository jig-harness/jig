/**
 * What the follow-up may do on its own, what it asks first, what only a
 * person decides and what it never does. The table is fixed here, in the
 * skill: a repository's `followup.authority` may move an act to a stricter
 * level, never to a looser one, so no configuration can let a follow-up
 * merge, edit another repository or cross the origin-reference boundary.
 */

/** The levels, loosest first. */
export const LEVELS = ["own", "ask", "person", "never"] as const;
export type Level = (typeof LEVELS)[number];

/** What each level means, as the table prints it. */
export const LEVEL_WORDS: Record<Level, string> = {
  own: "on its own",
  ask: "ask first",
  person: "a person decides",
  never: "never",
};

/** One act the follow-up may take, with its fixed level. */
export interface Act {
  id: string;
  act: string;
  level: Level;
}

export const ACTS = [
  {
    id: "tracker-status",
    act: "Move the tracker item's status and post its closing comment",
    level: "own",
  },
  {
    id: "file-items",
    act: "File follow-up items (deferred findings, out-of-tree steps, scope cuts, the next step)",
    level: "own",
  },
  {
    id: "read-only-checks",
    act: "Read-only checks: the release state, the tag plan, the drivers, a deployed environment's behaviour",
    level: "own",
  },
  {
    id: "board-card",
    act: "Move the merged work's workspace card",
    level: "own",
  },
  {
    id: "release-workflow",
    act: "Run the release workflow, create or replace a release tag",
    level: "ask",
  },
  {
    id: "deploy-rerun",
    act: "Re-run a failed deploy",
    level: "ask",
  },
  {
    id: "post-deploy-action",
    act: "Carry out a change area's post-deploy action",
    level: "ask",
  },
  {
    id: "stop-driver",
    act: "Stop a live driver",
    level: "ask",
  },
  {
    id: "other-repository",
    act: "Anything in another repository",
    level: "person",
  },
  {
    id: "origin-boundary",
    act: "Anything that would name an organization the repository learned from, or bring its content in (the origin-reference boundary)",
    level: "person",
  },
  { id: "merge", act: "Merge a pull request", level: "never" },
] as const satisfies readonly Act[];

export type ActId = (typeof ACTS)[number]["id"];

export const ACT_IDS: readonly ActId[] = ACTS.map((a) => a.id);

export function isActId(value: string): value is ActId {
  return (ACT_IDS as readonly string[]).includes(value);
}

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/** Whether `next` is at least as strict as `fixed`. */
export function tightens(fixed: Level, next: Level): boolean {
  return LEVELS.indexOf(next) >= LEVELS.indexOf(fixed);
}

/** One row of the table in force. */
export interface AuthorityRow extends Act {
  /** Whether the repository tightened it. */
  tightened: boolean;
}

/**
 * The table in force: the fixed table with the repository's tightenings
 * applied. `overrides` holds only levels `tightens` accepted (the
 * configuration reader refuses any other).
 */
export function authorityTable(
  overrides: Partial<Record<ActId, Level>>,
): AuthorityRow[] {
  return ACTS.map((a) => {
    const level = overrides[a.id];
    return level === undefined || level === a.level
      ? { ...a, tightened: false }
      : { ...a, level, tightened: true };
  });
}

/** The table as Markdown, one row per act. */
export function renderAuthority(rows: readonly AuthorityRow[]): string {
  return [
    "| Act | Id | Authority |",
    "|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.act} | \`${r.id}\` | ${LEVEL_WORDS[r.level]}${r.tightened ? " (tightened by followup.authority)" : ""} |`,
    ),
  ].join("\n");
}
