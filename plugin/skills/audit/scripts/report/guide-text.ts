/**
 * The words of the guide the audit sheet carries: what Jig is, the idea, the
 * modules, the profiles, how the audit works and how to read the sheet, for
 * a reader who has never met Jig. The plugin ships without Jig's module and
 * principle documents, so the guide's prose lives here; everything that can
 * be derived is: the modules and their purposes come from the criteria
 * files, the profiles' targets from `profiles.yaml`, the rungs' names from
 * the labels.
 *
 * The method's words (profile, level, target, gap, probe) each have one
 * meaning and one section of the guide here, so a word linked anywhere in
 * the sheet opens the section that explains it.
 */
import type { Score } from "../lib/criteria.ts";

/** Where the guide's sections are, so the rest of the sheet can link to them. */
export const GUIDE_ID = {
  guide: "guide",
  what: "guide-what",
  idea: "guide-idea",
  ladder: "guide-ladder",
  modules: "guide-modules",
  levels: "guide-levels",
  profiles: "guide-profiles",
  process: "guide-process",
  read: "guide-read",
  words: "guide-words",
} as const;

/** A word of the method: its meaning, and the guide section that explains it. */
export interface MethodTerm {
  term: string;
  section: string;
  meaning: string;
}

export const METHOD_TERMS = {
  ladder: {
    term: "Enforcement ladder",
    section: GUIDE_ID.ladder,
    meaning:
      "The rungs a rule climbs: not there (absent), written down (convention), reported by a tool (advisory), blocked by a check (mechanical).",
  },
  module: {
    term: "Module",
    section: GUIDE_ID.modules,
    meaning:
      "One practice, adopted on its own, with the criteria that say how far a repository has taken it.",
  },
  level: {
    term: "Level",
    section: GUIDE_ID.levels,
    meaning:
      "Lite, Standard or Strict: how far one module has come. A module attains a level when every criterion at that level and below meets its bar.",
  },
  profile: {
    term: "Profile",
    section: GUIDE_ID.profiles,
    meaning:
      "The aim for the whole repository: a target level for each module. The team's choice, never a grade.",
  },
  target: {
    term: "Target",
    section: GUIDE_ID.profiles,
    meaning: "The level the profile asks one module to reach.",
  },
  heading: {
    term: "Heading to",
    section: GUIDE_ID.profiles,
    meaning:
      "The profile the project is growing toward. Its targets show as a dashed line under the map's marks.",
  },
  conditional: {
    term: "Conditional target",
    section: GUIDE_ID.profiles,
    meaning:
      "A target that applies only when the team says its condition holds.",
  },
  gap: {
    term: "Gap",
    section: GUIDE_ID.read,
    meaning: "A criterion within the target that is not met yet.",
  },
  uncovered: {
    term: "Uncovered gap",
    section: GUIDE_ID.read,
    meaning:
      "A gap no recommendation moves and no declined recommendation leaves on purpose.",
  },
  probe: {
    term: "Probe",
    section: GUIDE_ID.process,
    meaning:
      "A small script that scores a criterion absent when a fact the criterion needs is missing. The agent scores everything else.",
  },
} as const satisfies Record<string, MethodTerm>;

export type MethodTermKey = keyof typeof METHOD_TERMS;

/** The repository's documentation, for the reader who wants more than the guide. */
const DOCS = "https://github.com/docomply/jig/blob/main/";

/** Who each shipped profile is for. A test holds this to `profiles.yaml`, so a new profile cannot go without one. */
export const PROFILE_WHO: Readonly<Record<string, string>> = {
  "solo-lite":
    "One person, or a short-lived project: the minimum that keeps an agent-assisted repository coherent.",
  "team-standard":
    "Software a team maintains in production, with several people or agents contributing.",
  "regulated-strict":
    "A regulated domain, or a project with compliance or audit obligations.",
};

