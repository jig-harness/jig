#!/usr/bin/env bun
/**
 * The orchestration notebook: one topic's host-local record, in
 * `$JIG_HOME/orchestrate/<topic>/` (`~/.jig` by default), outside every
 * repository's working tree and tied to no agent's profile.
 *
 *   bun notebook.ts open <topic>     create the folder for a new topic, print
 *                                    where it is, the resume prompts and
 *                                    `state.md`
 *   bun notebook.ts state <topic>    rewrite `state.md` whole from stdin
 *   bun notebook.ts journal <topic>  append stdin to today's journal file
 *   bun notebook.ts list             the topics this host holds
 *
 * Exit 0 done; 1 the folder or a file could not be read or written; 2 usage;
 * 3 refused, nothing written: the state lacks a required section or the
 * input is empty; 4 refused, nothing written: the folder lies inside a Git
 * working tree.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { jigHome } from "../../../shared/config-layers.ts";
import { JigError } from "../../../shared/outcome.ts";
import { renameWithRetry } from "../../../shared/rename-with-retry.ts";
import { currentIso, isoFromMs } from "../../../shared/time.ts";

/** The sections every `state.md` carries, in this order; "None." is content. */
export const STATE_SECTIONS = [
  "Focus",
  "Waiting on the person",
  "Owed",
  "Running",
  "Cautions",
  "Next act",
  "Links",
] as const;

/** Past this many lines `state.md` is still written, with a warning. */
export const STATE_LINE_CEILING = 150;

const USAGE = [
  "usage: bun notebook.ts open <topic>",
  "       bun notebook.ts state <topic> < state.md",
  "       bun notebook.ts journal <topic> < entry.md",
  "       bun notebook.ts list",
].join("\n");

type Env = Record<string, string | undefined>;

/** A refusal's code names the exit it ends in. */
type RefusalCode = "unreadable" | "usage" | "refused" | "in-work-tree";
const EXIT: Record<RefusalCode, number> = {
  unreadable: 1,
  usage: 2,
  refused: 3,
  "in-work-tree": 4,
};

class Refusal extends JigError<RefusalCode> {
  override name = "Refusal";
}

/** The longest slug a folder is named with. */
const SLUG_LIMIT = 64;

/**
 * A topic as its folder is named: lowercase letters and digits joined by
 * single hyphens, so "Dispatch reliability" and `dispatch-reliability` are
 * one topic. A name longer than the limit keeps its start and ends in a
 * digest of the whole name, so two long topics never share a folder.
 * Undefined when nothing nameable is left.
 */
export function topicSlug(topic: string): string | undefined {
  const slug = topic
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return undefined;
  if (slug.length <= SLUG_LIMIT) return slug;
  const digest = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return `${slug.slice(0, SLUG_LIMIT - 9).replace(/-+$/, "")}-${digest}`;
}

/** The folder holding every topic's notebook. */
export function notebooksRoot(env: Env = process.env): string {
  return join(jigHome(env), "orchestrate");
}

/**
 * The working tree `path` lies in, or undefined: the nearest folder at or
 * above it holding a `.git` entry (a folder, or the file a linked worktree
 * keeps). The deepest part of `path` that exists is resolved first, so a
 * symbolic link into a checkout counts as inside it. A `.git` entry that
 * cannot be checked throws rather than reading as absent. A working tree
 * `env.GIT_WORK_TREE` designates counts too; one a Git configuration
 * (`core.worktree`) designates from a separate Git directory leaves no mark
 * inside it and cannot be found from here.
 */
