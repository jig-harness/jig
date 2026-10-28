/**
 * A review's plan: the document, its kind, the personas that read it and
 * where each one's brief and findings live. `plan` writes it into the
 * review's folder; every later step reads it from there.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { renderBrief } from "./brief.ts";
import {
  type Detected,
  detectKind,
  type Kind,
  KINDS,
  sha256,
  slugFor,
  titleOf,
} from "./document.ts";
import { type Persona, loadPersonas, personasFor } from "./personas.ts";

export const PLAN_FILE = "plan.json";
export const REPORT_FILE = "report.md";

export interface PlannedPersona {
  id: string;
  name: string;
  /** The brief the persona follows. */
  brief: string;
  /** Where the persona writes its findings when it can write files. */
  output: string;
  /** Where its printed reply is kept when it cannot. */
  reply: string;
  /** The checked findings, written by `collect`. */
  findings: string;
  /** The problems found in a rejected attempt, kept by `fresh` for the next one. */
  feedback: string;
}

export interface Plan {
  document: string;
  display: string;
  title: string;
  kind: Kind;
  kindFrom: string;
  companion?: string;
  companionSha256?: string;
  sha256: string;
  date: string;
  directory: string;
  report: string;
  personas: PlannedPersona[];
}

export interface PlanOptions {
  root: string;
  document: string;
  kind?: Kind | undefined;
  companion?: string | undefined;
  out?: string | undefined;
  date: string;
}

/** A step that cannot go on; `code` is the exit code it ends with. */
export class PlanError extends Error {
  readonly code: 1 | 2;
  constructor(message: string, code: 1 | 2 = 2) {
    super(message);
    this.code = code;
  }
}

function files(directory: string, id: string) {
  return {
    brief: join(directory, `${id}.brief.md`),
    output: join(directory, `${id}.json`),
    reply: join(directory, `${id}.reply.md`),
    findings: join(directory, `${id}.findings.json`),
    feedback: join(directory, `${id}.feedback.md`),
  };
}

/** Every file a review keeps in its folder, for the personas given. */
function reserved(directory: string, all: Persona[]): string[] {
  return [
    join(directory, PLAN_FILE),
    join(directory, REPORT_FILE),
    ...all.flatMap((persona) => Object.values(files(directory, persona.id))),
  ];
}

/** Remove what an earlier review of the same document left in the folder. */
function clear(directory: string, all: Persona[]): void {
  for (const file of reserved(directory, all)) rmSync(file, { force: true });
}

/**
 * Every name an input goes by: the entry it is named by, with its folder's
 * links resolved (a symlink in the review's folder is replaced by the
 * review's own file), and the file that entry resolves to. A part that does
 * not exist is left out.
 */
function aliasesOf(input: string): string[] {
  const path = resolve(input);
  const aliases = [path];
  try {
    aliases.push(join(realpathSync(dirname(path)), basename(path)));
    aliases.push(realpathSync(path));
  } catch {
    // The rest of the input's names cannot be resolved; reading it fails later.
  }
  return aliases;
}

/**
 * Write a file the review keeps by replacing its entry in the folder, so a
 * link left at that name, symbolic or hard, is replaced rather than written
 * through: no write reaches a file outside the review.
 */
