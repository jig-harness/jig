/**
 * The chapter on the commands a repository supplies, generated from the table
 * of repository commands (`REPO_COMMANDS`): each setting whose value is a
 * command Jig runs, what it is given and answers with, the deadline its
 * caller holds it to, and the exits its caller tells apart.
 */
import {
  REPO_COMMAND_MAX_OUTPUT_BYTES,
  REPO_COMMANDS,
  type RepoCommandContract,
} from "../../../plugin/shared/repo-commands.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { flag, table } from "../markdown.ts";
import { COMMAND_OUTPUT_SHAPES } from "../../../plugin/shared/repo-command-shapes.ts";
import { REFLECTION_EVENT_SHAPE } from "../../../plugin/skills/reflect/scripts/lib/event-shapes.ts";

const SOURCE_FILE = "plugin/shared/repo-commands.ts";
const SOURCE = `${SOURCE_FILE}#REPO_COMMANDS`;

/** Entries of `REPO_COMMANDS` this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

const entries = (): [string, RepoCommandContract][] =>
  Object.entries(REPO_COMMANDS).filter(
    ([name]) => !EXCLUDED.includes(`${SOURCE}.${name}`),
  );

const none = {
  runBy: null,
  shell: null,
  given: null,
  answers: null,
  commandStore: null,
  deadlineSec: null,
  deadlineChangedBy: null,
};

function values(): DataValue[] {
  return entries().flatMap(([name, c]) => [
    {
      kind: "command",
      name,
      setting: name,
      exit: null,
      runBy: c.runBy.join(", "),
      shell: c.shell,
      given: c.given,
      answers: c.answers,
      commandStore: c.commandStore,
      deadlineSec: c.deadline?.seconds ?? null,
      deadlineChangedBy: c.deadline?.changedBy ?? null,
      meaning: c.meaning,
    },
    ...Object.entries(c.exits).map(([exit, meaning]) => ({
      kind: "exit",
      name: `${name}:${exit}`,
      setting: name,
      exit: Number(exit),
      ...none,
      meaning,
    })),
  ]);
}

const setting = (name: string) => `\`${name}\``;

const deadline = (c: RepoCommandContract) =>
  c.deadline === null
    ? "—"
    : `${c.deadline.seconds} s (\`${c.deadline.changedBy}\`)`;

function commandsTable(): string {
  return table(
    ["Setting", "Run by", "Command store's rules", "Deadline", "Meaning"],
    entries().map(([name, c]) => [
      setting(name),
      c.runBy.join(", "),
      flag(c.commandStore),
      deadline(c),
      c.meaning,
    ]),
  );
}

function contractTable(): string {
  return table(
    ["Setting", "Through a shell", "Given", "Answers with"],
    entries().map(([name, c]) => [
      setting(name),
      flag(c.shell),
      c.given,
      c.answers,
    ]),
  );
}

function exitsTable(): string {
  return table(
    ["Setting", "Exit", "Meaning"],
    entries().flatMap(([name, c]) =>
      Object.entries(c.exits).map(([exit, meaning]) => [
        setting(name),
        exit,
        meaning,
      ]),
    ),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "command for a setting whose value is a command Jig runs, exit for an exit besides 0 that the command's caller tells apart from a failure.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "For a command, its setting; for an exit, the setting of the command that exits with it and the code, as <setting>:<code>.",
  },
  setting: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "The setting's path in .config/jig.yaml, as the configuration schema names it: for an exit, the setting of the command that exits with it.",
  },
  exit: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description: "For an exit, its code; null for a command.",
  },
  runBy: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    comparedAs: "names",
    description:
      "For a command, the skills and components that run it, comma-separated; null for an exit.",
  },
  shell: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a command, whether its value is one command line Jig hands to the platform's shell (sh, or cmd.exe on Windows); false for words run without one. Null for an exit.",
  },
  given: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    comparedAs: "prose",
    description:
      "For a command, what it is given: its standard input, its arguments and where it runs; null for an exit.",
  },
  answers: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    comparedAs: "prose",
    description:
      "For a command, what it answers with on success, exit 0; null for an exit.",
  },
  commandStore: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description: `For a command, whether it runs under the command store's rules: read from the default branch alone, run without the tracker and forge tokens, and failed past ${REPO_COMMAND_MAX_OUTPUT_BYTES} bytes of standard output; null for an exit.`,
  },
  deadlineSec: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a command, the seconds its caller lets one run take before stopping it and failing the run; null where the caller sets no deadline of its own, and for an exit.",
  },
  deadlineChangedBy: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "The environment variable, or the setting of .config/jig.yaml, that changes deadlineSec; null where deadlineSec is.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "For a command, what the repository supplies it for; for an exit, what the caller does when the command exits with it.",
  },
};

export const REPO_COMMANDS_CHAPTER: Chapter = {
  schemas: [
    ...Object.entries(COMMAND_OUTPUT_SHAPES).map(([name, shape]) => ({
      name,
      shape,
    })),
    { name: "reflection-event", shape: REFLECTION_EVENT_SHAPE },
  ],
  id: "repo-commands",
  title: "Commands a repository supplies",
  summary:
    "The settings whose value is a command Jig runs: what each command is given, what it answers with, its deadline and the exits its caller reads.",
  version: 1,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/repo-commands.ts",
  sections: [
    { source: SOURCE, render: commandsTable },
    { source: SOURCE, render: contractTable },
    { source: SOURCE, render: exitsTable },
  ],
  fields: FIELDS,
  values,
  takes: () => entries().map(([name]) => `${SOURCE}.${name}`),
  excluded: EXCLUDED,
};
