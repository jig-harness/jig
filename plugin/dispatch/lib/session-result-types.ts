/** A pickup's or follow-up's stored answer, before a reader interprets it. */
export type RecordedResult = "done" | "failed" | "waits";

/** A stored answer as readers interpret it, including a framed human decision. */
export type SessionResult = RecordedResult | "parked";
