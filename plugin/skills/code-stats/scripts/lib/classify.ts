/**
 * Classify one file along each dimension, keeping the rule that decided each
 * value. Layers, lowest precedence first: built-in detection (conventions,
 * attributes, banners, extensions), the `code_stats` configuration, then the
 * repository's classify command. A seam for test-runner configuration sits
 * between detection and configuration, where a later layer will read it.
 */
import { hasGeneratorBanner } from "./banner.ts";
import { buildToolOf } from "./build-tools.ts";
import type { AreaRule, CodeStatsConfig } from "./config.ts";
import {
  describeConvention,
  FIXTURE_CONVENTIONS,
  firstConvention,
  GENERATED_CONVENTIONS,
  TEST_CONVENTIONS,
  VENDORED_CONVENTIONS,
} from "./conventions.ts";
import {
  ASSET_EXTENSIONS,
  CODE_EXTENSIONS,
  CONFIG_EXTENSIONS,
  CONFIG_FILE_NAMES,
  type CommentStyle,
  commentStyle,
  DATA_EXTENSIONS,
  DOC_EXTENSIONS,
  DOC_FILE_NAMES,
  getExtension,
  isCodeLanguage,
  languageCommentStyle,
  languageOfExtension,
} from "./languages.ts";
import type { Classification, Decision, Kind } from "./model.ts";
import { type ModuleMap, moduleOf } from "./modules.ts";

/** What reading a file found out, before any rule ran. */
export interface FileFacts {
  path: string;
  filename: string;
  ext: string;
  /** The file's `linguist-*` attributes. */
  attributes: ReadonlyMap<string, string> | undefined;
  /**
   * `text`: read and line-counted; `binary`: a NUL byte in its first 8 KB;
   * `unread`: a media extension or too large to count; `symlink` and
   * `submodule` are entries of their own.
   */
  shape: "text" | "binary" | "unread" | "symlink" | "submodule";
  /** The file's first characters, for banners and shebangs; empty unless read. */
  head: string;
  shebang: { language: string; line: string } | null;
}

/** What the classify command said about one file. */
export interface Override {
  area?: string;
  kind?: Kind;
  language?: string;
  module?: string;
}

export const FROM_COMMAND = "classify_command";

/** An attribute set (`attr`, `attr=true`), unset (`-attr`, `attr=false`) or neither. */
function attributeState(
  facts: FileFacts,
  name: string,
): "set" | "unset" | undefined {
  const value = facts.attributes?.get(name);
  if (value === "set" || value === "true") return "set";
  if (value === "unset" || value === "false") return "unset";
  return undefined;
}

/** The area: the first rule that matches, else the default area. */
export function classifyArea(
  path: string,
  config: CodeStatsConfig,
  code = CODE_EXTENSIONS.has(getExtension(path.split("/").pop() ?? "")),
): { decision: Decision; matched: boolean } {
  for (const [i, area] of config.areas.entries()) {
    const where = config.configuredAreas
      ? `code_stats.areas[${i}] ${JSON.stringify(area.name)}`
      : `default area rule ${JSON.stringify(area.name)}`;
    if (area.exclude?.some((p) => p.glob.match(path))) continue;
    const hit = area.patterns.find((p) => p.glob.match(path));
    if (hit)
      return {
        decision: {
          value: area.name,
          rule: hit.label
            ? `${where}, ${hit.label} (glob ${JSON.stringify(hit.pattern)})`
            : `${where} glob ${JSON.stringify(hit.pattern)}`,
        },
        matched: true,
      };
    if (area.predicate?.test(path, code))
      return {
        decision: {
          value: area.name,
          rule: `${where}: ${area.predicate.rule}`,
        },
        matched: true,
      };
  }
  return {
    decision: {
      value: config.defaultArea,
      rule: "default_area: no area rule matched",
    },
    matched: false,
  };
}

/** The language of an entry that is not plain text, or one an attribute names. */
function specialLanguage(facts: FileFacts): Decision | null {
  if (facts.shape === "symlink")
    return { value: "symlink", rule: "a symbolic link" };
  if (facts.shape === "submodule")
    return { value: "submodule", rule: "a submodule" };
  const named = facts.attributes?.get("linguist-language");
  if (named !== undefined && named !== "set" && named !== "unset")
    return { value: named, rule: "attribute linguist-language" };
  if (facts.shape === "binary")
    return {
      value: `binary (${facts.ext})`,
      rule: "binary content: a NUL byte in the first 8 KB",
    };
  return null;
}

