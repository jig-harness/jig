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
  /** A profile given to `report.ts --profile`: explored, not the team's choice. */
  explored: "explored, not recorded",
  noProfile: "none declared",
  headingTo: "Heading to",
  whySuggested: "Why this profile:",
  signalsHead: "Worth revisiting the profile",
  signalsIntro:
    "Facts that suggest the project may have grown beyond this profile. The profile is the team's to choose; these are reasons to look at it again, not findings.",
  signalsLink: "worth revisiting",
  alternativeHead: "Another profile to consider: {profile}",
  alternativeAtTarget:
    "Under {profile}, {n} of {m} modules would be at their target.",

  inShort: "In short",
  criteriaMet: "criteria met",
  examinedMet: "examined criteria met",
  notExaminedCount: "not examined, beyond the target",
  ofWord: "of",
  recommendations: "Recommendations",
  recommendationsNow: "recommendations for now",
  quickWins: "quick wins",
  quickWin: "Quick win",
  appliedIn: "Applied in",
  needs: { "host-admin": "Needs a repository admin" },
  modulesAtTarget: "modules at their target",
  expectedAbsentCount: "do not apply to this shape",
  uncoveredCount: {
    one: "gap no recommendation covers",
    many: "gaps no recommendation covers",
  },
  leftCount: {
    one: "gap left on purpose",
    many: "gaps left on purpose",
  },
  appliedCount: "applied since the audit",

  map: "Maturity map",
  mapIntro: "One row per module, in the order to adopt them.",
  /** The Markdown copy's legend before the rungs, weakest first. */
  rungsLegend: "The rungs, weakest first:",
  module: "Module",
  level: "Level",
  target: "Target",
  noTarget: "no target",
  atTarget: "at target",
  toGo: "not yet met",
  notExaminedHere: "not examined",
  notNeeded: "not needed for this profile",
  criteria: "Criteria",
  notApplicable: "Does not apply to this repository's shape:",
  incomplete: "incomplete",
  levelWord: { lite: "Lite", standard: "Standard", strict: "Strict" },
  attained: {
    none: "none",
    "n/a": "n/a",
    "not-examined": "not examined",
    lite: "Lite",
    standard: "Standard",
    strict: "Strict",
  },
  withinTarget: "within the target",
  withinHeading: "within the heading-to target",
  gapLegend: "needed for the target, not met yet",
  uncoveredLegend: "a gap no recommendation covers",
  uncoveredHead: "Not covered by a recommendation",
  uncoveredIntro:
    "Criteria within the target that do not meet their bar, and that no recommendation moves. Add a recommendation for each, or leave it deliberately and say why.",
  leftHead: "Left on purpose",
  leftIntro:
    "Gaps within the target the audit leaves on purpose for now, each with the reason.",
  leftLegend: "left on purpose",

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
  /** A criterion examined at one of the two audits only: neither fixed nor regressed. */
  examination: {
    examined: "Examined now",
    unexamined: "Not examined now",
  },
  examinationHead: "Examined at one audit only",
  stillOpen: "still open",
  changedHead: "What changed",
  change: "Change",
  beforeAfter: "Before → after",
  stillOpenWithin: "still open within {profile}",
  stillOpenBeyond: "beyond it, not needed for this profile",
  stillOpenHead: "Still open within the target",
  stillOpenBeyondHead: "Still open beyond the target",
  stillOpenBeyondWhy:
    "Not met at either audit, and not needed for {profile}: its target does not reach them.",
  stillOpenBeyondNote:
    "The {n} still open beyond the target are in Module detail, marked not needed for this profile.",
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
  howToReadHead: "How to read this",
  howToRead:
    "Jig audits how a repository delivers changes: practices grouped in modules, each criterion scored on the enforcement ladder (absent, convention, advisory, mechanical), against the target of the profile the team aims for. Only a criterion within that target that is not met yet is a gap.",
  guideIn:
    "The guide in the HTML sheet explains the modules, the profiles and how the audit works:",
  trend: "Trend",
  trendIntro:
    "Each module's level at every audit given, oldest first, for the modules whose level changed.",
  moduleCount: { one: "module", many: "modules" },
  movedUp: "moved up",
  movedDown: "moved down",
  movedOther: "changed to or from n/a, not examined or incomplete",
  andWord: "and",
  sinceWord: "since",
  trendNone: "No module's level changed since {date}.",
  trendSteady:
    "No module ends at another level than on {date}; the ones below changed in between.",
  /** Read before a level that rose or fell, where the arrow cannot be seen. */
  moveWord: { up: "up to", down: "down to" },
  moveArrow: { up: "↑", down: "↓" },

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
    "Every criterion of every module: its level, its pass bar, its score, whether a probe or the agent decided it, and the evidence. Open a module to see its criteria.",
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
    "not-examined": "not examined",
  },
  rungMeaning: {
    absent: "not there yet",
    convention: "written down, kept by habit",
    advisory: "a tool reports it but does not block",
    mechanical: "a check blocks the change",
    "expected-absent": "does not apply to this shape",
    "not-examined": "the audit did not look: past what the profile asks",
  },
  notScoredMeaning: "no score in the record",
} as const;

/** Which form of a counted label a number takes. */
export const plural = (n: number): "one" | "many" => (n === 1 ? "one" : "many");

/**
 * The words only the HTML sheet writes: its contents bar, the choices, the
 * tray, the script's messages, the popovers and the way into the guide.
 */
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
    guide: "Guide",
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
  conditionsHead: "Conditional targets that apply",
  appliesWhen: "applies when",
  forHeading: "for {profile}, where the project is heading,",
  conditionsChosen: "conditional targets",
  noneWord: "none",
  scoreWrong: "This score is wrong",
  scoresFlagged: "Scores flagged wrong",
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

  mapMarks:
    "Each mark is one criterion: its icon and colour show the rung of the enforcement ladder it reached. Point at a mark, or move to it with the Tab key, to read what it asks and where it stands.",
  levelAndTarget: "Level and target",
  /** Inside a criterion's popover. */
  pop: {
    requires: "Requires",
    orStronger: "or stronger",
    score: "Score",
  },
  /** Where a criterion stands, in its popover. */
  standing: {
    gap: "Needed for the target, not met yet.",
    uncovered: "No recommendation covers it.",
    withinMet: "Within the target, and met.",
    beyondMet: "Met, beyond what this profile asks for.",
    notNeeded: "Not met yet, and not needed for this profile.",
    met: "Meets its bar.",
    notMet: "Does not meet its bar yet.",
    na: "Does not apply to this repository's shape.",
    notExamined: "Not examined: beyond the target, so the audit did not look.",
    left: "Left on purpose:",
  },
  sinceCompared: "Compared with the audit of {date} (plugin {version}).",
  noScore: "none",
  moveTo: "to",

  welcome:
    "This sheet shows where {repo} stands on the delivery practices Jig describes, measured against the profile the team aims for, and what to do next. Besides its own record, nothing in the repository changes unless the team asks.",
  readGuide: "New to Jig? Read the guide (5 min)",
  howToRead: "How to read this report",
  backToReport: "Back to the report",
} as const;

/** The name of a rendered sheet and its Markdown copy, before the extension. */
export const FILE_STEM = "jig-audit-";