export function enclosingWorkTree(
  path: string,
  env: Env = process.env,
): string | undefined {
  let existing = path;
  while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let current = realpathSync(existing);
  if (!statSync(current).isDirectory()) current = dirname(current);
  const designated = env.GIT_WORK_TREE;
  if (designated !== undefined && designated !== "") {
    const tree = realpathSync(resolve(designated));
    const below = relative(tree, current);
    const outside =
      isAbsolute(below) ||
      below === ".." ||
      below.startsWith(`..${sep}`) ||
      below.startsWith("../");
    if (!outside) return tree;
  }
  for (;;) {
    if (
      lstatSync(join(current, ".git"), { throwIfNoEntry: false }) !== undefined
    )
      return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The sections of `STATE_SECTIONS` a state text lacks. */
export function missingSections(text: string): string[] {
  const headings = new Set<string>();
  let fence: { char: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (fence !== undefined) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close?.[0] === fence.char && close.length >= fence.length)
        fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (
      open?.[1] !== undefined &&
      !(open[1][0] === "`" && open[2]?.includes("`"))
    ) {
      fence = { char: open[1][0] ?? "`", length: open[1].length };
      continue;
    }
    const heading = /^ {0,3}## +(.+?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) headings.add(heading.toLowerCase());
  }
  return STATE_SECTIONS.filter((name) => !headings.has(name.toLowerCase()));
}

/** The prompt that resumes a topic, for each agent tool that runs skills. */
export function resumePrompts(slug: string): Record<string, string> {
  return {
    "Claude Code": `/jig:orchestrate ${slug}`,
    Codex: `Use the jig:orchestrate skill: ${slug}`,
  };
}

/** Refuse a destination that resolves into a Git working tree. */
function guardDestination(path: string, env: Env): void {
  const tree = io("could not check for a Git working tree", () =>
    enclosingWorkTree(path, env),
  );
  if (tree !== undefined)
    throw new Refusal(
      "in-work-tree",
      `${path} lies inside the Git working tree ${tree}; a notebook is never written there. Move JIG_HOME outside every repository.`,
    );
}

function folderOf(topic: string, env: Env): { slug: string; folder: string } {
  const slug = topicSlug(topic);
  if (slug === undefined)
    throw new Refusal(
      "usage",
      `a topic needs a letter or digit (got ${JSON.stringify(topic)})`,
    );
  const folder = join(notebooksRoot(env), slug);
  guardDestination(folder, env);
  guardDestination(join(folder, "journal"), env);
  return { slug, folder };
}

function io<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Refusal(
      "unreadable",
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function journalDays(folder: string): string[] {
  const journal = join(folder, "journal");
  if (!existsSync(journal)) return [];
  return readdirSync(journal)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => name.slice(0, -".md".length))
    .sort();
}

/** `open`: create a new topic's folder and print what a session resumes from. */
export function open(topic: string, env: Env = process.env): string {
  const { slug, folder } = folderOf(topic, env);
  const statePath = join(folder, "state.md");
  const created = !existsSync(folder);
  io("could not create the notebook", () =>
    mkdirSync(join(folder, "journal"), { recursive: true }),
  );
  const days = journalDays(folder);
  const lines = [
    `topic: ${slug}`,
    `notebook: ${folder}${created ? " (new topic: created)" : ""}`,
  ];
  for (const [agent, prompt] of Object.entries(resumePrompts(slug)))
    lines.push(`resume (${agent}): ${prompt}`);
  lines.push(
    `journal: ${join(folder, "journal")} (${days.length === 0 ? "no entries" : `${days.length} day(s), ${days[0]} to ${days.at(-1)}`}; read only when a question needs the history)`,
  );
  if (!existsSync(statePath)) {
    lines.push(`state: ${statePath} (none yet: write it at the first pause)`);
    return `${lines.join("\n")}\n`;
  }
  const text = io("could not read state.md", () =>
    readFileSync(statePath, "utf8"),
  );
  const written = io(
    "could not read state.md",
    () => statSync(statePath).mtimeMs,
  );
  lines.push(
    `state: ${statePath} (written ${isoFromMs(written)})`,
    "",
    text.trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

/** `state`: replace `state.md` whole, atomically. Returns any warning. */
export function writeState(
  topic: string,
  text: string,
  env: Env = process.env,
): string | undefined {
  const { folder } = folderOf(topic, env);
  if (text.trim() === "")
    throw new Refusal("refused", "the state is empty; nothing written");
  const missing = missingSections(text);
  if (missing.length > 0)
    throw new Refusal(
      "refused",
      `the state lacks the section(s) ${missing.map((m) => `"## ${m}"`).join(", ")}; nothing written. Write "None." under a section with nothing in it.`,
    );
  const statePath = join(folder, "state.md");
  guardDestination(statePath, env);
  const body = text.endsWith("\n") ? text : `${text}\n`;
  io("could not write state.md", () => {
    mkdirSync(join(folder, "journal"), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, body);
    renameWithRetry(temporary, statePath);
  });
  const lineCount = body.split("\n").length - 1;
  return lineCount > STATE_LINE_CEILING
    ? `state.md has ${lineCount} lines, over ${STATE_LINE_CEILING}: move history to the journal and keep only what is current`
    : undefined;
}

/** `journal`: append one dated entry to today's file (UTC). Returns its path. */
export function appendJournal(
  topic: string,
  text: string,
  env: Env = process.env,
): string {
  const { folder } = folderOf(topic, env);
  if (text.trim() === "")
    throw new Refusal("refused", "the entry is empty; nothing written");
  const now = currentIso();
  const path = join(folder, "journal", `${now.slice(0, 10)}.md`);
  guardDestination(path, env);
  io("could not append to the journal", () => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `## ${now}\n\n${text.trim()}\n\n`);
  });
  return path;
}

/** `list`: each topic with the time its state was last written. */
export function list(env: Env = process.env): string {
  const root = notebooksRoot(env);
  guardDestination(root, env);
  if (!existsSync(root)) return "";
  const topics = io("could not list the notebooks", () =>
    readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()),
  );
  return topics
    .map((entry) => {
      const statePath = join(root, entry.name, "state.md");
      const stat = io("could not read a topic's state", () =>
        statSync(statePath, { throwIfNoEntry: false }),
      );
      const written =
        stat === undefined ? "no state yet" : isoFromMs(stat.mtimeMs);
      return `${entry.name}\t${written}\n`;
    })
    .sort()
    .join("");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const topic = rest.join(" ");
  try {
    switch (command) {
      case "open":
        if (topic === "") break;
        process.stdout.write(open(topic));
        return 0;
      case "state": {
        if (topic === "") break;
        const warning = writeState(topic, await Bun.stdin.text());
        if (warning !== undefined) console.error(`notebook: ${warning}`);
        console.log(
          `state.md rewritten: ${join(notebooksRoot(), topicSlug(topic) ?? "", "state.md")}`,
        );
        return 0;
      }
      case "journal":
        if (topic === "") break;
        console.log(
          `journal appended: ${appendJournal(topic, await Bun.stdin.text())}`,
        );
        return 0;
      case "list":
        if (rest.length > 0) break;
        process.stdout.write(list());
        return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`notebook: ${error.message}`);
    return EXIT[error.code];
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