/** The language the file's name, or else its shebang, says. */
function nameLanguage(facts: FileFacts): Decision {
  const extensionless = !facts.filename.includes(".");
  const name = extensionless
    ? `file name ${facts.filename}`
    : `extension .${facts.ext}`;
  const byExtension = languageOfExtension(facts.ext);
  if (byExtension !== null) return { value: byExtension, rule: name };
  if (extensionless && facts.shebang)
    return {
      value: facts.shebang.language,
      rule: `shebang (${facts.shebang.line})`,
    };
  return { value: facts.ext, rule: `${name}: no known language` };
}

/** The language: the attribute, else what the content or name says. */
export function detectLanguage(facts: FileFacts): Decision {
  return specialLanguage(facts) ?? nameLanguage(facts);
}

/**
 * The comment style the line counter strips: the extension's, else, when
 * the extension has none, that of the language a shebang, an attribute or
 * the classify command named.
 */
export function lineStyle(facts: FileFacts, language: string): CommentStyle {
  const own = commentStyle(facts.ext);
  if (own !== "none") return own;
  return language === facts.ext || languageOfExtension(facts.ext) === language
    ? "none"
    : languageCommentStyle(language);
}

/** Whether the file is code by its extension or by the language it is in. */
function isCode(facts: FileFacts, language: Decision): boolean {
  return (
    CODE_EXTENSIONS.has(facts.ext) ||
    (languageOfExtension(facts.ext) === null && isCodeLanguage(language.value))
  );
}

function attributeKind(facts: FileFacts): Decision<Kind> | null {
  if (attributeState(facts, "linguist-vendored") === "set")
    return { value: "vendored", rule: "attribute linguist-vendored" };
  if (attributeState(facts, "linguist-generated") === "set")
    return { value: "generated", rule: "attribute linguist-generated" };
  if (attributeState(facts, "linguist-documentation") === "set")
    return { value: "docs", rule: "attribute linguist-documentation" };
  return null;
}

function vendoredKind(facts: FileFacts): Decision<Kind> | null {
  if (attributeState(facts, "linguist-vendored") === "unset") return null;
  const hit = firstConvention(VENDORED_CONVENTIONS, facts.path, facts.filename);
  return hit ? { value: "vendored", rule: describeConvention(hit) } : null;
}

function assetKind(facts: FileFacts): Decision<Kind> | null {
  if (ASSET_EXTENSIONS.has(facts.ext))
    return { value: "asset", rule: `extension .${facts.ext}: binary or media` };
  return facts.shape === "binary"
    ? { value: "asset", rule: "binary content: a NUL byte in the first 8 KB" }
    : null;
}

function generatedKind(facts: FileFacts): Decision<Kind> | null {
  if (attributeState(facts, "linguist-generated") === "unset") return null;
  const hit = firstConvention(
    GENERATED_CONVENTIONS,
    facts.path,
    facts.filename,
  );
  if (hit) return { value: "generated", rule: describeConvention(hit) };
  return facts.head && hasGeneratorBanner(facts.head, facts.ext)
    ? {
        value: "generated",
        rule: "generator banner (@generated or DO NOT EDIT) in the leading comment",
      }
    : null;
}

/**
 * A build tool's file is configuration, or code. Checked after the fixture
 * and test conventions, so one in a fixture or test folder keeps that kind.
 */
function buildKind(
  facts: FileFacts,
  language: Decision,
): Decision<Kind> | null {
  const build = buildToolOf(facts.path);
  if (!build) return null;
  const rule = `build tool: ${build.tool.tool} (glob ${JSON.stringify(build.pattern)})`;
  return isCode(facts, language)
    ? { value: "code", rule: `${rule}, code` }
    : { value: "config", rule: `${rule}, configuration` };
}

function fixtureKind(facts: FileFacts): Decision<Kind> | null {
  const hit = firstConvention(FIXTURE_CONVENTIONS, facts.path, facts.filename);
  return hit ? { value: "fixture", rule: describeConvention(hit) } : null;
}

function testKind(facts: FileFacts, language: Decision): Decision<Kind> | null {
  const hit = firstConvention(TEST_CONVENTIONS, facts.path, facts.filename);
  if (!hit) return null;
  const rule = describeConvention(hit);
  if (isCode(facts, language)) return { value: "test", rule };
  return DOC_EXTENSIONS.has(facts.ext)
    ? { value: "docs", rule: `${rule}; documentation in a test folder` }
    : {
        value: "fixture",
        rule: `${rule}; a file that is not code is a fixture`,
      };
}

