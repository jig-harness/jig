/**
 * The commands a repository supplies to Jig: each setting of `.config/jig.yaml`
 * whose value is a shell command Jig runs, with what the command is given,
 * what it answers with, the exits its caller tells apart, the deadline its
 * caller holds it to and whether it runs under the command store's rules
 * (`repo-command.ts`). The callers that bound a command or branch on an exit
 * take those numbers from here; the Jig Protocol's chapter on the commands a
 * repository supplies (`plugin/protocol/repo-commands.md`) is generated from
 * this table.
 *
 * Nothing here imports anything, so the chapter's generator reads the table
 * without loading the skills that run the commands.
 */

/** The most standard output a command under the command store's rules may write; more fails the run. */
export const REPO_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;

/** The exit by which `do_item.preflight_command` refuses a claim, its reason on the first line of standard output. */
export const PREFLIGHT_REFUSAL_EXIT = 3;
/** The variable that bounds `do_item.preflight_command`, in seconds. */
export const PREFLIGHT_TIMEOUT_ENV = "JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC";
export const DEFAULT_PREFLIGHT_TIMEOUT_SEC = 60;

/** The variable that bounds the check command of a `followup.arms` entry, in seconds. */
export const FOLLOWUP_CHECK_TIMEOUT_ENV = "JIG_FOLLOWUP_CHECK_TIMEOUT_SEC";
export const DEFAULT_FOLLOWUP_CHECK_TIMEOUT_SEC = 60;

/** The exit by which `ci.log_command` says the log no longer exists. */
export const LOG_GONE_EXIT = 3;
/** The variable that overrides `ci.log_command`'s deadline. */
export const LOG_COMMAND_TIMEOUT_ENV = "JIG_FIX_CI_LOG_COMMAND_TIMEOUT_SEC";
/** Seconds one run of `ci.log_command` may take, unless the environment says otherwise. */
export const DEFAULT_LOG_COMMAND_SECONDS = 300;

/** The variable that bounds `code_stats.classify_command`, in seconds. */
export const CLASSIFY_TIMEOUT_ENV = "JIG_CODE_STATS_COMMAND_TIMEOUT_SEC";
export const DEFAULT_CLASSIFY_TIMEOUT_SEC = 300;

/** The exit by which a reflection store's command says the store is unavailable: unreachable, or not signed in. */
export const REFLECTION_STORE_UNAVAILABLE_EXIT = 3;
/** Seconds one operation of a reflection store's command may take unless `reflection.timeout_sec` says otherwise; `list` and `diagnose` get five times it. */
export const DEFAULT_REFLECTION_TIMEOUT_SEC = 120;

/** The variable that bounds `changelog.after_version`, in seconds. */
export const AFTER_VERSION_TIMEOUT_ENV = "JIG_AFTER_VERSION_TIMEOUT_SEC";
export const DEFAULT_AFTER_VERSION_TIMEOUT_SEC = 1800;

/** Total seconds for all package installs before validating one base merge. */
export const DEPENDENCY_INSTALL_TIMEOUT_SECONDS = 1200;

/** How long a caller lets one run take, and the environment variable or setting that changes it. */
export interface CommandDeadline {
  readonly seconds: number;
  readonly changedBy: string;
}

/** One command a repository supplies, as its callers run it. */
export interface RepoCommandContract {
  /** The skills and components that run it, as the configuration schema's `read_by` names them. */
  readonly runBy: readonly string[];
  /** Whether its value is a command line Jig hands to the platform's shell; false for words Jig runs without one. */
  readonly shell: boolean;
  /** What it is given: its standard input, its arguments, where it runs. */
  readonly given: string;
  /** What it answers with: exit 0, and what it prints. */
  readonly answers: string;
  /** Whether it runs under the command store's rules: from the default branch alone, without the tracker and forge tokens. */
  readonly commandStore: boolean;
  /** The deadline its caller holds one run to; null where the caller sets none of its own. */
  readonly deadline: CommandDeadline | null;
  /** The exits besides 0 its caller tells apart from a failure, with what each means. */
  readonly exits: Readonly<Record<number, string>>;
  readonly meaning: string;
}

/**
 * Every setting whose value is a command Jig runs, keyed by its path in the
 * configuration schema (`skills/audit/config-schema.yaml`). A command exits 0
 * for success; any exit `exits` does not list is a failure.
 */
