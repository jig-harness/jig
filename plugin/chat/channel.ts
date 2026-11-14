/**
 * The notification channel port: one way the line's notices reach a person.
 * The tick sends each cause it notifies through every channel it enables,
 * and keeps, for each channel apart, the record that the cause was sent
 * (`dispatch/lib/notice-records.ts`): a cause delivered on one channel and
 * lost on another is tried again on the other alone.
 *
 * A channel only delivers. Which causes are due, a repeat's cadence, the
 * back-off of a delivery that keeps failing and the suppression records are
 * the tick's (`dispatch/lib/actions/notify.ts`), the same for every channel.
 * A channel is handed one repository's due causes and answers for each how
 * its delivery went; it recognises a cause already on its destination,
 * which counts as sent without being sent again.
 *
 * A notice is structured, so each channel renders it in its own way: beside
 * its key and its text it carries the piece of work's address, its links,
 * the acts that settle it and, for a framed decision, the decision with its
 * options. The text is the fallback a channel that renders nothing else
 * posts, and the key is in the text, so a read of the destination shows
 * whether the notice arrived.
 *
 * A channel's name is lowercase letters, digits and hyphens. The tick keys
 * its records and its failure-ledger rows by it, so a name, once released,
 * keeps its meaning.
 */

/** One option of a framed decision, as a notice carries it. */
export interface NoticeOption {
  name: string;
  /** What choosing it changes; `null` when the decision says nothing. */
  changes: string | null;
  /** What choosing it costs; `null` when the decision says nothing. */
  costs: string | null;
  /** Whether the decision recommends it. */
  recommended: boolean;
}

/** A framed decision a notice asks a person to settle, with the fields the dispatch dashboard shows of it. */
export interface NoticeDecision {
  /** The key an answer names: `answer <key>: …`. */
  key: string;
  /** The digest of the framing, which a guarded answer names; absent on a park that records none. */
  digest?: string;
  /** Its question; `null` when the framing holds none in the drive's form. */
  question: string | null;
  /** The recommended option and why; `null` when it recommends none. */
  recommendation: string | null;
  /** Its options in the framing's order; empty for a decision framed before options were named. */
  options: NoticeOption[];
}

/** What a notice carries beside its key and text; each field absent where its builder has nothing to fill it with. */
export interface NoticeFields {
  /** The piece of work's address, `station@owner/name#key` (`shared/address.ts`). */
  address?: string;
  /** The links a person follows from it. */
  links?: {
    /** The pull request's page on the forge. */
    pullRequest?: string;
  };
  /** The commands that settle it, each as a person copies it. */
  acts?: string[];
  /** The framed decisions it waits on. */
  decisions?: NoticeDecision[];
}

/** A notice as a channel receives it. */
export interface ChannelNotice extends NoticeFields {
  /** The facts its suppression record is keyed by; carried in `text`. */
  key: string;
  /** The message in plain text, the key line first. */
  text: string;
}

/** One cause due on a channel. */
export interface DueNotice {
  /** What it is about: `PR #7`, an item's key, a host's tick scope. */
  target: string;
  /** Why a person is told (`parked`, `ready`, `needs-person`, …). */
  cause: string;
  notice: ChannelNotice;
  /** Set when it is sent again, still standing `dispatch.renotify_after` after its last send. */
  repeat?: boolean;
}

/**
 * How one cause's delivery went: `sent`, the channel's receipt shows it
 * arrived; `already`, the destination carried it before, so it counts as
 * sent; `lost`, the receipt does not show it arrived; `waits`, it was not
 * tried this tick (the destination could not be reached, or had no room).
 */
export type DeliveryOutcome = "sent" | "already" | "lost" | "waits";

/** A channel's answer for one cause. */
export interface Delivery {
  /** The notice's key. */
  key: string;
  outcome: DeliveryOutcome;
  /** Where on the channel it went, which its suppression record keeps; `null` when nothing was reached. */
  place: string | null;
  /** One sentence for the tick's receipt. */
  detail: string;
}

/** One way notices reach a person. */
export interface NotificationChannel<Due extends DueNotice = DueNotice> {
  /** Its name, which keys its suppression records and failure-ledger rows. */
  readonly name: string;
  /** Why nothing can be delivered this tick, every due cause then waiting; `null` when the channel is tried. */
  unreachable(): string | null;
  /**
   * Deliver one repository's due causes, and answer for each of them, in
   * the order the channel settled them. A cause the channel answers nothing
   * for is not counted as tried.
   */
  deliver(due: readonly Due[]): Promise<Delivery[]>;
}
