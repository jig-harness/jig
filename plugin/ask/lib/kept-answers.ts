/** A retained verdict is immutable even when its source comment changes. */
import { createHash } from "node:crypto";
import { conversationOf } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import { readPendingVerdicts } from "../../skills/drive-pr/scripts/lib/state/pass-handoff.ts";
import type { PendingVerdict } from "../../skills/drive-pr/scripts/lib/state/pass-handoff.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import { stateDirOfClone } from "../../skills/drive-pr/scripts/lib/state/store.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { ThreadEntry } from "./answer.ts";
import type { AskContext } from "./station.ts";
import { answerText, readParkThread } from "./park-reading.ts";

/** Read only this host's kept file, then compare comment bodies by their retained hash. */
export async function keptAnswerEntries(
  ctx: AskContext,
  pr: number,
  ledger: Ledger | null,
  listing: readonly unknown[] | null,
): Promise<ThreadEntry[]> {
  const clone = ledger?.driver.clone;
  if (clone === undefined || !/^[A-Za-z0-9-]+$/.test(clone)) return [];
  const kept = readPendingVerdicts(stateDirOfClone(clone), String(pr));
  if (kept === null) {
    ctx.reading.note({
      record: "kept-park-answers",
      read: false,
      local: true,
      detail: "the retained answers do not read",
    });
    return [];
  }
  if (kept.length === 0) return [];
  ctx.reading.note({ record: "kept-park-answers", read: true, local: true });
  const conversation = listing === null ? [] : conversationOf(listing);
  const entries: ThreadEntry[] = [];
  for (const verdict of kept) {
    if (
      ledger?.parked.some(
        (p) => p.key.toLowerCase() === verdict.key.toLowerCase(),
      )
    )
      continue;
    entries.push(...(await verdictEntries(ctx, verdict, conversation)));
  }
  return entries;
}

/** Read a missing source thread, then describe the retained choice beside any later edit. */
async function verdictEntries(
  ctx: AskContext,
  verdict: PendingVerdict,
  conversation: CommentLike[],
): Promise<ThreadEntry[]> {
  const missing = verdict.answers.some(
    (a) => !conversation.some((c) => c.url === a.url),
  );
  const thread =
    verdict.kind === "thread" && missing
      ? await readParkThread(ctx, verdict.key)
      : [];
  const comments = [...conversation, ...(thread ?? [])];
  return verdict.answers.map((answer) => {
    const current = comments.find((c) => c.url !== "" && c.url === answer.url);
    const edited =
      current !== undefined &&
      answer.bodyHash !== undefined &&
      createHash("sha256").update(current.body).digest("hex") !==
        answer.bodyHash;
    return {
      at: answer.at,
      kind: "answer" as const,
      from: answer.author,
      to: ctx.name,
      text: `${verdict.key}: ${answerText(answer)}${edited ? "; edited since it was read; the retained verdict is unchanged" : ""}`,
      record: { kind: "pull-request-comment", url: answer.url },
    };
  });
}
