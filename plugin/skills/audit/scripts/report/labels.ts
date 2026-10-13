/**
 * Every fixed word the audit sheet and its Markdown copy write around the
 * report source, the record and the configuration-fit report. Nothing else
 * may appear in a rendered sheet: each label names a slot, and none states a
 * finding about the repository.
 */

/** The words both projections write. */
export const LABEL = {
  sheet: "Jig audit",
  /** The title: "Audit of example/web". */
  titleOf: "Audit of",
  audited: "Audited",
  commit: "Commit",
  plugin: "Plugin",
  profile: "Profile",
  shape: "Shape",
  declared: "declared",
  suggested: "suggested",
  noProfile: "none declared",
  headingTo: "Heading to",
  whySuggested: "Why this profile:",

  inShort: "In short",
  criteriaMet: "criteria met",
  ofWord: "of",
  recommendations: "Recommendations",
  recommendationsNow: "recommendations for now",
  quickWins: "quick wins",
  quickWin: "Quick win",
  modulesAtTarget: "modules at their target",
  expectedAbsentCount: "do not apply to this shape",

  map: "Maturity map",
  mapIntro:
    "One row per module, in the order to adopt them. Each square is one criterion, coloured by the rung of the enforcement ladder it reached.",
  module: "Module",
  level: "Level",
  target: "Target",
  noTarget: "no target",
  atTarget: "at target",
  toGo: "not yet met",
  notNeeded: "not needed for this profile",
  criteria: "Criteria",
  notApplicable: "Does not apply to this repository's shape:",
  incomplete: "incomplete",
  levelWord: { lite: "Lite", standard: "Standard", strict: "Strict" },
  attained: {
    none: "none",
    "n/a": "n/a",
    lite: "Lite",
    standard: "Standard",
    strict: "Strict",
  },
  withinTarget: "within the target",
  withinHeading: "within the heading-to target",
  gapLegend: "needed for the target, not met yet",

  startHere: "Start here",
  topMoves: "The moves that matter most",
  quickWinsHead: "Quick wins",
  noRecommendations: "The audit makes no recommendation.",

  since: "Since the last audit",
  sinceIntro: "Compared with the audit of",
  pluginWord: "plugin",
  changes: {
    regressed: "Regressed",
    fixed: "Fixed",
    new: "New",
    "added-by-jig": "Added by Jig",
    reclassified: "Reclassified",
    removed: "Removed",
  },
  stillOpen: "still open",
  unchangedMet: "unchanged and met",
  levelsChanged: "Levels that changed",
  prior: "Before",
  now: "Now",
  declinedHead: "Declined recommendations",
  declinedStatus: {
    held: "held",
    due: "due",
    resolved: "resolved",
    stale: "stale",
  },
  noChange: "Nothing changed.",

  horizon: {
    now: "For now",
    grow: "As you grow",
    optional: "Optional",
  },
  growWhy:
    "Beyond what {profile} asks for now; worth it as the project grows toward {heading}.",
  optionalWhy:
    "Beyond what {profile} asks for{heading}. Not needed for this profile: take one when the project needs it.",
  andBeyond: ", and beyond {heading}",
  worthWhen: "Worth it when:",
  laterCount: "more for later or optional",
  lighter: "Lighter option",
  configGroup: "Configuration",
  configPurpose:
    "The repository's Jig configuration, checked against the plugin and against the repository.",
  finding: "Finding",
  action: "Action",
  evidence: "Evidence",
  moves: "Criteria it moves",
  leverage: "Leverage",
  effort: "Effort",
  leverageWord: { high: "high", medium: "medium", low: "low" },
  effortWord: { small: "small", medium: "medium", large: "large" },
  requires: "requires",
  requiresHead: "Requires",
  criterion: "Criterion",
  score: "Score",

  detail: "Module detail",
  detailIntro:
    "Every criterion of every module: its level, its pass bar, its score, how it was decided and the evidence. Open a module to see its criteria.",
  decidedBy: "Decided by",
  byProbe: "a probe",
  byAgent: "the agent",
  notScored: "not scored",

  config: "Configuration fit",
  configFile: "File",
  configNone: "The repository has no Jig configuration file.",
  forge: "Repository host",
  severity: {
    error: "Errors",
    warning: "Warnings",
    suggestion: "Suggestions",
    info: "Information",
  },
  facts: "Facts",
  declinedFindings: "Declined",
  revisitWhen: "Revisit when:",
  nothingToFix: "Nothing to fix.",
  noFit: "No configuration-fit report was given to this render.",
  draft: "Starter configuration",
  draftIntro:
    "Values the repository implies, each with the evidence it came from.",

  drift: "Drift",
  driftIntro: "Where what the repository says and what it does disagree.",
  noDrift: "None found.",

  examined: "What was examined",
  stack: "Stack",
  facet: "Facet",
  detected: "Detected",
  read: "Read",
  unchecked: "Could not be checked",
  method: "How the scores were reached",
  methodText:
    "Each criterion was scored on the enforcement ladder from file-path evidence. A criterion with a probe was first tested by a script; where the probe found its precondition missing, the script scored it absent. The agent scored every other criterion. A module attains a level when every criterion at that level and below meets its bar.",
  ladderLink: "The enforcement ladder",

  terms: "Terms",

  rung: {
    absent: "absent",
    convention: "convention",
    advisory: "advisory",
    mechanical: "mechanical",
    "expected-absent": "expected absent",
  },
  rungMeaning: {
    absent: "not there yet",
    convention: "written down, kept by habit",
    advisory: "a tool reports it but does not block",
    mechanical: "a check blocks the change",
    "expected-absent": "does not apply to this shape",
  },
  notScoredMeaning: "no score in the record",
} as const;

/** The words only the HTML sheet writes: its contents bar, the choices, the tray and the script's messages. */
export const SHEET_LABEL = {
  navContents: "Sheet contents",
  nav: {
    summary: "In short",
    map: "Map",
    start: "Start here",
    since: "Since",
    recs: "Recommendations",
    detail: "Detail",
    config: "Configuration",
    drift: "Drift",
    examined: "Examined",
    terms: "Terms",
  },
  timeLeft: "~{n} min left",
  timeEnd: "End",
  yourDecision: "Your decision on",
  choice: {
    accept: "Accept",
    lighter: "Take the lighter option",
    refine: "Refine",
    decline: "Decline",
    wrong: "This is wrong",
  },
  why: "Why",
  revisit: "Revisit when",
  note: "Note",
  clear: "Clear",
  profileChange: "Aim for a different profile",
  profileKeep: "Keep",
  goToCard: "Decide",
  trayLabel: "Your decisions",
  copy: "Copy decisions",
  showText: "Show the text",
  hideText: "Hide the text",
  reset: "Reset",
  copied: "Copied",
  copyFallback: "Select the text and copy it",
  notReady: "Not ready to copy:",
  needs: "needs",
  needReason: "a reason (Why)",
  needWhen: "when to revisit",
  needNote: "a note",
  and: "and",
  profileChosen: "profile",
  copyDraft: "Copy the starter configuration",
} as const;

/** The name of a rendered sheet and its Markdown copy, before the extension. */
export const FILE_STEM = "jig-audit-";