function pathKind(facts: FileFacts, language: Decision): Decision<Kind> | null {
  return (
    vendoredKind(facts) ??
    assetKind(facts) ??
    generatedKind(facts) ??
    fixtureKind(facts) ??
    testKind(facts, language) ??
    buildKind(facts, language)
  );
}

/** Kinds by extension group, in order: the first group that holds the extension. */
const EXTENSION_KINDS: readonly [(f: FileFacts) => boolean, Kind, string][] = [
  [(f) => CODE_EXTENSIONS.has(f.ext), "code", "code"],
  [(f) => DOC_EXTENSIONS.has(f.ext), "docs", "documentation"],
  [(f) => DOC_FILE_NAMES.has(f.filename), "docs", "documentation"],
  [(f) => DATA_EXTENSIONS.has(f.ext), "data", "data"],
  [(f) => CONFIG_EXTENSIONS.has(f.ext), "config", "configuration"],
  [(f) => CONFIG_FILE_NAMES.test(f.ext), "config", "configuration"],
];

function extensionKind(
  facts: FileFacts,
  language: Decision,
  area: AreaRule | undefined,
  areaIndex: number,
): Decision<Kind> {
  const { ext, filename } = facts;
  const name = filename.includes(".")
    ? `extension .${ext}`
    : `file name ${filename}`;
  const group = EXTENSION_KINDS.find(([holds]) => holds(facts));
  if (group?.[1] === "config" && CONFIG_EXTENSIONS.has(ext) && area?.content)
    return {
      value: "data",
      rule: `${name} in code_stats.areas[${areaIndex}] ${JSON.stringify(area.name)}, which has content: true`,
    };
  if (group) return { value: group[1], rule: `${name}: ${group[2]}` };
  if (isCode(facts, language))
    return {
      value: "code",
      rule: `${language.value} (${language.rule}) is code`,
    };
  return { value: "other", rule: `no rule matched (${name})` };
}

/** Built-in detection: what a file is, with no configuration. */
export function detectKind(
  facts: FileFacts,
  language: Decision,
  area: AreaRule | undefined = undefined,
  areaIndex = -1,
): Decision<Kind> {
  if (facts.shape === "submodule")
    return {
      value: "vendored",
      rule: "a submodule: another repository's code",
    };
  if (facts.shape === "symlink")
    return { value: "other", rule: "a symbolic link" };
  return (
    attributeKind(facts) ??
    pathKind(facts, language) ??
    extensionKind(facts, language, area, areaIndex)
  );
}

/** The first `code_stats.kinds` glob that matches, or null. */
export function configuredKind(
  path: string,
  config: CodeStatsConfig,
): Decision<Kind> | null {
  const hit = config.kinds.find((k) => k.pattern.glob.match(path));
  return hit
    ? {
        value: hit.kind,
        rule: `code_stats.kinds.${hit.kind} glob ${JSON.stringify(hit.pattern.pattern)}`,
      }
    : null;
}

/** Every dimension of one file, each with its deciding rule. */
export function classify(
  facts: FileFacts,
  config: CodeStatsConfig,
  modules: ModuleMap,
  override: Override | undefined,
): Classification {
  const fromCommand = (value: string): Decision => ({
    value,
    rule: FROM_COMMAND,
  });
  const language = override?.language
    ? fromCommand(override.language)
    : detectLanguage(facts);
  // Test-runner configuration (a later layer) goes between these two.
  const kindIn = (areaRule?: AreaRule, areaIndex = -1): Decision<Kind> =>
    override?.kind
      ? { value: override.kind, rule: FROM_COMMAND }
      : (configuredKind(facts.path, config) ??
        detectKind(facts, language, areaRule, areaIndex));
  // Whether a file is code does not depend on its area, so the area rules
  // can read the same decision the file's kind is.
  const code = ["code", "test"].includes(kindIn().value);
  const byRule = classifyArea(facts.path, config, code);
  const area = override?.area ? fromCommand(override.area) : byRule.decision;
  const areaIndex = config.areas.findIndex((a) => a.name === area.value);
  const kind = kindIn(config.areas[areaIndex], areaIndex);
  return {
    area,
    areaMatched: override?.area ? true : byRule.matched,
    kind,
    language,
    module: override?.module
      ? fromCommand(override.module)
      : moduleOf(facts.path, modules),
  };
}
