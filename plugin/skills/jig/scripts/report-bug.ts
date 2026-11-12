#!/usr/bin/env bun
/**
 * Report a bug in Jig on Jig's issue tracker, in the fields of its bug form
 * (`.github/ISSUE_TEMPLATE/bug.yml` in Jig's repository): look for an issue
 * that already describes it, draft the report from the facts a script can
 * read and the account the agent gives, and file the draft once a person
 * has confirmed it.
 *
 * Usage:
 *   bun report-bug.ts search <words>
 *     Jig's issues, open and closed, that match the words.
 *   bun report-bug.ts draft --skill <name> --symptom <one line> --what <file>
 *                           --expected <text> --channel <channel>
 *                           [--last-working <version>] [--tool <tool>]
 *                           [--out <draft file>]
 *     --skill        the skill, command or hook that misbehaved (`drive-pr`,
 *                    `gc`); the title starts with it
 *     --symptom      what went wrong, in one line; the rest of the title
 *     --what         a file holding what happened: the command, its exit
 *                    code, its output
 *     --expected     what should have happened
 *     --channel      where the plugin was installed from: stable, latest,
 *                    tag (a pinned tag), main, or local (a local checkout)
 *     --last-working the last version it worked in, when it ever did
 *     --tool         the agent tool and its version; read from `claude
 *                    --version` inside Claude Code when left out
 *     --out          write the draft there and print it for a person to
 *                    read; without it the draft is printed as JSON:
 *                    { repository, title, labels, body, url, urlComplete,
 *                    urlOmitted, replaced }
 *   bun report-bug.ts file <draft file>
 *     File the draft on Jig's tracker and print the new issue's address.
 *     The issue is created with the issue type Bug, as the bug form gives
 *     it, and with no type, priority or size label: Jig's repository keeps
 *     those in fields, so a draft's such labels are dropped, which is said
 *     on stderr. An account GitHub does not let set issue types (or a `gh`
 *     too old to set one) files the issue without the type, which is said
 *     on stderr and is no failure: the type, the priority and the size are
 *     set when the issue is triaged.
 *
 * The plugin version is read from this copy's manifest, the operating system
 * from the machine. Before anything is printed, every text the agent gave has
 * the repository's own names replaced with placeholders: its absolute path,
 * the home directory, the owner and name its remote's address carries, and
 * keys of the issue-tracker team its configuration names. A report goes to a
 * public tracker, so it carries no name of the repository it came from.
 * `replaced` (stderr with `--out`) lists what was replaced. `url` is the bug
 * form with the fields filled in, for a machine without a working `gh`.
 *
 * When `gh` fails to file, the script searches for an issue of the same title
 * before offering the form, built from the title and body in the draft file as
 * they are now. Exit codes: 0 done; 1 `gh` could not search or file (the message
 * gives the address to do it by hand); 2 usage, or a file cannot be read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, failFrom, runMain } from "../../../shared/cli.ts";
import { isMapping } from "../../../shared/config-layers.ts";
import {
  consumerRoot,
  readConfig,
  readRemoteName,
} from "../../../shared/consumer.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../../shared/guarded-git-spawn.ts";
import { swallow } from "../../../shared/errors.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";

/** Jig's own repository, where its issues are filed. */
export const JIG_REPOSITORY = "jig-harness/jig";

/** The repository label (`review.repo_label`) the bug form applies. */
export const REPO_LABEL = "jig";

/** The issue type the bug form applies. */
export const BUG_TYPE = "Bug";

/**
 * The labels of the type, priority and size facets, which Jig's repository
 * keeps in the issue type and the Priority and Effort fields: the default
 * label of every value of each facet, and the taxonomy's types. An open issue
 * there carries none of them. Matched ignoring case.
 */
const FACET_LABEL =
  /^(?:bug|feature|improvement|task|spike|docs|chore|infra|type:.*|priority:.*|xs|small|medium|large|xl)$/i;

/** The answers of the bug form's channel field, by the short name `--channel` takes. */
export const CHANNELS: Record<string, string> = {
  stable: "stable",
  latest: "latest",
  tag: "a pinned tag",
  main: "main",
  local: "a local checkout",
};

/** What GitHub writes under a heading a form left empty. */
const NO_RESPONSE = "_No response_";

/** How long one `gh` call may take before it is stopped. */
const GH_TIMEOUT_MS = 60_000;

/** Prefilled issue addresses longer than this are cut short by browsers and GitHub. */
const URL_LIMIT = 8000;

