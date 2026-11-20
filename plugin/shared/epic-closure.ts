/** The closed and open children counted by the epic census. */
export function epicChildCensus<T>(
  children: readonly T[],
  stateOf: (child: T) => string,
): { completed: T[]; abandoned: T[]; open: T[]; finishedButOpen: boolean } {
  const completed: T[] = [];
  const abandoned: T[] = [];
  const open: T[] = [];
  for (const child of children) {
    const state = stateOf(child);
    if (state === "completed") completed.push(child);
    else if (
      state === "canceled" ||
      state === "duplicate" ||
      state === "abandoned"
    )
      abandoned.push(child);
    else open.push(child);
  }
  return {
    completed,
    abandoned,
    open,
    finishedButOpen: children.length > 0 && open.length === 0,
  };
}

const VERDICT_MARKER =
  /^<!--\s*epic-acceptance-verdict:\s*(ACCEPT-WITH-FOLLOWUPS|ACCEPT|REJECT)\s*-->$/;

const VERDICT_TIE_RANK = {
  ACCEPT: 0,
  "ACCEPT-WITH-FOLLOWUPS": 1,
  REJECT: 2,
} as const;
type EpicVerdict = keyof typeof VERDICT_TIE_RANK;

interface TrustedComment {
  body: string;
  trusted: boolean;
}

interface DatedComment extends TrustedComment {
  createdAt: string;
}

function verdictOnLastLine(comment: DatedComment): EpicVerdict | undefined {
  if (!comment.trusted) return undefined;
  const lastLine = comment.body.split("\n").at(-1) ?? "";
  return VERDICT_MARKER.exec(lastLine.trim())?.[1] as EpicVerdict | undefined;
}

/** Resolve ties independently of tracker order, with the stricter verdict winning. */
export function newestEpicVerdict(
  comments: readonly DatedComment[],
): EpicVerdict | null {
  let newest: { verdict: EpicVerdict; at: string } | undefined;
  for (const comment of comments) {
    const verdict = verdictOnLastLine(comment);
    if (verdict === undefined) continue;
    if (
      newest === undefined ||
      comment.createdAt > newest.at ||
      (comment.createdAt === newest.at &&
        VERDICT_TIE_RANK[verdict] > VERDICT_TIE_RANK[newest.verdict])
    )
      newest = { verdict, at: comment.createdAt };
  }
  return newest?.verdict ?? null;
}

export const EPIC_WAIVER_MARKER = "<!-- jig:epic-waiver -->";

const WAIVER_REPLY = /^Epic closure accepted in <https:\/\/[^<>\s]+>\.$/;

/** A recorded waiver links the person's reply and carries its marker as the last line. */
export function hasEpicWaiver(
  comments: readonly TrustedComment[],
  replyUrl?: string,
): boolean {
  return comments.some((comment) => {
    if (!comment.trusted) return false;
    const lines = comment.body.trimEnd().split("\n");
    return (
      lines.pop()?.trim() === EPIC_WAIVER_MARKER &&
      lines.some((line) =>
        replyUrl === undefined
          ? WAIVER_REPLY.test(line.trim())
          : line.trim() === `Epic closure accepted in <${replyUrl}>.`,
      )
    );
  });
}
