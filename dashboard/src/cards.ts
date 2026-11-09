/**
 * What each view's cards are, for the keys and the palette: the key a card
 * is found by, its target and title, where p and i go, and what c copies.
 * The views draw from the same records, so a card the palette names is the
 * card the view drew.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { mergeCount, mergeLanes, type MergeCardView } from "./merge-view.ts";
import { type NeedView, needCount, needRows } from "./needs-view.ts";
import { queueGroups, type QueueItemView } from "./queue-view.ts";
import { answerText } from "./replies.ts";
import type { ViewId } from "./search.ts";
import { type Clock, type SlotView, slotView } from "./view.ts";

export interface CardInfo {
  key: string;
  view: ViewId;
  target: string;
  repo: string;
  title: string | null;
  url: string | null;
  /** What c copies; `null` when the card has nothing to run. */
  command: string | null;
  /** What the command is, as the palette names it. */
  commandLabel: string;
}

/** The station whose records a stage leaves (design/addresses.md). */
function stationOf(stage: string): string {
  return stage === "pickup" || stage === "followup" ? stage : "drive";
}

/** The `jig ask` line for a target on the line: a pull request's number or an item key after `#`. */
export function askLineOf(stage: string, repo: string, target: string): string {
  const key = target.replace(/^PR /, "").replace(/^#/, "");
  return `jig ask ${stationOf(stage)}@${repo}#${key}`;
}

export function mergeCard(card: MergeCardView): CardInfo {
  return {
    key: `merge ${card.rowKey}`,
    view: "merge",
    target: card.target,
    repo: card.repo,
    title: card.title,
    url: card.url,
    command: card.command,
    commandLabel: card.merges ? "merge command" : "jig ask line",
  };
}

export function needCard(need: NeedView): CardInfo {
  const [first] = need.answerKeys;
  const command =
    first !== undefined
      ? answerText(need.answerKeys, [])
      : (need.keyText ?? askLineOf(need.stage, need.repo, need.target));
  return {
    key: `need ${need.rowKey}`,
    view: "needs",
    target: need.target,
    repo: need.repo,
    title: need.question,
    url: need.url,
    command,
    commandLabel:
      first !== undefined
        ? "answer line"
        : need.keyText !== null
          ? "key"
          : "jig ask line",
  };
}

export function slotCard(slot: SlotView, view: ViewId): CardInfo {
  return {
    key: `${view === "needs" ? "stuck" : "slot"} ${slot.record}`,
    view,
    target: slot.target,
    repo: slot.repo,
    title: slot.fact,
    url: slot.url,
    command: askLineOf(slot.stage, slot.repo, slot.target),
    commandLabel: "jig ask line",
  };
}

export function queueCard(item: QueueItemView): CardInfo {
  const stage =
    item.source === "merged"
      ? "followup"
      : item.target.startsWith("PR #")
        ? "rearm"
        : "pickup";
  return {
    key: `queue ${item.rowKey}`,
    view: "queue",
    target: item.target,
    repo: item.repo,
    title: item.title,
    url: item.url,
    command: askLineOf(stage, item.repo, item.target),
    commandLabel: "jig ask line",
  };
}

/** Every card on the card views, in each view's order. */
export function allCards(line: LineSnapshot | null, clock: Clock): CardInfo[] {
  if (line === null) return [];
  const merge = mergeLanes(line, clock.nowMs).flatMap((lane) =>
    lane.cards.map(mergeCard),
  );
  const needs = needRows(line, clock).flatMap((row) =>
    row.type === "need"
      ? [needCard(row.need)]
      : row.type === "stuck"
        ? [slotCard(row.slot, "needs")]
        : [],
  );
  const running = line.sessions.map((s) =>
    slotCard(slotView(s, clock, line), "running"),
  );
  const queue = queueGroups(line, clock).flatMap((g) => g.items.map(queueCard));
  return [...merge, ...needs, ...running, ...queue];
}

/** Each view's count, which its tab carries: History's once the log is read. */
export function tabCounts(
  line: LineSnapshot | null,
  clock: Clock,
  logTotal: number | null,
): Partial<Record<ViewId, number>> {
  const queue =
    line === null
      ? 0
      : queueGroups(line, clock).reduce((n, g) => n + g.items.length, 0);
  return {
    merge: mergeCount(line),
    needs: needCount(line, clock.nowMs),
    running: line?.sessions.length ?? 0,
    queue,
    ...(logTotal === null ? {} : { history: logTotal }),
  };
}