const usage = [
  "Usage: report-bug.ts search <words>",
  "       report-bug.ts draft --skill <name> --symptom <one line> --what <file> --expected <text> --channel stable|latest|tag|main|local [--last-working <version>] [--tool <tool>] [--out <draft file>]",
  "       report-bug.ts file <draft file>",
].join("\n");

export interface Answers {
  skill: string;
  symptom: string;
  what: string;
  expected: string;
  channel: string;
  lastWorking?: string | undefined;
  tool?: string | undefined;
}

/** One placeholder and the text it stands for. */
export interface Replacement {
  pattern: RegExp;
  placeholder: string;
  what: string;
}

export interface Draft {
  repository: string;
  title: string;
  labels: string[];
  body: string;
  url: string;
  /** Whether `url` carries every field; when it is too long, the person pastes the omitted ones into the form. */
  urlComplete: boolean;
  /** The fields `url` leaves out because the address would be too long. */
  urlOmitted: string[];
  /** What the placeholders replaced, as `<placeholder>: what`, once each. */
  replaced: string[];
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word, case-insensitive pattern for `word`. */
function word(text: string): RegExp {
  return new RegExp(`(?<![\\w-])${literal(text)}(?![\\w-])`, "gi");
}

/**
 * The owner and name a git remote address carries (`git@host:o/n.git`,
 * `https://host/o/n`, `/srv/o/n.git`, `file:///srv/o/n.git`, `o/n.git`). The owner is the whole namespace, so a
 * nested address (`git@host:org/team/n.git`) keeps `org/team`; for a
 * filesystem path it is the directory holding the repository.
 */
export function remoteOwnerName(
  address: string,
): { owner: string; name: string } | null {
  const trimmed = address.trim();
  const local =
    /^file:\/\/[^/\s]*\/(.+)$/i.exec(trimmed)?.[1] ??
    /^(?:\.{1,2})?\/(.+)$/.exec(trimmed)?.[1] ??
    (/^[^:\s]+\/[^:\s]+$/.test(trimmed) ? trimmed : undefined);
  const path =
    /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*\/(.+)$/i.exec(trimmed)?.[1] ??
    /^[^/\s]*:(.+)$/.exec(trimmed)?.[1] ??
    local;
  const parts = path
    ?.replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..");
  const name = parts?.pop();
  if (!parts || parts.length === 0 || !name) return null;
  return {
    owner: local && path === local ? (parts.at(-1) ?? "") : parts.join("/"),
    name,
  };
}

/**
 * The placeholders for one repository, in the order they apply: the paths
 * before the names a path may contain, `owner/name` before either alone. Jig's own repository keeps its names:
 * a report from there has nothing of another's to hide.
 */
export function replacementsFor(facts: {
  root: string;
  home: string;
  remoteAddress?: string | undefined;
  trackerTeam?: string | undefined;
}): Replacement[] {
  const out: Replacement[] = [
    {
      pattern: new RegExp(literal(facts.root), "g"),
      placeholder: "<repository>",
      what: "the repository's path",
    },
  ];
  if (facts.home.length > 1 && facts.home !== facts.root)
    out.push({
      pattern: new RegExp(literal(facts.home), "g"),
      placeholder: "~",
      what: "the home directory",
    });
  const remote = facts.remoteAddress && remoteOwnerName(facts.remoteAddress);
  if (remote && `${remote.owner}/${remote.name}` !== JIG_REPOSITORY) {
    out.push(
      {
        pattern: word(`${remote.owner}/${remote.name}`),
        placeholder: "<owner>/<repository-name>",
        what: "the remote's owner and name",
      },
      {
        pattern: word(remote.name),
        placeholder: "<repository-name>",
        what: "the remote's repository name",
      },
      {
        pattern: word(remote.owner),
        placeholder: "<owner>",
        what: "the remote's owner",
      },
    );
  }
  if (facts.trackerTeam && /^[A-Za-z][A-Za-z0-9]*$/.test(facts.trackerTeam))
    out.push({
      pattern: new RegExp(`(?<![\\w-])${facts.trackerTeam}-\\d+(?!\\w)`, "gi"),
      placeholder: "<issue>",
      what: "the tracker team's issue keys",
    });
  return out;
}

/**
 * `text` with every replacement applied, and the ones that matched. Every
 * pattern is matched against `text` itself, never against another's
 * placeholder; where matches overlap, the earlier replacement keeps its span.
 */
export function redact(
  text: string,
  replacements: readonly Replacement[],
): { text: string; matched: Set<string> } {
  const matched = new Set<string>();
  const claimed: { start: number; end: number; placeholder: string }[] = [];
  for (const r of replacements) {
    for (const m of text.matchAll(r.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) continue;
      if (claimed.some((c) => start < c.end && c.start < end)) continue;
      claimed.push({ start, end, placeholder: r.placeholder });
      matched.add(`${r.placeholder}: ${r.what}`);
    }
  }
  claimed.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const c of claimed) {
    out += text.slice(at, c.start) + c.placeholder;
    at = c.end;
  }
  return { text: out + text.slice(at), matched };
}