export const GUIDE = {
  head: "Guide",
  intro:
    "A short guide to Jig and to this sheet, for a reader who has met neither. It takes about five minutes.",
  what: {
    h: "What this is",
    p: [
      "Jig describes delivery practices for repositories where people and AI agents work together: how the instructions are written, which checks guard a change, how decisions and reviews are kept.",
      "This audit tells a repository where it stands on those practices, and what to do next, in order.",
      "The audit only reads the repository. The one file it writes is its own record, `.config/jig-audit.yaml`, which keeps the scores and the team's decisions for the next audit; nothing else changes unless the team asks for a recommendation to be applied.",
    ],
  },
  idea: {
    h: "The idea",
    p: "The practices come as modules. Each module solves one problem and is adopted on its own; the map lists them in the order most teams adopt them.",
    ladderH: "The enforcement ladder",
    ladder:
      "A rule a team cares about climbs a ladder. Each rung is harder to forget than the one below it:",
    rung: {
      absent: "Nobody has written the rule down, and nothing checks it.",
      convention:
        "The rule is written down, in an instruction file or a document, and kept by habit.",
      advisory:
        "A tool reports when the rule is broken, but the change can still go in.",
      mechanical: "A check blocks the change until the rule holds.",
      "expected-absent":
        "The practice does not apply to this repository's shape, so it is not counted.",
      "not-examined":
        "The criterion lies beyond the profile's target, and the audit chose not to examine it. It is not counted, and it is never a gap.",
    } satisfies Record<Score, string>,
    unscored: "The record holds no score for the criterion.",
    higher:
      "Higher is not always better. A rule worth a blocking check in a large team may be fine written down for one person. The profile says how far each module should go.",
  },
  modules: {
    h: "The modules",
    p: "Each module has criteria. Each criterion has a level and a bar: the rung it must reach, either written down (convention) or blocked by a check (mechanical).",
    list: "The modules, with the problem each one solves:",
    levelsH: "Levels: Lite, Standard, Strict",
    levels:
      "A module attains a level when every criterion at that level and below meets its bar: Lite first, then Standard, then Strict. A module with a Lite criterion not met attains none yet. A module whose practices the repository's shape rules out is n/a; one whose criteria the audit did not examine is not examined.",
  },
  profiles: {
    h: "Profiles",
    p: "A profile is the aim for the whole repository: for each module, the level the team wants it to reach. That level is the module's target.",
    names:
      "Profile names and module levels share words, but they are different things. Team/Standard is a profile: the aim for the whole repository. Standard is a level: how far one module has come. Team/Standard asks for Standard in some modules and for nothing in others.",
    dial: "The profile is the team's dial, never a grade. Lighter is often right: a practice the profile does not ask for is not a shortfall, and the sheet never marks it as one.",
    heading:
      "A team can also name the profile it is heading to. The sheet then shows that profile's targets as a dashed line, and lists the recommendations that lead there under As you grow.",
    conditional:
      "Some targets apply only under a condition, such as several agents working in parallel. The team says which conditions hold, and only those conditional targets count.",
    table:
      "What each profile asks of each module. A dash means the profile sets no target for that module.",
    when: "when",
    none: "—",
  },
  process: {
    h: "How the audit works",
    steps: [
      [
        "Configuration check",
        "A script checks the repository's Jig configuration against the plugin and against the repository itself.",
      ],
      [
        "Surveys",
        "The agent reads the repository: its instructions, its checks, its documentation and how it reviews changes.",
      ],
      [
        "Scoring",
        "Every criterion gets a rung, with the files that show it. A probe, a small script, scores a criterion absent when a fact it needs is missing; the agent scores everything else.",
      ],
      [
        "The record",
        "The scores, the profile and the recommendations the team declined are saved in the repository, in .config/jig-audit.yaml, so the next audit can compare.",
      ],
      [
        "This sheet",
        "Everything above, in one file that works offline and prints.",
      ],
      [
        "Decisions",
        "For each recommendation the team chooses: accept it, take the lighter option, refine it with a note, decline it with a reason and a condition for revisiting, or say it is wrong. Any score can be flagged as wrong, and the profile and its conditions can be changed.",
      ],
      [
        "Back to the agent",
        "Copy decisions gives one block of text. Pasted to the agent, it is recorded: declines are kept, the accepted work is listed in order, and flagged scores are checked again.",
      ],
      [
        "Next time",
        "A later audit compares with the record: what was fixed, what slipped, what Jig added, and each module's level over time.",
      ],
    ],
  },
  read: {
    h: "How to read this report",
    items: [
      [
        "The maturity map",
        "One row per module. Each mark is a criterion; its icon and colour give its rung. A solid line under marks spans the profile's target, a dashed line the heading-to profile's. An amber ring marks a gap: within the target and not met yet. An amber dot on the ring marks an uncovered gap.",
      ],
      [
        "Recommendations",
        "Grouped by module. For now: what the profile asks today. As you grow: what the heading-to profile will ask. Optional: beyond both, for when the project needs it.",
      ],
      [
        "Not covered by a recommendation",
        "The gaps no recommendation addresses, so each one is either taken up or left on purpose.",
      ],
      [
        "Since the last audit",
        "On a re-audit: what changed for each criterion, a coloured badge for each kind of change, and each module's level over time.",
      ],
    ],
  },
  words: {
    h: "Words used in this sheet",
    own: "The words this repository's report uses are under",
  },
  more: {
    h: "More about Jig",
    links: [
      ["The modules", `${DOCS}modules/README.md`],
      ["The principles", `${DOCS}principles/README.md`],
      ["The profiles", `${DOCS}profiles/README.md`],
      [
        "Adopting Jig in an existing repository",
        `${DOCS}adoption/brownfield.md`,
      ],
    ],
  },
} as const;