export function writeKept(path: string, text: string): void {
  const staged = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(staged, text, { flag: "wx" });
  try {
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

/** Refuse a folder that holds an input, or another review's files. */
function guardFolder(
  directory: string,
  inputs: string[],
  document: string,
  all: Persona[],
): void {
  const names = new Set(reserved(directory, all).map((file) => basename(file)));
  const real = realpathSync(directory);
  for (const input of inputs) {
    for (const actual of aliasesOf(input))
      if (dirname(actual) === real && names.has(basename(actual)))
        throw new PlanError(
          `${input} would be overwritten: it has the name of a file the review keeps in ${directory}; pass another folder to --out`,
        );
  }
  if (readdirSync(directory).length === 0) return;
  let previous: Plan | undefined;
  try {
    previous = readPlan(directory);
  } catch {
    previous = undefined;
  }
  if (!previous || previous.document !== document)
    throw new PlanError(
      `${directory} holds files that are not an earlier review of this document; pass an empty or new folder to --out`,
    );
}

function readDocument(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new PlanError(`cannot read the document: ${path}`);
  }
}

function kindFor(text: string, kind: Kind | undefined): Detected {
  if (kind) return { kind, from: "--kind" };
  const detected = detectKind(text);
  if (!detected)
    throw new PlanError(
      "cannot tell whether this is a requirements or an architecture document: it has no frontmatter type: naming one and too few of M6's template headings; pass --kind requirements or --kind architecture",
    );
  return detected;
}

/** Make the plan and the briefs, replacing any earlier review's files. */
export function makePlan(options: PlanOptions): Plan {
  const document = resolve(options.document);
  const text = readDocument(document);
  const { kind, from } = kindFor(text, options.kind);
  const companion = options.companion ? resolve(options.companion) : undefined;
  const companionText = companion ? readDocument(companion) : undefined;
  const display = relative(options.root, document) || document;
  const directory = resolve(
    options.out ??
      join(
        options.root,
        ".context",
        "red-team",
        slugFor(document, options.root),
      ),
  );
  const all = loadPersonas();
  mkdirSync(directory, { recursive: true });
  guardFolder(
    directory,
    companion ? [document, companion] : [document],
    document,
    all,
  );
  clear(directory, all);
  const plan: Plan = {
    document,
    display,
    title: titleOf(text, display),
    kind,
    kindFrom: from,
    ...(companion && companionText !== undefined
      ? { companion, companionSha256: sha256(companionText) }
      : {}),
    sha256: sha256(text),
    date: options.date,
    directory,
    report: join(directory, REPORT_FILE),
    personas: personasFor(kind, all).map((persona) => ({
      id: persona.id,
      name: persona.name,
      ...files(directory, persona.id),
    })),
  };
  for (const persona of personasFor(kind, all)) {
    const planned = plan.personas.find((p) => p.id === persona.id);
    if (planned) writeKept(planned.brief, renderBrief(plan, persona, planned));
  }
  writeKept(join(directory, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export function readPlan(directory: string): Plan {
  const path = join(resolve(directory), PLAN_FILE);
  if (!existsSync(path))
    throw new PlanError(
      `no ${PLAN_FILE} in ${directory}: run the plan step first`,
    );
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlan(value) || !boundToFolder(value, directory))
    throw new PlanError(`${path} is not a plan this script wrote`);
  return value;
}

/**
 * Every path the steps write or remove is the one the plan step derives from
 * the folder and the persona, and no input goes by any of their names; a plan
 * edited to point a path at the document, or to name the document by one of
 * the review's own files, is not accepted.
 */
function boundToFolder(plan: Plan, directory: string): boolean {
  if (
    !existsSync(plan.directory) ||
    realpathSync(plan.directory) !== realpathSync(directory)
  )
    return false;
  if (plan.report !== join(plan.directory, REPORT_FILE)) return false;
  const real = realpathSync(plan.directory);
  const owned = new Set<string>([join(real, REPORT_FILE)]);
  for (const persona of plan.personas) {
    const expected = files(plan.directory, persona.id);
    for (const [key, path] of Object.entries(expected)) {
      if ((persona as unknown as Record<string, unknown>)[key] !== path)
        return false;
      owned.add(join(real, basename(path)));
    }
  }
  return ![plan.document, plan.companion].some(
    (input) =>
      input !== undefined && aliasesOf(input).some((alias) => owned.has(alias)),
  );
}

function isPlan(value: unknown): value is Plan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  const strings = ["document", "display", "title", "kind", "kindFrom"];
  const kind = plan.kind;
  if (!(KINDS as readonly unknown[]).includes(kind)) return false;
  if (
    plan.companion !== undefined &&
    (typeof plan.companion !== "string" ||
      typeof plan.companionSha256 !== "string")
  )
    return false;
  return (
    strings.every((key) => typeof plan[key] === "string") &&
    ["sha256", "date", "directory", "report"].every(
      (key) => typeof plan[key] === "string",
    ) &&
    Array.isArray(plan.personas) &&
    plan.personas.every(
      (p: unknown) =>
        typeof p === "object" &&
        p !== null &&
        [
          "id",
          "name",
          "brief",
          "output",
          "reply",
          "findings",
          "feedback",
        ].every(
          (key) => typeof (p as Record<string, unknown>)[key] === "string",
        ),
    ) &&
    hasThePersonas(plan.personas as PlannedPersona[], kind as Kind)
  );
}

/** The plan names exactly the personas that read its kind, each once. */
function hasThePersonas(planned: PlannedPersona[], kind: Kind): boolean {
  const expected = personasFor(kind).map((persona) => persona.id);
  const ids = planned.map((persona) => persona.id);
  return (
    ids.length === expected.length &&
    new Set(ids).size === ids.length &&
    expected.every((id) => ids.includes(id))
  );
}

/** The document as it is now, refused when it or its companion changed since the plan. */
export function unchangedDocument(plan: Plan): string {
  const text = readDocument(plan.document);
  if (sha256(text) !== plan.sha256)
    throw new PlanError(
      `the document changed since the plan (${plan.display}): the personas' quotations may no longer hold; run the plan step again and repeat the review`,
      1,
    );
  if (
    plan.companion &&
    sha256(readDocument(plan.companion)) !== plan.companionSha256
  )
    throw new PlanError(
      `the companion changed since the plan (${plan.companion}): the personas read different requirements; run the plan step again and repeat the review`,
      1,
    );
  return text;
}

/**
 * The prompt that starts a persona: a pointer to its brief, and, when an
 * earlier attempt was rejected, to the problems found in it.
 */
export function promptFor(persona: PlannedPersona): string {
  const start = `Read the red-team brief at ${persona.brief} and follow it exactly.`;
  return existsSync(persona.feedback)
    ? `${start} An earlier attempt was rejected: read ${persona.feedback} for its problems and correct them.`
    : start;
}
