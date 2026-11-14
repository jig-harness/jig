/**
 * Scratch chapters and repositories for the generator's tests: a chapter
 * whose values a test sets, the files the generator reads around it, and git
 * run in a scratch repository without the caller's git environment.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../plugin/shared/guarded-git-spawn.ts";
import type {
  Chapter,
  ChapterStatus,
  DataValue,
  FieldSpec,
  PlanItem,
} from "../chapter.ts";
import { table } from "../markdown.ts";
import { END_MARKER, startMarker } from "../render.ts";

export const SOURCE = "fixture/table.ts#TABLE";

export const FIELDS: Readonly<Record<string, FieldSpec>> = {
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description: "The value's name.",
  },
  code: {
    type: "integer",
    nullable: false,
    required: true,
    identifies: true,
    description: "Its code.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description: "What it means.",
  },
};

export const VALUES: readonly DataValue[] = [
  { name: "ALPHA", code: 1, meaning: "the first thing happened" },
  { name: "BETA", code: 2, meaning: "the second thing happened" },
];

export interface FixtureOptions {
  id?: string;
  version?: number;
  status?: ChapterStatus;
  planItems?: readonly PlanItem[];
  values?: readonly DataValue[];
  fields?: Readonly<Record<string, FieldSpec>>;
  sources?: readonly string[];
  takes?: readonly string[];
}

/** A chapter of one table, `SOURCE`, listing `values`. */
export function fixtureChapter(options: FixtureOptions = {}): Chapter {
  const id = options.id ?? "fixture";
  const values = options.values ?? VALUES;
  const render = () =>
    table(
      ["Name", "Code", "Meaning"],
      values.map((v) => [
        String(v.name),
        String(v.code),
        String(v.meaning ?? ""),
      ]),
    );
  return {
    id,
    title: `The ${id} chapter`,
    summary: `What ${id} covers.`,
    version: options.version ?? 1,
    status: options.status ?? "stable",
    planItems: options.planItems ?? [],
    module: "tools/protocol/__tests__/fixture.ts",
    sections: (options.sources ?? [SOURCE]).map((source) => ({
      source,
      render,
    })),
    fields: options.fields ?? FIELDS,
    values: () => values,
    takes: () => options.takes ?? values.map((v) => `${SOURCE}.${v.name}`),
    excluded: [],
  };
}

/** A chapter file as an author writes it: title, a placeholder status line, prose and empty markers. */
export function chapterSource(
  title: string,
  sources: readonly string[] = [SOURCE],
): string {
  return [
    `# ${title}`,
    "",
    "Version 0",
    "",
    "Prose a person wrote.",
    "",
    ...sources.flatMap((s) => [startMarker(s), END_MARKER, ""]),
    "Closing prose.",
    "",
  ].join("\n");
}

export const INDEX_SOURCE_TEXT = [
  "# The Jig Protocol",
  "",
  "An introduction a person wrote.",
  "",
  startMarker("tools/protocol/chapters.ts#CHAPTERS"),
  END_MARKER,
  "",
].join("\n");

export const PLAN_TEXT = "# Plan\n\n### 7. An open item\n\nText.\n";

/** Write a file under `root`, creating its folders. */
export function put(root: string, path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** The files the generator reads around `chapters`: each chapter's file, the index page and the plan. */
export function layout(root: string, chapters: readonly Chapter[]): void {
  for (const c of chapters)
    put(root, `plugin/protocol/${c.id}.md`, chapterSource(c.title));
  put(root, "plugin/protocol/README.md", INDEX_SOURCE_TEXT);
  put(root, "design/plan.md", PLAN_TEXT);
}

const scratch: string[] = [];

/** A new scratch directory, removed by `cleanUp`. */
export function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `jig-protocol-${prefix}-`));
  scratch.push(path);
  return path;
}

export function cleanUp(): void {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
}

const gitEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  ) as Record<string, string>;

/** git in a scratch repository, without the caller's git environment. */
export function git(dir: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "protocol.file.allow=always",
      "-C",
      dir,
      ...args,
    ],
    { env: gitEnv() },
  );
  return { ...result, exitCode: result.status };
}

/** git, asserting it succeeded; its output. */
export function ok(dir: string, ...args: string[]): string {
  const result = git(dir, ...args);
  expectSpawnExit(result, 0, `git ${args.join(" ")}`);
  return String(result.stdout);
}

/** Stage everything and commit it. */
export function commit(dir: string, message: string): void {
  ok(dir, "add", "-A");
  ok(dir, "commit", "-q", "--allow-empty", "-m", message);
}
