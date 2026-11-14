/**
 * How each family of the icon vocabulary (`icons.ts`) is drawn: its icon in
 * its container, with its word. An act is a filled pill, a stage an outlined
 * chip, a queue source a dashed chip, and the rest a bare icon beside its
 * word. No hooks, so the page a refused request gets can draw them with no
 * script.
 */
import type { ReactNode } from "react";
import type { NeedAct } from "../../plugin/shared/acts.ts";
import {
  ACT_ICONS,
  type Container,
  type IconWord,
  iconOf,
  SOURCE_ICONS,
  STAGE_ICONS,
} from "./icons.ts";

/** An entry's icon. It is hidden from assistive technology: its word stands beside it, or names the control it is on. */
export function Glyph({
  of,
  size = 14,
  className,
}: {
  of: IconWord;
  size?: number;
  className?: string | undefined;
}) {
  const Icon = of.icon;
  const unread = of.unread === true ? "unread" : undefined;
  return Icon === null ? null : (
    <Icon
      size={size}
      aria-hidden="true"
      className={[className, unread].filter(Boolean).join(" ") || undefined}
    />
  );
}

/** An act, as a filled pill. */
export function ActPill({ act }: { act: NeedAct }) {
  return (
    <span className={`act act${act}`}>
      <Glyph of={iconOf(ACT_ICONS, act)} size={13} />
      {act}
    </span>
  );
}

/** A stage, as an outlined chip; `title` says what the stage does where a popover cannot open. */
export function StageChip({ stage, title }: { stage: string; title?: string }) {
  return (
    <span className="chip stageChip" title={title}>
      <Glyph of={iconOf(STAGE_ICONS, stage)} />
      {stage}
    </span>
  );
}

/** Where a coming item came from, as a dashed chip. */
export function SourceChip({ source }: { source: string }) {
  return (
    <span className="chip srcChip">
      <Glyph of={iconOf(SOURCE_ICONS, source)} />
      {source}
    </span>
  );
}

/** A bare icon and its words: a cause, a standing, an account's state, an answer's state. */
export function BareWord({
  of,
  children,
  className,
}: {
  of: IconWord;
  /** The words shown; the entry's own word when none are given. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={className === undefined ? "bareWord" : `bareWord ${className}`}
    >
      <Glyph of={of} />
      {children ?? of.word}
    </span>
  );
}

/** An entry drawn in its family's container, with its word: what the Help view lists. */
export function InContainer({
  container,
  entry,
}: {
  container: Container;
  entry: IconWord;
}) {
  if (container === "pill")
    return (
      <span className={`act act${entry.word}`}>
        <Glyph of={entry} size={13} />
        {entry.word}
      </span>
    );
  if (container === "chip" || container === "dashed")
    return (
      <span
        className={container === "chip" ? "chip stageChip" : "chip srcChip"}
      >
        <Glyph of={entry} />
        {entry.word}
      </span>
    );
  if (container === "heading")
    return (
      <span className="headWord">
        <Glyph of={entry} size={16} />
        {entry.word}
      </span>
    );
  return <BareWord of={entry} />;
}
