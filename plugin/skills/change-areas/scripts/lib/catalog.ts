/**
 * The change-area catalog's schema and loader (module M3): the one file that
 * maps a repository's paths to named change-areas, and each area to what a
 * change there owes (checks, reviews, labels, post-deploy actions).
 *
 * Validation is hand-written, field by field, so a problem names the area
 * and the field at fault and every problem of a catalog is reported at once,
 * in a stable order. A field the schema does not know is an error, which
 * catches a misspelt field before it silently means nothing; a composer (a
 * repository's own wrapper around these scripts) declares the extra fields
 * it reads through `FieldExtensions`.
 *
 * The open string fields (`category`, `deployTier`, `agent`, tracker flags,
 * post-deploy envs, validation profile names) take any non-empty text unless
 * the catalog closes them under `vocabularies:`; the values are the
 * repository's, never the mechanism's.
 */
import { readFileSync } from "node:fs";
import { Defect } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { load as loadYaml } from "../../../../shared/yaml.ts";
import { globProblem } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";

/** Kebab-case area ids and `impliedBy` references. */
export const AREA_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A profile name starts with a letter: a name made of digits only would be
// reordered by the JavaScript object holding it, and declared order is what
// says which profile is deepest.
const PROFILE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * A concrete repository-relative file path, not a glob: no leading `/`, no
 * empty, `.` or `..` segment, no trailing `/`, and letters, digits and
 * `_ . / -` only. A generated output is matched as a literal file name, and
 * a name with glob or shell characters in it would match the wrong files.
 */