export const REPO_COMMANDS = {
  "gates.command": {
    runBy: [
      "resolve-review-comments",
      "drive-pr",
      "fix-ci",
      "resolve-conflicts",
      "descar",
    ],
    shell: true,
    given:
      "Nothing: it runs from the repository root, in the working tree being changed.",
    answers:
      "Exit 0 when every local check the repository runs in this session passes. A repository may run fewer in a session its dispatcher starts, as `gates.dispatch_fast` describes, and leave the rest to CI.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning:
      "The repository's local checks, run before every push: all of them, except in a session its dispatcher starts, where `gates.dispatch_fast` may leave some to CI. resolve-review-comments refuses to start without it, and it is drive-pr's one local check where `drive.validation_plan_command` is not set.",
  },
  "drive.validation_plan_command": {
    runBy: ["drive-pr", "fix-ci", "resolve-conflicts", "review", "descar"],
    shell: true,
    given: "The changed files on standard input, one path per line.",
    answers:
      "Exit 0 and the validation plan as one JSON object on standard output; a nonzero exit or output that is not a JSON object is reported apart from a plan.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning:
      "Says which checks and reviews a change needs. The change-areas skill's resolver prints such a plan from the change-area catalog.",
  },
  "drive.load_guard_command": {
    runBy: ["drive-pr"],
    shell: true,
    given:
      "Nothing: it runs from the repository root before a round's heavy checks.",
    answers:
      "Exit 0 once the machine can take the checks; any other exit is a warning that the round's heavy checks may be refused.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning: "Waits until the machine can take a round's heavy checks.",
  },
  "drive.dependency_install": {
    runBy: ["drive-pr", "resolve-conflicts"],
    shell: true,
    given:
      "Nothing on standard input. Each command runs in its lockfile's directory in the merged worktree.",
    answers:
      "Exit 0 when the pinned dependencies are available without changing the dependency inputs. Any other exit stops the round before validation.",
    commandStore: false,
    deadline: {
      seconds: DEPENDENCY_INSTALL_TIMEOUT_SECONDS,
      changedBy: "fixed per merge",
    },
    exits: {},
    meaning:
      "Overrides the frozen dependency install command for a recognized lockfile. A drive round reads overrides from its trusted policy.",
  },
  "ci.log_command": {
    runBy: ["fix-ci"],
    shell: true,
    given:
      'One JSON object, `{"context", "target_url"}`, the failing commit status\'s context and the page it links to (null when it links to none), on standard input. It runs in a temporary copy of the default branch\'s files, not in the pull request\'s working tree.',
    answers: `Exit 0 and the status's failed log on standard output, at most ${REPO_COMMAND_MAX_OUTPUT_BYTES / 1024} KiB of it.`,
    commandStore: true,
    deadline: {
      seconds: DEFAULT_LOG_COMMAND_SECONDS,
      changedBy: LOG_COMMAND_TIMEOUT_ENV,
    },
    exits: {
      [LOG_GONE_EXIT]:
        "The log is gone (the build was deleted or its log rotated away); the first line of standard output is the reason.",
    },
    meaning:
      "Reads the failed log of a commit status, for a CI service that reports as commit statuses and keeps its logs where only the repository knows how to reach them.",
  },
  "do_item.preflight_command": {
    runBy: ["do-item", "work-batch", "dispatch"],
    shell: true,
    given:
      "The item's JSON, as `get_issue.ts` prints it, on standard input. It runs from the repository root before a claim takes its lock or writes anything.",
    answers: "Exit 0 lets the claim go on.",
    commandStore: true,
    deadline: {
      seconds: DEFAULT_PREFLIGHT_TIMEOUT_SEC,
      changedBy: PREFLIGHT_TIMEOUT_ENV,
    },
    exits: {
      [PREFLIGHT_REFUSAL_EXIT]:
        'Refuses the claim: nothing is written, the claim exits 3 with `"why": "preflight"`, and the first line of standard output is the reason. Any other failure refuses it too.',
    },
    meaning:
      "The repository's own start rules, run by every claim of an item: by do-item, by work-batch for each member, and by a dispatched pickup.",
  },
  "followup.arms": {
    runBy: ["followup"],
    shell: true,
    given:
      "The follow-up's merge facts as one JSON object on standard input (`followup.ts facts` prints the same object). Each entry's `check_command` runs from the repository root, as the integration branch's configuration names it.",
    answers: `Exit 0 and one verdict JSON object on standard output, \`{"verdict": "owed"|"not-owed"|"pending"|"unread", "items": [...], "evidence": "..."}\`, at most ${REPO_COMMAND_MAX_OUTPUT_BYTES / 1024} KiB. A run past its deadline, any other exit, or output that is not such an object records the arm \`unread\` with the reason, never \`not-owed\`.`,
    commandStore: true,
    deadline: {
      seconds: DEFAULT_FOLLOWUP_CHECK_TIMEOUT_SEC,
      changedBy: FOLLOWUP_CHECK_TIMEOUT_ENV,
    },
    exits: {},
    meaning:
      "A repository's own follow-up arm, read-only: says whether a merge owes what that arm checks. The followup skill records its verdict through the same ledger as every other arm.",
  },
  "descar.lint_command": {
    runBy: ["descar"],
    shell: true,
    given: "The paths of the documents to check, as arguments.",
    answers: "The scars it finds, which descar's steps read.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning: "Finds review scars in documents.",
  },
  "promote_memory.lint_command": {
    runBy: ["promote-memory"],
    shell: true,
    given:
      "The command line with `{dir}` and `{file}` replaced by the memory's folder and file.",
    answers: "Exit 0 when the memory is clean.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning: "Checks one agent memory against the repository.",
  },
  "fix_ci.regenerate_commands": {
    runBy: ["fix-ci"],
    shell: true,
    given: "Nothing: each runs from the repository root.",
    answers: "Exit 0 once it has rewritten its generated files.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning:
      "Each regenerates committed generated files a CI check compares; a list of commands.",
  },
  "resolve_conflicts.generated": {
    runBy: ["resolve-conflicts"],
    shell: true,
    given: "Nothing: each entry's `command` runs from the repository root.",
    answers: "Exit 0 once it has rebuilt the files its entry's `paths` match.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning:
      "Rebuilds files that are regenerated, never merged by hand, when they conflict; each entry pairs `paths` with the `command` that rebuilds them.",
  },
  "explain.figure_build_command": {
    runBy: ["explain"],
    shell: true,
    given: "The command line with the figure's stem appended.",
    answers: "Exit 0 once the figure is built beside its diagram source.",
    commandStore: false,
    deadline: null,
    exits: {},
    meaning: "Builds one explainer figure.",
  },
  "reflection.command": {
    runBy: ["reflect", "review-reflections", "dispatch"],
    shell: false,
    given:
      'A command line split into words, or a list of words, run without a shell, with the operation appended: `check`, `append` (the findings as JSON Lines on standard input), `list` (an optional `{"since"}` object on standard input) or `diagnose`. `list` and `diagnose` get five times the deadline, since they read the whole store.',
    answers:
      "Exit 0 and the operation's answer as JSON or JSON Lines on standard output, as the reflect skill's store contract says; its conformance suite checks a store command against it.",
    commandStore: false,
    deadline: {
      seconds: DEFAULT_REFLECTION_TIMEOUT_SEC,
      changedBy: "reflection.timeout_sec",
    },
    exits: {
      [REFLECTION_STORE_UNAVAILABLE_EXIT]:
        "The store is unavailable (unreachable, or not signed in): reflect keeps the findings in its journal rather than failing. A run past its deadline, or one that cannot start, is read the same way.",
    },
    meaning:
      "The reflection store, where `reflection.store` is `command`: it keeps the findings sessions record with the reflect skill.",
  },
  "changelog.after_version": {
    runBy: ["changelog"],
    shell: true,
    given:
      "Nothing: it runs from the repository root after the release step changes the version and before it deletes the change notes. Inside a CI job the release refuses to run it unless the job sets `JIG_AFTER_VERSION_IN_CI=1`.",
    answers:
      "Exit 0, leaving no process it started running. Its standard output is not read, only shown on standard error; the files it changed go into the release commit.",
    commandStore: false,
    deadline: {
      seconds: DEFAULT_AFTER_VERSION_TIMEOUT_SEC,
      changedBy: AFTER_VERSION_TIMEOUT_ENV,
    },
    exits: {},
    meaning:
      "Updates the files that repeat the version, such as a lock file, for the release commit.",
  },
  "code_stats.classify_command": {
    runBy: ["code-stats"],
    shell: true,
    given:
      "Every tracked path on standard input, one per line; it runs once, from the repository root.",
    answers:
      'Exit 0 and one JSON object per line, `{"path", "area"?, "kind"?, "language"?, "module"?}`, whose values override the skill\'s own classification. A line it cannot use, an untracked path, or an unknown area or kind fails the report.',
    commandStore: false,
    deadline: {
      seconds: DEFAULT_CLASSIFY_TIMEOUT_SEC,
      changedBy: CLASSIFY_TIMEOUT_ENV,
    },
    exits: {},
    meaning:
      "The last layer of code-stats' classification of the repository's files.",
  },
} as const satisfies Readonly<Record<string, RepoCommandContract>>;