function answer(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : NO_RESPONSE;
}

/**
 * The issue body as GitHub writes a submitted bug form: each field's label
 * as a level-three heading, its answer below. The labels are the form's, in
 * its order.
 */
export function body(fields: {
  version: string;
  channel: string;
  lastWorking?: string | undefined;
  what: string;
  expected: string;
  tools: string;
}): string {
  const sections: [string, string][] = [
    ["Plugin version", fields.version],
    ["Where you installed it from", fields.channel],
    ["Last version it worked in", answer(fields.lastWorking)],
    ["What happened", answer(fields.what)],
    ["What you expected", answer(fields.expected)],
    ["Agent tool and operating system", answer(fields.tools)],
  ];
  return `${sections.map(([label, value]) => `### ${label}\n\n${value}`).join("\n\n")}\n`;
}

/** The form fields dropped, in this order, until the address fits. */
const OMISSION_ORDER: [string, string][] = [
  ["what", "What happened"],
  ["expected", "What you expected"],
  ["tools", "Agent tool and operating system"],
  ["last-working", "Last version it worked in"],
  ["title", "the title"],
  ["version", "Plugin version"],
  ["channel", "Where you installed it from"],
];

/**
 * The bug form's address with its fields filled in. Fields are left out in
 * `OMISSION_ORDER` until the address fits; `omitted` names each one the
 * person must paste into the form.
 */
export function formUrl(
  title: string,
  fields: Record<string, string | undefined>,
): { url: string; complete: boolean; omitted: string[] } {
  const build = (omit: string[]) => {
    const query = new URLSearchParams({ template: "bug.yml" });
    if (!omit.includes("title")) query.set("title", title);
    for (const [id, value] of Object.entries(fields))
      if (value && !omit.includes(id)) query.set(id, value);
    return `https://github.com/${JIG_REPOSITORY}/issues/new?${query.toString()}`;
  };
  const omit: string[] = [];
  const present = OMISSION_ORDER.filter(([id]) => id === "title" || fields[id]);
  for (let i = 0; ; i++) {
    const url = build(omit);
    if (url.length <= URL_LIMIT || i === present.length)
      return {
        url,
        complete: omit.length === 0,
        omitted: present
          .filter(([id]) => omit.includes(id))
          .map(([, label]) => label),
      };
    const next = present[i];
    if (next) omit.push(next[0]);
  }
}

function operatingSystem(): string {
  const names: Record<string, string> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };
  return `${names[platform()] ?? platform()} ${release()}`;
}

/** `claude --version` inside Claude Code, else nothing: other tools say so through `--tool`. */
function detectedTool(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CLAUDECODE !== "1") return undefined;
  const run = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: withoutLeakyGitEnv(env),
  });
  const version =
    run.status === 0 ? /\d+\.\d+\.\d+/.exec(run.stdout)?.[0] : undefined;
  return version ? `Claude Code ${version}` : "Claude Code";
}

function remoteAddress(root: string): string | undefined {
  const remote = readRemoteName(root);
  if (!("remote" in remote)) return undefined;
  const run = spawnSync(
    "git",
    ["-C", root, "remote", "get-url", remote.remote],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: withoutLeakyGitEnv(),
    },
  );
  return run.status === 0 ? run.stdout.trim() : undefined;
}

function trackerTeam(): string | undefined {
  let tracker: unknown;
  try {
    tracker = readConfig().issue_tracker;
  } catch (error) {
    // A configuration that does not parse may be the bug being reported.
    swallow(error, "configuration unreadable; no tracker keys to replace");
    return undefined;
  }
  const team = isMapping(tracker) ? tracker.team : undefined;
  return typeof team === "string" ? team : undefined;
}