export const OUTPUT_PATH_RE =
  /^(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/;

/** The vocabularies a catalog may close, each naming the field it governs. */
export const VOCABULARY_KEYS = [
  "category",
  "deployTier",
  "agent",
  "flags",
  "envs",
  "profile",
] as const;
export type VocabularyKey = (typeof VOCABULARY_KEYS)[number];
export type Vocabularies = Partial<Record<VocabularyKey, string[]>>;

/** One validation profile: the checks a change at this depth owes. */
export interface Profile {
  /** Run before commit, in order. */
  localChecks: string[];
  /** Run to verify the committed tree: before a push, in CI, after a fix. */
  verificationChecks: string[];
  notes?: string;
}

/** One generator: the derived files an area owns, in M2's inventory format. */
export interface GeneratedEntry {
  /** Literal repository-relative paths the generator writes. */
  outputs: string[];
  /** Paths or globs whose change calls for a regeneration; each seeds the area. */
  source: string[];
  /** Regenerates the outputs. */
  command: string;
  /** Exits non-zero when the outputs are stale. */
  check: string;
  notes?: string;
}

export interface PostDeployAction {
  action: string;
  when: string;
  envs: string[];
  notes?: string;
}

export interface TrackerBlock {
  /** Tracker labels a change in the area carries. */
  labels?: string[];
  /** Flag labels a change in the area carries. */
  flags?: string[];
}

export interface ValidationBlock {
  /** A declared profile; absent means the deepest. */
  profile?: string;
  /** The area's own test command, run locally and in verification. */
  ownTests?: string;
  notes?: string;
  [field: string]: unknown;
}

export interface Area {
  title: string;
  /** A grouping tag, never a build or deploy lane. */
  category: string;
  /** The globs that define membership. */
  paths: string[];
  /** Owning workspace directories; empty for a path-only area. */
  workspace: string[];
  /** Areas whose change also implies this one, read in that direction only. */
  impliedBy: string[];
  deployTier: string;
  notes?: string;
  validation?: ValidationBlock;
  generated?: GeneratedEntry[];
  review?: { skills: string[]; notes?: string };
  postDeploy?: PostDeployAction[];
  tracker?: TrackerBlock;
  /** The older spelling of `tracker`. */
  linear?: TrackerBlock;
  /** The owning agent. */
  agent?: string;
  /** The area's own labels. */
  labels?: string[];
  [field: string]: unknown;
}

export interface Catalog {
  areas: Record<string, Area>;
  vocabularies?: Vocabularies;
  /** Shallowest first; the last is the deepest and the fail-closed default. */
  profiles?: Record<string, Profile>;
}

/**
 * The type of a field a composer adds: a boolean, text, a list of text, or
 * one of a closed set of values.
 */
export type FieldType = "boolean" | "string" | "string[]" | readonly string[];

/** Extra fields a composer accepts on areas and on their `validation` block. */
export interface FieldExtensions {
  area?: Record<string, FieldType>;
  validation?: Record<string, FieldType>;
}

/** A catalog that failed validation; `problems` lists every reason. */
export class CatalogError extends Error {
  readonly problems: string[];
  constructor(where: string, problems: string[]) {
    super(
      `${where} is not a valid change-area catalog:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "CatalogError";
    this.problems = problems;
  }
}

/**
 * Read and parse a catalog file. Throws when it cannot be read or parsed, or
 * repeats a key: the parser rejects a repeated area, where one keeping the
 * last copy would silently drop the first.
 */
export function readCatalogFile(path: string): unknown {
  return loadYaml(readFileSync(path, "utf8"));
}

/** Read, parse and validate a catalog file. Throws `CatalogError` when invalid. */
export function loadCatalog(path: string, fields?: FieldExtensions): Catalog {
  return validateCatalog(readCatalogFile(path), fields, path);
}

/** A parsed catalog, validated. Throws `CatalogError` when invalid. */
export function validateCatalog(
  doc: unknown,
  fields?: FieldExtensions,
  where = "the catalog",
): Catalog {
  const problems = catalogProblems(doc, fields);
  if (problems.length > 0) throw new CatalogError(where, problems);
  return doc as Catalog;
}

/** Declared profiles, shallowest first: `profiles`, else `vocabularies.profile`. */
export function profileOrder(catalog: Catalog): string[] {
  if (catalog.profiles) return Object.keys(catalog.profiles);
  return catalog.vocabularies?.profile ?? [];
}

/** The deepest declared profile, or `undefined` when none is declared. */
export function deepestProfile(catalog: Catalog): string | undefined {
  return profileOrder(catalog).at(-1);
}

/** The profile an area runs at: its own, else the deepest declared. */
export function profileOf(area: Area, catalog: Catalog): string | undefined {
  return area.validation?.profile ?? deepestProfile(catalog);
}

/** The area's tracker block in either spelling. */
export function trackerOf(area: Area): TrackerBlock | undefined {
  return area.tracker ?? area.linear;
}

// ── validation ─────────────────────────────────────────────────────────────

/** The problems of one field's value; `field` is its dotted name. */
type Check = (value: unknown, field: string) => string[];
type Spec = Record<string, { required?: boolean; check: Check }>;

const show = (value: unknown) => JSON.stringify(value) ?? String(value);
const isText = (v: unknown): v is string => typeof v === "string";
const isFilled = (v: unknown): v is string => isText(v) && v.trim() !== "";
const isTextList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isFilled);
const when = (ok: boolean, problem: string) => (ok ? [] : [problem]);

const anything: Check = () => [];
const text: Check = (v, f) => when(isText(v), `\`${f}\` is not text`);
const filled: Check = (v, f) =>
  when(isFilled(v), `\`${f}\` must be non-empty text`);
const textList: Check = (v, f) =>
  when(isTextList(v), `\`${f}\` must be a list of non-empty text`);
const commands: Check = (v, f) =>
  when(isTextList(v), `\`${f}\` must be a list of commands`);

/** A value of an open field, or of the vocabulary that closes it. */
const word =
  (allowed: string[] | undefined): Check =>
  (v, f) =>
    allowed
      ? when(
          isText(v) && allowed.includes(v),
          `${f} \`${show(v)}\` is not one of ${allowed.join(", ")}`,
        )
      : when(isFilled(v), `${f} \`${show(v)}\` is not text`);

/** A list each of whose values passes `word(allowed)`. */
const words =
  (allowed: string[] | undefined, atLeastOne: boolean): Check =>
  (v, f) => {
    if (!Array.isArray(v)) return [`\`${f}\` must be a list`];
    if (atLeastOne && v.length === 0)
      return [`\`${f}\` must list at least one value`];
    return v.flatMap((x) => word(allowed)(x, f)).slice(0, 1);
  };

const globs: Check = (v, f) => {
  if (!isTextList(v) || v.length === 0)
    return [`\`${f}\` must list at least one glob`];
  return v.flatMap((glob, i) => {
    const problem = globProblem(glob);
    return problem === null ? [] : [`${f}[${i}]: ${problem}`];
  });
};

const extension = (type: FieldType): Check => {
  if (type === "boolean")
    return (v, f) =>
      when(typeof v === "boolean", `\`${f}\` must be true or false`);
  if (type === "string") return text;
  if (type === "string[]") return textList;
  return word([...type]);
};

/** The problems of a mapping's own fields; `where` prefixes nested names. */
function fieldsProblems(
  value: Record<string, unknown>,
  spec: Spec,
  where = "",
): string[] {
  const problems = Object.keys(value)
    .filter((key) => !Object.hasOwn(spec, key))
    .map((key) => `unknown field \`${where}${key}\``);
  for (const [key, { required, check }] of Object.entries(spec)) {
    if (Object.hasOwn(value, key))
      problems.push(...check(value[key], `${where}${key}`));
    else if (required) problems.push(`\`${where}${key}\` is missing`);
  }
  return problems;
}

const mapping =
  (spec: Spec): Check =>
  (v, f) =>
    isRecord(v)
      ? fieldsProblems(v, spec, `${f}.`)
      : [`\`${f}\` is not a mapping`];

const listOf =
  (spec: Spec): Check =>
  (v, f) => {
    if (!Array.isArray(v) || v.length === 0)
      return [`\`${f}\` must list at least one entry`];
    return v.flatMap((entry, i) => mapping(spec)(entry, `${f}[${i}]`));
  };

// M2's inventory entry, with the wording of M2's own runner, plus what the
// resolver relies on: an output is one literal file (a hand edit to it must
// resolve back to its area), and a source glob compiles.
const GENERATED_FIELDS = ["outputs", "source", "command", "check", "notes"];

/** One generated entry's problems; `at` names it. */
function generatedEntryProblems(
  entry: Record<string, unknown>,
  at: string,
): string[] {
  const problems = Object.keys(entry)
    .filter((key) => !GENERATED_FIELDS.includes(key))
    .map((key) => `${at}: unknown field \`${key}\``);
  const { outputs, source } = entry;
  if (!isTextList(outputs) || outputs.length === 0)
    problems.push(`${at}.outputs: must list at least one path`);
  else
    problems.push(
      ...outputs.flatMap((output, j) =>
        when(
          OUTPUT_PATH_RE.test(output),
          `${at}.outputs[${j}]: \`${output}\` is not a literal repository-relative file path`,
        ),
      ),
    );
  if (!isTextList(source) || source.length === 0)
    problems.push(`${at}.source: must list at least one path`);
  else problems.push(...globs(source, `${at}.source`));
  for (const field of ["command", "check"])
    if (!isFilled(entry[field]))
      problems.push(`${at}.${field}: must be a command`);
  if (entry.notes !== undefined && !isText(entry.notes))
    problems.push(`${at}.notes: not text`);
  return problems;
}

const generated: Check = (v, f) => {
  if (!Array.isArray(v)) return [`${f}: must be a list of entries`];
  if (v.length === 0) return [`${f}: must list at least one entry`];
  return v.flatMap((entry, i) =>
    isRecord(entry)
      ? generatedEntryProblems(entry, `${f}[${i}]`)
      : [`${f}[${i}]: not a mapping`],
  );
};

/** Adds a composer's fields to `spec`; a built-in name is a programming error. */
function extend(
  spec: Spec,
  extra: Record<string, FieldType> | undefined,
  what: string,
): Spec {
  for (const [name, type] of Object.entries(extra ?? {})) {
    if (Object.hasOwn(spec, name))
      throw new Defect(
        `${what} field \`${name}\` is built in; a composer cannot redeclare it`,
      );
    spec[name] = { check: extension(type) };
  }
  return spec;
}

/** The checks of every built-in area field, under the catalog's vocabularies. */
function areaSpec(doc: Record<string, unknown>, fields: FieldExtensions): Spec {
  // A malformed vocabulary is reported on its own; the field it would close
  // stays open rather than failing on every area as well.
  const vocab: Vocabularies = Object.fromEntries(
    Object.entries(isRecord(doc.vocabularies) ? doc.vocabularies : {}).filter(
      ([, list]) => isTextList(list) && list.length > 0,
    ),
  );
  const profileNames = isRecord(doc.profiles)
    ? Object.keys(doc.profiles)
    : vocab.profile;
  const validation = extend(
    {
      profile: { check: word(profileNames) },
      ownTests: { check: filled },
      notes: { check: text },
    },
    fields.validation,
    "validation",
  );
  const tracker = mapping({
    labels: { check: textList },
    flags: { check: words(vocab.flags, false) },
  });
  return extend(
    {
      title: { required: true, check: filled },
      category: { required: true, check: word(vocab.category) },
      paths: { required: true, check: globs },
      workspace: { required: true, check: textList },
      impliedBy: {
        required: true,
        check: (v, f) =>
          when(
            Array.isArray(v) &&
              v.every((ref) => isText(ref) && AREA_ID.test(ref)),
            `\`${f}\` must be a list of area ids`,
          ),
      },
      deployTier: { required: true, check: word(vocab.deployTier) },
      notes: { check: text },
      validation: { check: mapping(validation) },
      generated: { check: generated },
      review: {
        check: mapping({
          skills: {
            required: true,
            check: (v, f) =>
              when(
                isTextList(v) && v.length > 0,
                `\`${f}\` must list at least one skill`,
              ),
          },
          notes: { check: text },
        }),
      },
      postDeploy: {
        check: listOf({
          action: { required: true, check: filled },
          when: { required: true, check: filled },
          envs: { required: true, check: words(vocab.envs, true) },
          notes: { check: text },
        }),
      },
      tracker: { check: tracker },
      linear: { check: tracker },
      agent: { check: word(vocab.agent) },
      labels: { check: textList },
      // Reserved for projections a repository's own tooling reads; their
      // shape is that tooling's.
      ci: { check: anything },
      deploy: { check: anything },
      scaffolding: { check: anything },
      owner: { check: anything },
    },
    fields.area,
    "area",
  );
}

function vocabularyProblems(value: unknown, hasProfiles: boolean): string[] {
  if (!isRecord(value)) return ["`vocabularies` is not a mapping"];
  const problems: string[] = [];
  for (const [key, list] of Object.entries(value)) {
    if (!(VOCABULARY_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `vocabularies: unknown vocabulary \`${key}\` (known: ${VOCABULARY_KEYS.join(", ")})`,
      );
      continue;
    }
    if (!isTextList(list) || list.length === 0)
      problems.push(`vocabularies.${key}: must list at least one value`);
  }
  // One list of profile names, not two that could disagree.
  if (hasProfiles && Object.hasOwn(value, "profile"))
    problems.push(
      "vocabularies.profile: `profiles` already names the profiles; declare one of the two",
    );
  return problems;
}

function profilesProblems(value: unknown): string[] {
  if (!isRecord(value) || Object.keys(value).length === 0)
    return ["`profiles` must map at least one profile name to its checks"];
  return Object.entries(value)
    .flatMap(([name, profile]) => [
      ...when(
        PROFILE_NAME.test(name),
        `profiles.${name}: the name is not kebab-case starting with a letter`,
      ),
      ...mapping({
        localChecks: { required: true, check: commands },
        verificationChecks: { required: true, check: commands },
        notes: { check: text },
      })(profile, `profiles.${name}`),
    ])
    .concat(deepestProfileProblems(value));
}

/**
 * The deepest profile is the fail-closed fallback for a file no area claims
 * and for an area that names no profile, so it must list a check: an empty
 * one would plan nothing to run for exactly the change the catalog knows
 * least about. A shallower profile may list none, as a deliberate no-check
 * policy for the areas that name it.
 */
function deepestProfileProblems(profiles: Record<string, unknown>): string[] {
  const [name, profile] = Object.entries(profiles).at(-1) ?? [];
  if (!isRecord(profile)) return [];
  const listed = (key: string) =>
    Array.isArray(profile[key]) && (profile[key] as unknown[]).length > 0;
  return listed("localChecks") || listed("verificationChecks")
    ? []
    : [
        `profiles.${name}: the deepest profile is the fail-closed fallback and lists no check; give it at least one local or verification check`,
      ];
}

/**
 * Schema problems of a parsed catalog, in a stable order: top-level fields,
 * the vocabularies and profiles, then each area in catalog order. Empty
 * means the catalog loads. The `impliedBy` graph (references, cycles) and
 * the repository-facing invariants are `check.ts`'s.
 */
export function catalogProblems(
  doc: unknown,
  fields: FieldExtensions = {},
): string[] {
  if (!isRecord(doc) || !isRecord(doc.areas))
    return ["the catalog has no `areas` map"];
  const problems = Object.keys(doc)
    .filter((key) => !["areas", "vocabularies", "profiles"].includes(key))
    .map((key) => `unknown top-level field \`${key}\``);
  if (Object.hasOwn(doc, "vocabularies"))
    problems.push(
      ...vocabularyProblems(doc.vocabularies, Object.hasOwn(doc, "profiles")),
    );
  if (Object.hasOwn(doc, "profiles"))
    problems.push(...profilesProblems(doc.profiles));
  const spec = areaSpec(doc, fields);
  for (const [id, area] of Object.entries(doc.areas)) {
    const own = AREA_ID.test(id) ? [] : ["the id is not kebab-case"];
    if (!isRecord(area)) own.push("not a mapping");
    else {
      own.push(...fieldsProblems(area, spec));
      if (Object.hasOwn(area, "tracker") && Object.hasOwn(area, "linear"))
        own.push("declare `tracker` or its older spelling `linear`, not both");
    }
    problems.push(...own.map((p) => `${id}: ${p}`));
  }
  return problems;
}
