/**
 * The page's icon vocabulary: one map from every word the records give a
 * closed set (an act, a stage, a queue source or group, a merge lane, a load
 * gauge, an account state, a need cause, an answer state) and from the page's
 * own controls to the one lucide icon that draws it, with the word that always
 * stands beside it or in its hint and accessible name. Every view and the Help
 * view draw from here, so a word keeps one drawing wherever it appears.
 *
 * A family is told apart by its container as well as its icon (`Container`).
 * A word two sets share with the same meaning shares its icon: re-armable and
 * rearm, held, merged. The status roles keep their key caps (`status.ts`),
 * and where the design keeps a word alone its entry has no icon.
 */
import {
  ArrowLeftRight,
  Ban,
  Bell,
  BellOff,
  BrickWall,
  Check,
  ChevronRight,
  ChevronsRight,
  Circle,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleHelp,
  CircleOff,
  CirclePause,
  CirclePlus,
  CircleSlash2,
  Clock,
  ClockAlert,
  Copy,
  CopyX,
  Cpu,
  Flag,
  Gauge,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hammer,
  HardDrive,
  History,
  KeyRound,
  Link,
  ListFilter,
  ListX,
  Lock,
  type LucideIcon,
  MemoryStick,
  Merge,
  MessageSquareMore,
  MessageSquareText,
  MessagesSquare,
  Navigation,
  OctagonMinus,
  Pause,
  Play,
  RefreshCw,
  Reply,
  RotateCw,
  Scale,
  Search,
  ShieldAlert,
  ShieldBan,
  ShieldQuestion,
  Stamp,
  StickyNote,
  Tag,
  TimerOff,
  TriangleAlert,
  Undo2,
  UserRound,
  UserRoundCheck,
  UserRoundX,
  Users,
  Waypoints,
  WifiOff,
  Wrench,
  X,
} from "lucide-react";
import type {
  LoadGauge,
  NeedCause,
  QueueGroup,
  QueueSource,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { LaunchAction } from "../../plugin/dispatch/lib/launches.ts";
import type { Stage as TickStage } from "../../plugin/dispatch/lib/types.ts";
import type { NeedAct } from "../../plugin/shared/acts.ts";
import type { AnswerState } from "../../plugin/shared/decision-card.ts";
import type { Lane } from "../../plugin/skills/drive-pr/scripts/lib/merge-ready.ts";
import type { AccountState } from "./view.ts";

export interface IconWord {
  /** The drawing; `null` where the design keeps the word alone. */
  icon: LucideIcon | null;
  /** The word, beside the icon or in its hint and accessible name. */
  word: string;
  /** Drawn dashed and muted: a standing the page has not read. */
  unread?: true;
}

/**
 * How a family is drawn, so that it reads apart from the others in greyscale
 * and in forced colours too: a filled pill, an outlined chip, a dashed chip,
 * a bare icon beside its word, an icon leading a heading or a row, or a
 * control's own icon.
 */
export type Container =
  | "pill"
  | "chip"
  | "dashed"
  | "bare"
  | "heading"
  | "row"
  | "control";

/** A stage as the records name it: one a tick starts, or the launch it makes (a takeover among them). */
export type Stage = TickStage | LaunchAction;

/** A pull request's standing on the forge, or that the forge was not read for it. */
export type ForgeStanding = "open" | "draft" | "merged" | "closed" | "not read";

/** Where the dispatcher holds a pull request, while its identity still shows it. */
export type LineStanding =
  | "driving"
  | "following-up"
  | "waiting"
  | "needs-person";

/** What this browser holds for a decision: a pick, words, a note, and what keeps the copy from counting them. */
export type HereAnswerState =
  | "unpicked"
  | "picked"
  | "own words"
  | "note"
  | "guarded"
  | "dropped"
  | "held back"
  | "draft";

/** A state of the line's answers to a decision, the same for every viewer. */
export type EveryoneAnswerState = AnswerState | "waiting";

const is = (icon: LucideIcon | null, word: string): IconWord => ({
  icon,
  word,
});

const WORK_KIND_ICONS = {
  // A pull request is drawn by its standing (FORGE_ICONS), so it has no icon of its own.
  "pull request": is(null, "pull request, by its standing"),
  issue: is(CircleDot, "issue"),
  "linked to": is(Link, "linked to"),
} satisfies Record<string, IconWord>;

export const FORGE_ICONS = {
  open: is(GitPullRequest, "open"),
  draft: is(GitPullRequestDraft, "draft"),
  merged: is(GitMerge, "merged"),
  closed: is(GitPullRequestClosed, "closed"),
  "not read": { ...is(GitPullRequest, "not read"), unread: true },
} satisfies Record<ForgeStanding, IconWord>;

export const ACT_ICONS = {
  Merge: is(Merge, "Merge"),
  Decide: is(Scale, "Decide"),
  Authorize: is(KeyRound, "Authorize"),
  Reply: is(Reply, "Reply"),
  Do: is(Wrench, "Do"),
  Investigate: is(Search, "Investigate"),
} satisfies Record<NeedAct, IconWord>;

export const STAGE_ICONS = {
  pickup: is(CirclePlus, "pickup"),
  rearm: is(RotateCw, "rearm"),
  takeover: is(ArrowLeftRight, "takeover"),
  followup: is(ChevronsRight, "followup"),
  notify: is(Bell, "notify"),
  steer: is(Navigation, "steer"),
  steward: is(Hammer, "steward"),
} satisfies Record<Stage, IconWord>;

export const SOURCE_ICONS = {
  "re-armable": is(RotateCw, "re-armable"),
  "label drive": is(Tag, "label drive"),
  held: is(Pause, "held"),
  assigned: is(UserRoundCheck, "assigned"),
  merged: is(GitMerge, "merged"),
} satisfies Record<QueueSource, IconWord>;

export const GROUP_ICONS = {
  starts: is(Play, "starts"),
  held: is(Pause, "held"),
  reported: is(Flag, "reported"),
  never: is(Ban, "never"),
} satisfies Record<QueueGroup, IconWord>;

export const LINE_ICONS = {
  driving: is(GitPullRequestArrow, "driving"),
  "following-up": is(ChevronsRight, "following up"),
  waiting: is(Clock, "waiting"),
  "needs-person": is(UserRound, "needs a person"),
} satisfies Record<LineStanding, IconWord>;

export const LANE_ICONS = {
  "merge-now": is(CircleCheckBig, "merge now"),
  "approve-first": is(Stamp, "approve first"),
  "update-next": is(GitBranch, "update next"),
} satisfies Record<Lane, IconWord>;

/** A gauge past its line is marked beside it, so the gauges' set holds that mark too. */
export const GAUGE_ICONS = {
  memory: is(MemoryStick, "memory"),
  processors: is(Cpu, "processors"),
  "test-lock": is(Lock, "test lock"),
  disk: is(HardDrive, "disk"),
  forge: is(Gauge, "forge budget"),
  accounts: is(Users, "accounts"),
  over: is(TriangleAlert, "over its line"),
} satisfies Record<LoadGauge | "over", IconWord>;

export const ACCOUNT_ICONS = {
  "at cap": is(CircleSlash2, "at cap"),
  "behind a wall": is(BrickWall, "behind a wall"),
  "not admitted": is(ShieldBan, "not admitted"),
  "wall not recorded": is(ShieldQuestion, "wall not recorded"),
} satisfies Record<AccountState, IconWord>;

export const CAUSE_ICONS = {
  parked: is(CirclePause, "parked"),
  stalled: is(TimerOff, "stalled"),
  "needs-person": is(UserRound, "needs-person"),
  "stopped-unknown": is(CircleHelp, "stopped-unknown"),
  "followup-failed": is(ListX, "followup-failed"),
  "followup-stale": is(ClockAlert, "followup-stale"),
  "nudge-unanswered": is(BellOff, "nudge-unanswered"),
  "pickup-question": is(MessageSquareMore, "pickup-question"),
  "double-claim": is(CopyX, "double-claim"),
  "assigner-cannot-write": is(UserRoundX, "assigner-cannot-write"),
} satisfies Record<NeedCause, IconWord>;

export const EVERYONE_ICONS = {
  stale: is(History, "stale"),
  disputed: is(MessagesSquare, "disputed"),
  waiting: is(null, "waiting"),
} satisfies Record<EveryoneAnswerState, IconWord>;

export const HERE_ICONS = {
  unpicked: is(Circle, "unpicked"),
  picked: is(CircleCheck, "picked"),
  "own words": is(MessageSquareText, "own words count"),
  note: is(StickyNote, "note"),
  guarded: is(ShieldAlert, "guarded"),
  dropped: is(CircleOff, "dropped"),
  "held back": is(OctagonMinus, "held back"),
  draft: is(null, "draft, not counting"),
} satisfies Record<HereAnswerState, IconWord>;

export const CARD_ICONS = {
  interplay: is(Waypoints, "interplay"),
  undo: is(Undo2, "undo last pick"),
  copy: is(Copy, "copy, confirm copy"),
} satisfies Record<string, IconWord>;

export const CONTROL_ICONS = {
  disclosure: is(ChevronRight, "disclosure"),
  copy: is(Copy, "copy"),
  copied: is(Check, "copied"),
  refused: is(X, "copy refused"),
  filter: is(ListFilter, "filter"),
  retry: is(RefreshCw, "retry"),
  unreachable: is(WifiOff, "host unreachable"),
} satisfies Record<string, IconWord>;

export interface IconSet {
  title: string;
  container: Container;
  /** Where the page draws it, and how. */
  where: string;
  members: Readonly<Record<string, IconWord>>;
}

/** Every set, in the order the Help view lists them. */
export const ICON_SETS: readonly IconSet[] = [
  {
    title: "What a card is about",
    container: "bare",
    where:
      "A bare icon before the key. A pull request is drawn by its standing on the forge, below. The issue and linked-work icons are in the vocabulary for the card system's work identity; no view draws them today.",
    members: WORK_KIND_ICONS,
  },
  {
    title: "A pull request on the forge",
    container: "bare",
    where:
      "A bare icon before the number; dashed and muted while the forge is not read.",
    members: FORGE_ICONS,
  },
  {
    title: "A pull request on the line",
    container: "bare",
    where:
      "The pull request icon also carries the dispatcher's states while it holds the pull request: these, and queued, held, reported and refused with the icons of what is coming. Driving and waiting are interim icons. The card system moves these states to the status mark and the stage chip.",
    members: LINE_ICONS,
  },
  {
    title: "Acts",
    container: "pill",
    where: "A filled pill on a card and its group's heading.",
    members: ACT_ICONS,
  },
  {
    title: "Stages",
    container: "chip",
    where: "An outlined chip with the stage's word.",
    members: STAGE_ICONS,
  },
  {
    title: "Where a coming item came from",
    container: "dashed",
    where: "A dashed chip on a coming item.",
    members: SOURCE_ICONS,
  },
  {
    title: "What is coming",
    container: "heading",
    where: "On the group's heading.",
    members: GROUP_ICONS,
  },
  {
    title: "Ready to merge",
    container: "heading",
    where:
      "On the lane's heading. The acts that settle a card (approve, update-branch and the rest) stay words.",
    members: LANE_ICONS,
  },
  {
    title: "Load gauges",
    container: "row",
    where: "Leading the gauge's row.",
    members: GAUGE_ICONS,
  },
  {
    title: "Accounts",
    container: "bare",
    where: "A bare icon and its words in the account's row.",
    members: ACCOUNT_ICONS,
  },
  {
    title: "Why a need waits",
    container: "bare",
    where: "A bare icon before the recorded cause, which keeps its own words.",
    members: CAUSE_ICONS,
  },
  {
    title: "Answers, for everyone",
    container: "bare",
    where:
      "An icon and a sentence where the line's answers keep a decision waiting; waiting is the card itself.",
    members: EVERYONE_ICONS,
  },
  {
    title: "Answers, in this browser",
    container: "bare",
    where:
      "An icon and a sentence on a decision's row; a draft that does not count is said in words. Own words and a note are in the vocabulary for the card system's decision rows; no row draws them today.",
    members: HERE_ICONS,
  },
  {
    title: "On a decision's card",
    container: "control",
    where: "On the control that does it.",
    members: CARD_ICONS,
  },
  {
    title: "Page controls",
    container: "control",
    where:
      "On the control that does it, which names it. Retry is in the vocabulary for a retry control; the page has none today.",
    members: CONTROL_ICONS,
  },
];

/** A word's entry in a set; a word the set does not hold is drawn as its word alone. */
export function iconOf(
  members: Readonly<Record<string, IconWord>>,
  word: string,
): IconWord {
  return Object.hasOwn(members, word)
    ? (members[word] ?? is(null, word))
    : is(null, word);
}
