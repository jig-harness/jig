/** Closed ledger values shared by runtime readers and shape descriptions, without loading a command runner. */

export const TAKEOVER_VERDICTS = ["WEDGED", "DEAD", "STALE"] as const;

export const DECISION_CLASSES = [
  "file-issue",
  "defer-without-tracker",
  "decide-reversible",
  "decide-underdetermined",
  "decide-provisional",
  "provisional-reply",
] as const;

export const EVENT_CAUSES = {
  restart: ["pass-deadline", "stall"],
  rearm: [
    "quota-account",
    "quota-reset",
    "window-reopened",
    "answered",
    "provisional",
  ],
} as const;

export const ARBITER_VERDICTS = [
  "fix-now",
  "rejected",
  "wont-fix",
  "defer",
  "escalate",
] as const;