/** The draft for `answers`, with the facts the script read. */
export function draft(
  answers: Answers,
  facts: {
    version: string;
    os: string;
    replacements: readonly Replacement[];
  },
): Draft {
  const matched = new Set<string>();
  const clean = (text: string | undefined) => {
    if (text === undefined) return undefined;
    const r = redact(text, facts.replacements);
    for (const m of r.matched) matched.add(m);
    return r.text;
  };
  const tool = clean(answers.tool);
  const fields = {
    version: facts.version,
    channel:
      (Object.hasOwn(CHANNELS, answers.channel) && CHANNELS[answers.channel]) ||
      answers.channel,
    lastWorking: clean(answers.lastWorking),
    what: clean(answers.what) ?? "",
    expected: clean(answers.expected) ?? "",
    tools: tool ? `${tool} on ${facts.os}` : facts.os,
  };
  const title = `${answers.skill}: ${clean(answers.symptom)?.trim() ?? ""}`;
  const form = formUrl(title, {
    version: fields.version,
    channel: fields.channel,
    "last-working": fields.lastWorking,
    what: fields.what,
    expected: fields.expected,
    tools: fields.tools,
  });
  return {
    repository: JIG_REPOSITORY,
    title,
    labels: [REPO_LABEL],
    body: body(fields),
    url: form.url,
    urlComplete: form.complete,
    urlOmitted: form.omitted,
    replaced: [...matched],
  };
}

/** The `gh` arguments that search Jig's issues, open and closed, for `words`. */
export function searchArgs(words: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    JIG_REPOSITORY,
    "--state",
    "all",
    "--search",
    words,
    "--limit",
    "20",
    "--json",
    "number,title,state,url",
  ];
}

/** `labels` split into those Jig's repository keeps and its facet labels, which it does not. */
export function splitFacetLabels(labels: string[]): {
  kept: string[];
  dropped: string[];
} {
  const dropped = labels.filter((label) => FACET_LABEL.test(label.trim()));
  return { kept: labels.filter((label) => !dropped.includes(label)), dropped };
}

/**
 * The `gh` arguments that file `d`, its body read from stdin: its labels but
 * for the facet ones, and the issue type Bug unless `withType` is false.
 */
export function fileArgs(
  d: Pick<Draft, "title" | "labels">,
  withType = true,
): string[] {
  return [
    "issue",
    "create",
    "--repo",
    JIG_REPOSITORY,
    "--title",
    d.title,
    ...splitFacetLabels(d.labels).kept.flatMap((label) => ["--label", label]),
    ...(withType ? ["--type", BUG_TYPE] : []),
    "--body-file",
    "-",
  ];
}

/** Jig's issues page searched for `words`, for a machine without a working `gh`. */
export function searchUrl(words: string): string {
  const query = new URLSearchParams({ q: `is:issue ${words}` });
  return `https://github.com/${JIG_REPOSITORY}/issues?${query.toString()}`;
}

function gh(args: string[], input?: string) {
  return spawnSync("gh", args, {
    timeout: GH_TIMEOUT_MS,
    env: withoutLeakyGitEnv(),
    ...(input === undefined ? {} : { input }),
  });
}

/** Whether `gh` could not be started at all, so nothing reached GitHub. */
function isMissingProgram(error: Error | undefined): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/** Whether `gh` failed before it could create anything: not started, or not logged in (exit 4). */
function precedesCreation(run: ReturnType<typeof gh>): boolean {
  return isMissingProgram(run.error) || run.status === 4;
}

function why(run: ReturnType<typeof gh>): string {
  if (run.error) return run.error.message;
  return run.stderr.trim() || `gh exited ${run.status}`;
}

