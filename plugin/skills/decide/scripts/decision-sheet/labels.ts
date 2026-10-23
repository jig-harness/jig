/**
 * Every fixed string a projection adds around the source's own text. Nothing
 * else may appear in a rendered sheet: the "no claim absent from the source"
 * test reads this table as the complete list of what the renderer may add.
 * Each label names a slot. None of them states a fact about the decision.
 */
import type { OutcomeKind } from "./source.ts";

export const OUTCOME_ICON: Record<OutcomeKind, string> = {
  safe: "✓",
  risk: "✕",
  human: "?",
  neutral: "–",
};

export const OUTCOME_WORD: Record<OutcomeKind, string> = {
  safe: "Safe",
  risk: "Risk",
  human: "Human",
  neutral: "Neutral",
};

export const LABEL = {
  theQuestion: "The question",
  decisionNote: "decision",
  currentBehaviour: "What the system does now",
  settled: "Already decided",
  settledNote: "not reopened here",
  hiddenBranches: "Before you choose",
  hiddenBranchesNote: "hidden branches",
  nextStep: "Next step:",
  outcomes: "What happens",
  outcomesNote: "outcome by scenario",
  option: "Option",
  options: "Options",
  optionsNote: "keep · pay · right when",
  keep: "Keep",
  pay: "Pay",
  rightWhen: "Right when",
  obligation: "Obligation",
  followOn: "Follow-on questions",
  followOnNote: "answer per option",
  ifYouChoose: "If you choose",
  notes: "Notes",
  recommendation: "Recommendation",
  recommendationNote: "my read",
  myRead: "My read",
  recommended: "recommended",
  ruling: "Ruling",
  rulingNote: "human-decided",
  chosen: "chosen",
  decided: "Decided:",
  ruledOn: "Ruled",
  rulingRecord: "Ruling record",
  openInput: "Open input:",
  terms: "Terms",
  calls: "The calls",
  callsNote: "one sheet each",
  call: "Call",
  owners: "Owners",
  status: "Status",
  interplay: "How the calls interact",
  interplayNote: "interplay",
  facts: "Facts",
  overview: "Overview",
  backToOverview: "← Overview",
  title: "Title",
  decision: "Decision",
  priority: "Priority",
  reversibility: "Reversibility",
  factsVerified: "Facts verified",
  sheet: "Sheet",
  source: "Source:",
  open: "Open",
  /** The word a reference token `{opt:3}` expands to: "option 3". */
  refOption: "option",
} as const;

/**
 * The strings only the document template adds. Where the document
 * sheet uses a slot name that `LABEL` already holds, it reads `LABEL`, so a
 * word is defined once. The script of the sheet reads this whole table
 * (`DOCUMENT_SCRIPT` in `html-document-script.ts`), so no word is hard-coded there.
 * Nothing here states a fact about the decision.
 */
export const DOCUMENT_LABEL = {
  sheet: "Decision sheet",
  outcomes: "Outcomes",
  nextStep: "Next step",
  state: "State",
  answer: "Answer",
  connectsTo: "Connects to",
  openInput: "Open input",
  affects: "affects",
  navQuestion: "Question",
  navEvidence: "Evidence",
  navContents: "Sheet contents",
  stateOpen: "○",
  statePart: "◐",
  stateDone: "●",
  stateInput: "◆",
  recommendedState: "Recommended",
  pick: "Pick",
  unpick: "Unpick",
  yourPick: "Your pick",
  myPick: "My pick",
  myPicks: "My picks",
  unpickTitle: "Click again to remove your pick",
  trayNote:
    "Your own picks. They are kept in this browser only and are not a ruling.",
  addRightWhen: "Add “Right when” to each pick",
  addOpenInputs: "Add open inputs and next steps",
  note: "Note",
  pickNote: "Note on this pick",
  textToCopy: "Text to copy",
  copyText: "Copy text",
  copied: "Copied",
  copyFallback: "Select the text above and copy it",
  close: "Close",
  clearPicks: "Clear picks",
  removePick: "Remove pick",
  noPickYet: "No pick yet",
  of: "of",
  alsoMentioned: "Also mentioned in",
  timeLeft: "~{n} min left",
  timeEnd: "End",
  // Lines of the copy text. The pick line names the call and the option by id.
  copyPicksHead: "My picks:",
  copyPickHead: "My pick:",
  copyNoPick: "no pick yet",
  copyRecommended: "recommended",
  copyRecommendedPick: "the recommended option",
  copyRuled: "ruled",
  copyRightWhen: "Right when:",
  copyOpenInput: "Open input:",
  copyNextSteps: "Next steps:",
  copyNote: "Note:",
} as const;

/** The fixed sentences of the short comment. They point at the attachment and state no fact about the decision. */
export const COMMENT = {
  attached: "Decision sheet attached:",
  oneSheet: "It has one sheet.",
  // Layout-neutral: the document layout is one report, the compact layout one sheet per call.
  allCalls: "It covers every call.",
  open: "Download the file and open it in a browser.",
  overview: "This comment is the overview. It decides nothing.",
} as const;

export const SHEET_FILENAME_SUFFIX = "-decision-sheet.html";

/**
 * Title prefix of every decision-sheet attachment. Replacement selects on it,
 * so a sheet attachment is recognisable without reading its content.
 */
export const SHEET_ATTACHMENT_TITLE_PREFIX = "Decision sheet: ";