function parseDraft(argv: string[]): Answers & { out?: string | undefined } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        skill: { type: "string" },
        symptom: { type: "string" },
        what: { type: "string" },
        expected: { type: "string" },
        channel: { type: "string" },
        "last-working": { type: "string" },
        tool: { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    failFrom(error, 2, usage);
  }
  const text = (name: string) => {
    const value = values[name];
    if (typeof value !== "string" || value.trim() === "")
      fail(2, `--${name} is required`, usage);
    return value;
  };
  const skill = text("skill");
  if (!/^[a-z][a-z0-9-]*$/.test(skill))
    fail(
      2,
      `--skill must be a skill or command name (lower case, digits, '-'), got ${JSON.stringify(skill)}`,
    );
  const channel = text("channel");
  if (!Object.hasOwn(CHANNELS, channel))
    fail(
      2,
      `--channel must be one of ${Object.keys(CHANNELS).join(", ")}, got ${JSON.stringify(channel)}`,
    );
  const whatFile = text("what");
  let what: string;
  try {
    what = readFileSync(whatFile, "utf8");
  } catch (error) {
    failFrom(
      error,
      2,
      `cannot read --what ${whatFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const optional = (name: string) => {
    const value = values[name];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  return {
    skill,
    symptom: text("symptom"),
    what,
    expected: text("expected"),
    channel,
    lastWorking: optional("last-working"),
    tool: optional("tool"),
    out: optional("out"),
  };
}

function runDraft(argv: string[]): number {
  const args = parseDraft(argv);
  const root = consumerRoot();
  const result = draft(
    { ...args, tool: args.tool ?? detectedTool() },
    {
      version:
        pluginVersion() ?? "unknown (no plugin manifest beside this copy)",
      os: operatingSystem(),
      replacements: replacementsFor({
        root,
        home: homedir(),
        remoteAddress: remoteAddress(root),
        trackerTeam: trackerTeam(),
      }),
    },
  );
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, json);
  else {
    process.stdout.write(json);
    return 0;
  }
  for (const r of result.replaced) process.stderr.write(`replaced ${r}\n`);
  process.stdout.write(
    [
      `Draft written to ${resolve(args.out)}`,
      "",
      `Title: ${result.title}`,
      "",
      result.body,
      "Form, filled in, for a machine without gh:",
      `  ${result.url}`,
      ...(result.urlComplete
        ? []
        : [
            `  (Too long for the address; paste into the form: ${result.urlOmitted.join(", ")}.)`,
          ]),
      "",
    ].join("\n"),
  );
  return 0;
}

function runSearch(argv: string[]): number {
  const words = argv.join(" ").trim();
  if (!words) fail(2, "search needs the words to look for", usage);
  const run = gh(searchArgs(words));
  if (run.status !== 0)
    fail(
      1,
      `could not search with gh: ${why(run)}`,
      `Search by hand: ${searchUrl(words)}`,
    );
  const parsed: unknown = JSON.parse(run.stdout);
  const issues = (Array.isArray(parsed) ? parsed : []).filter(isIssue);
  if (issues.length === 0)
    process.stdout.write(`No issue matches "${words}".\n`);
  for (const i of issues)
    process.stdout.write(
      `#${i.number} [${i.state.toLowerCase()}] ${i.title}\n  ${i.url}\n`,
    );
  return 0;
}

interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
}

function isIssue(value: unknown): value is Issue {
  return (
    isMapping(value) &&
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    typeof value.url === "string"
  );
}

/** A draft `draft --out` wrote, or null. */
function asDraft(value: unknown): Draft | null {
  if (
    !isMapping(value) ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.url !== "string" ||
    !Array.isArray(value.labels) ||
    !value.labels.every((label) => typeof label === "string")
  )
    return null;
  return {
    repository: JIG_REPOSITORY,
    title: value.title,
    labels: value.labels,
    body: value.body,
    url: value.url,
    urlComplete: value.urlComplete !== false,
    urlOmitted: [],
    replaced: [],
  };
}

/** The form fields a draft body carries, by the headings `body` writes. */
const BODY_FIELDS: [string, string][] = [
  ["version", "Plugin version"],
  ["channel", "Where you installed it from"],
  ["last-working", "Last version it worked in"],
  ["what", "What happened"],
  ["expected", "What you expected"],
  ["tools", "Agent tool and operating system"],
];

/**
 * The fields of a body written by `body`, or null when a person's edit
 * removed or reordered a heading, or when a form heading appears more than
 * once (an answer quoting one, fenced or not, makes the boundary ambiguous).
 */
function splitBody(text: string): Record<string, string> | null {
  const repeated = BODY_FIELDS.some(
    ([, label]) => text.split(`### ${label}\n`).length > 2,
  );
  if (repeated) return null;
  const heads = BODY_FIELDS.map(([, label]) => `### ${label}\n\n`);
  const starts: number[] = [];
  for (const head of heads) {
    const start = text.indexOf(head, (starts.at(-1) ?? -1) + 1);
    if (start < 0) return null;
    starts.push(start);
  }
  if (starts[0] !== 0) return null;
  const fields: Record<string, string> = {};
  for (const [i, [id]] of BODY_FIELDS.entries()) {
    const from = (starts[i] ?? 0) + (heads[i]?.length ?? 0);
    const end = starts[i + 1] ?? text.length;
    const value = text.slice(from, end).replace(/^\n+/, "").replace(/\n+$/, "");
    if (value !== NO_RESPONSE) fields[id] = value;
  }
  return fields;
}

/**
 * The bug form's address built from the title and body now in `d`, so edits a
 * person made to the draft file are what the form carries: each section of
 * the body goes in its field, and a body whose sections an edit removed goes
 * whole in "What happened". `omitted` names each field the address leaves
 * out because it would be too long, for the person to paste; `split` says
 * whether every field was filled from the body.
 */
export function fallbackUrl(d: Pick<Draft, "title" | "body">): {
  url: string;
  omitted: string[];
  split: boolean;
} {
  const fields = splitBody(d.body);
  const { url, omitted } = formUrl(d.title, fields ?? { what: d.body });
  return { url, omitted, split: fields !== null };
}

/**
 * After a failed `gh issue create`, which may have created the issue before
 * the call failed: the address of an issue of this exact title, `null` when
 * there is none, `undefined` when the search could not be made.
 */
function findFiled(title: string): string | null | undefined {
  const run = gh([
    "issue",
    "list",
    "--repo",
    JIG_REPOSITORY,
    "--state",
    "all",
    "--author",
    "@me",
    "--search",
    `${title} in:title`,
    "--limit",
    "20",
    "--json",
    "number,title,state,url",
  ]);
  if (run.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(run.stdout));
    const match = (Array.isArray(parsed) ? parsed : [])
      .filter(isIssue)
      .find((i) => i.title === title);
    return match ? match.url : null;
  } catch (error) {
    swallow(error, "search output unreadable; creation outcome unknown");
    return undefined;
  }
}

/** Report why `gh issue create` failed and what to do instead; never returns. */
function reportFilingFailure(d: Draft, run: ReturnType<typeof gh>): never {
  const reason = `could not file with gh: ${why(run)}`;
  const existing = precedesCreation(run) ? null : findFiled(d.title);
  if (existing === undefined)
    fail(
      1,
      `${reason}\nWhether the issue was created is unknown: search ${searchUrl(d.title)} before filing again.`,
    );
  if (existing)
    fail(
      1,
      `${reason}\nThe issue exists already, so do not file it again: ${existing}`,
    );
  const form = fallbackUrl(d);
  const paste =
    form.omitted.length > 0
      ? `\nThe address is too long for: ${form.omitted.join(", ")}. Paste ${form.omitted.length === 1 ? "it" : "them"} from the draft's title and body into the form.`
      : "";
  fail(
    1,
    reason,
    `Open the form instead: ${form.url}${paste}${form.split ? "" : "\nThe form's other required fields (plugin version, where you installed it from, what you expected) are not filled: copy them from the draft's body."}`,
  );
}

function runFile(argv: string[]): number {
  const [path, ...rest] = argv;
  if (!path || rest.length > 0)
    fail(2, "file takes one argument: the draft file", usage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failFrom(
      error,
      2,
      `cannot read the draft ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const d = asDraft(parsed);
  if (!d) fail(2, `${path} is not a draft this script wrote`);
  const { dropped } = splitFacetLabels(d.labels);
  if (dropped.length > 0)
    process.stderr.write(
      `dropped the label${dropped.length === 1 ? "" : "s"} ${dropped.join(", ")}: Jig's repository keeps type, priority and size in fields, which are set when the issue is triaged\n`,
    );
  let run = gh(fileArgs(d), d.body);
  if (run.status !== 0 && typeRefused(run, d.title)) {
    const reason = (why(run).split("\n")[0] ?? "").trim().slice(0, 200);
    run = gh(fileArgs(d, false), d.body);
    if (run.status === 0)
      process.stderr.write(
        `filed without the issue type ${BUG_TYPE} (${reason}); it is set when the issue is triaged\n`,
      );
  }
  if (run.status !== 0) reportFilingFailure(d, run);
  process.stdout.write(run.stdout);
  return 0;
}

/**
 * Whether `gh` failed to create the issue because of its type (an account
 * that may not set one, a `gh` that has no `--type`), so that filing again
 * without the type is safe: it names the type, and no issue of this title
 * exists, since a failure after the issue was created must not file it twice.
 */
function typeRefused(run: ReturnType<typeof gh>, title: string): boolean {
  if (precedesCreation(run) || !/\btype\b/i.test(why(run))) return false;
  return findFiled(title) === null;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "draft") return runDraft(rest);
  if (command === "search") return runSearch(rest);
  if (command === "file") return runFile(rest);
  fail(2, usage);
}

if (import.meta.main) runMain("report-bug", main);
