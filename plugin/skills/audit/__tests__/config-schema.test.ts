/**
 * The configuration schema is the one list of `.config/jig.yaml` fields.
 * These tests keep the two other places that list them in step with it:
 * CONFIGURATION.md (every field documented, with the same readers, and a
 * complete example that passes) and the skills that read the fields (the
 * value sets they accept).
 */
import { REPOSITORY_ONLY_FIELDS } from "../../../shared/config-layers.ts";
import { AUTONOMY_LEVELS, DEFAULT_LEVEL } from "../../../shared/autonomy.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../shared/yaml.ts";
import { LABEL_ROLES } from "../../../shared/tracker-labels.ts";
import {
  ISSUE_LINKS,
  KNOWN_KEYS,
  OPEN_AS,
  parsePrPolicy,
  STACKING_MODES,
  TITLE_FORMATS,
} from "../../drive-pr/scripts/lib/pr-policy.ts";
import {
  DEFAULT_ADAPTER,
  parseTrackerConfig,
} from "../../do-item/scripts/lib/tracker/config.ts";
import {
  DEFAULT_ISSUE_TYPE,
  LINKED_RELATIONS,
  RESOLVED_STATES,
} from "../../do-item/scripts/lib/tracker/jira/settings.ts";
import {
  DEFAULT_STATES_FROM,
  DEFAULT_STATUS_FIELD,
  GITHUB_STATE_SOURCES,
  PRIORITY_NAMES,
} from "../../do-item/scripts/lib/tracker/github/settings.ts";
import {
  ARM_DRIVE_MODES,
  DEFAULT_ARM_DRIVE,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_PASS_DEADLINE_RETRIES,
  DEFAULT_PASS_ARGS,
  DEFAULT_PASS_MODEL,
  PASS_ARG_PATTERN,
  refusedPassArgs,
  PASS_MODEL_PATTERN,
} from "../../drive-pr/scripts/lib/overlay.ts";
import { DEFAULT_HOTSPOT_MIN_MERGES } from "../../resolve-conflicts/scripts/lib/classify.ts";
import { DEFAULT_REMOTE } from "../../../shared/consumer.ts";
import { DEFAULT_SCANNER_APPS } from "../../resolve-review-comments/scripts/lib/scanner-annotations.ts";
import { DEFAULT_BLOCK } from "../../do-item/scripts/lib/execution-plan.ts";
import { parseWorkTypes } from "../../do-item/scripts/lib/work-types.ts";
import { DEFAULT_TEMPLATE as DEFAULT_WORKSPACE_TEMPLATE } from "../../do-item/scripts/workspace-name.ts";
import {
  parseRouting,
  RAISE_FIELDS,
  ROUTING_FIELDS,
} from "../../do-item/scripts/lib/routing.ts";
import {
  CANONICAL_STATES,
  knownAdapters,
} from "../../do-item/scripts/lib/tracker/index.ts";
import { checkConfig, loadSchema, parseSchema } from "../scripts/lib/schema.ts";
import {
  DEFAULT_OUTPUT_LINES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  verifySettings,
} from "../../../shared/evidence-record.ts";
import {
  MODES,
  parseReflection,
  STORE_KINDS,
} from "../../reflect/scripts/lib/settings.ts";
import {
  DEFAULTS as CHANGELOG_DEFAULTS,
  FIELDS as CHANGELOG_FIELDS,
  parseChangelogSection,
} from "../../changelog/scripts/config.ts";
import { FORMAT_IDS } from "../../changelog/scripts/formats.ts";
import { DEFAULT_TAXONOMY } from "../../file-issue/scripts/lib/config.ts";
import { SAFE_KEY_COMPONENT_PATTERN } from "../../resolve-review-comments/scripts/lib/batch-description.ts";
import {
  DEFAULT_AREA as CODE_STATS_DEFAULT_AREA,
  FIELDS as CODE_STATS_FIELDS,
  parseCodeStatsConfig,
} from "../../code-stats/scripts/lib/config.ts";
import { KINDS as CODE_STATS_KINDS } from "../../code-stats/scripts/lib/model.ts";
import {
  DEFAULT_MAX_ITEMS,
  DEFAULT_POINT_BUDGET,
  DEFAULT_RANKING,
  RANKING_FIELDS,
  WORK_BATCH_FIELDS,
  parseWorkBatchSection,
} from "../../work-batch/scripts/lib/policy.ts";
import {
  DEFAULT_STALE_AFTER_DAYS,
  FIELDS as DOCS_FIELDS,
} from "../../docs/scripts/lib/settings.ts";
import {
  DEFAULT_BODY_SECTION,
  parseSpecsConfig,
  SPECS_FIELDS,
} from "../../../shared/spec/config.ts";
import { ADAPTERS } from "../../../shared/spec/registry.ts";
import { runScript } from "./helpers.ts";

const plugin = join(import.meta.dir, "..", "..", "..");
const repoRoot = join(plugin, "..");
const schema = loadSchema();
const field = (path: string) => schema.fields.find((f) => f.path === path);
const under = (prefix: string) =>
  schema.fields
    .filter((f) => f.path.startsWith(`${prefix}.`))
    .map((f) => f.path.slice(prefix.length + 1));

/** The overlay field rows of CONFIGURATION.md, with their "Read by" cells. */
function documentedFields(): Map<string, string[] | null> {
  const rows = new Map<string, string[] | null>();
  let skip = false;
  let readBy = -1;
  for (const line of readFileSync(
    join(plugin, "CONFIGURATION.md"),
    "utf8",
  ).split("\n")) {
    if (line.startsWith("#")) {
      // The triage and fleet-health files are separate files with their own fields.
      skip =
        /^### The |^## (What is derived|Environment variables|Complete example)/.test(
          line,
        );
      continue;
    }
    if (skip || !line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells[0] === "Field") {
      readBy = cells.indexOf("Read by");
      continue;
    }
    const name = /^`([a-z_.]+)`$/.exec(cells[0] ?? "")?.[1];
    if (!name?.includes(".")) continue;
    rows.set(
      name,
      readBy < 0
        ? null
        : (cells[readBy] ?? "")
            .replace(/\([^)]*\)/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
  }
  return rows;
}

function completeExample(): Record<string, unknown> {
  const doc = readFileSync(join(plugin, "CONFIGURATION.md"), "utf8");
  const block = /## Complete example[\s\S]*?```yaml\n([\s\S]*?)```/.exec(
    doc,
  )?.[1];
  if (!block) throw new Error("CONFIGURATION.md has no complete example");
  return load(block) as Record<string, unknown>;
}

describe("CONFIGURATION.md", () => {
  const documented = documentedFields();

  test("documents exactly the schema's fields", () => {
    expect([...documented.keys()].sort()).toEqual(
      schema.fields.map((f) => f.path).sort(),
    );
  });

  test("marks as repository-only exactly the fields the user file refuses", () => {
    expect(
      schema.fields
        .filter((f) => f.repository_only)
        .map((f) => f.path)
        .sort(),
    ).toEqual([...REPOSITORY_ONLY_FIELDS].sort());
  });

  test("names the same readers as the schema", () => {
    for (const [path, readers] of documented)
      if (readers !== null)
        expect([path, readers.sort()]).toEqual([
          path,
          [...(field(path)?.read_by ?? [])].sort(),
        ]);
  });

  test("its complete example sets every field and passes the schema and the skills", () => {
    const example = completeExample();
    const findings = checkConfig(example, schema);
    expect(findings.filter((f) => !f.id.startsWith("deprecated:"))).toEqual([]);
    expect(() => parsePrPolicy(example)).not.toThrow();
    expect(() => parseTrackerConfig(example)).not.toThrow();
    expect(() => parseWorkTypes(example)).not.toThrow();
    expect(() => parseRouting(example, parseWorkTypes(example))).not.toThrow();
    expect(() => parseReflection(example.reflection, repoRoot)).not.toThrow();
    expect(parseChangelogSection(example.changelog)).not.toBeNull();
    expect(() =>
      parseSpecsConfig(
        example.specs,
        ADAPTERS.map((a) => a.name),
      ),
    ).not.toThrow();
    const set = (path: string) =>
      path
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          example,
        );
    for (const f of schema.fields)
      expect([f.path, set(f.path) !== undefined]).toEqual([f.path, true]);
  });
});

test("its complete example's code_stats section passes the skill", () => {
  expect(() =>
    parseCodeStatsConfig(completeExample().code_stats),
  ).not.toThrow();
});

test("its complete example's verify section passes the evidence record", () => {
  expect(() =>
    verifySettings(completeExample().verify, repoRoot),
  ).not.toThrow();
});

test("its complete example's work_batch section passes the skill", () => {
  const example = completeExample();
  const { batchSizes } = parseTrackerConfig(example).labels;
  expect(() => parseWorkBatchSection(example, batchSizes)).not.toThrow();
});

describe("the reading skills", () => {
  test("accept the value sets the schema lists", () => {
    expect(field("pull_requests.stacking")?.values).toEqual([
      ...STACKING_MODES,
    ]);
    expect(field("pull_requests.open_as")?.values).toEqual([...OPEN_AS]);
    expect(field("do_item.arm_drive")?.values).toEqual([...ARM_DRIVE_MODES]);
    expect(field("drive.pass_model")?.pattern).toBe(PASS_MODEL_PATTERN.source);
    expect(field("drive.pass_args")?.items).toEqual({
      type: "string",
      pattern: PASS_ARG_PATTERN.source,
    });
    expect(field("pull_requests.issue_link")?.values).toEqual([...ISSUE_LINKS]);
    expect(field("pull_requests.title_format")?.values).toEqual([
      ...TITLE_FORMATS,
    ]);
    expect(field("issue_tracker.states")?.keys).toEqual([...CANONICAL_STATES]);
    expect(field("issue_tracker.adapter")?.values).toEqual(knownAdapters());
    expect(field("reflection.store")?.values).toEqual([...STORE_KINDS]);
    expect(field("reflection.mode")?.values).toEqual([...MODES]);
    expect(field("changelog.format")?.values).toEqual([...FORMAT_IDS]);
  });

  test("accept the spec adapters the resolver has", () => {
    expect(field("specs.adapters")?.items).toEqual({
      type: "enum",
      values: ADAPTERS.map((a) => a.name),
    });
  });

  test("read the routing section's fields", () => {
    expect(under("routing").sort()).toEqual(
      ROUTING_FIELDS.flatMap((f) =>
        f === "raise" ? RAISE_FIELDS.map((r) => `raise.${r}`) : [f],
      ).sort(),
    );
  });

  test("accept the GitHub adapter's value sets the schema lists", () => {
    expect(field("issue_tracker.github.states_from")?.values).toEqual([
      ...GITHUB_STATE_SOURCES,
    ]);
    expect(field("issue_tracker.github.priority_labels")?.keys).toEqual([
      ...PRIORITY_NAMES,
    ]);
  });

  test("accept the Jira adapter's value sets the schema lists", () => {
    expect(field("issue_tracker.jira.priorities")?.keys).toEqual([
      ...PRIORITY_NAMES,
    ]);
    expect(field("issue_tracker.jira.resolutions")?.keys).toEqual([
      ...RESOLVED_STATES,
    ]);
    expect(field("issue_tracker.jira.link_types")?.keys).toEqual([
      ...LINKED_RELATIONS,
    ]);
  });

  test("read the code_stats section's fields, all of them repository-only", () => {
    expect(under("code_stats").sort()).toEqual([...CODE_STATS_FIELDS].sort());
    expect(field("code_stats.kinds")?.keys).toEqual([...CODE_STATS_KINDS]);
    for (const f of schema.fields.filter((f) =>
      f.path.startsWith("code_stats."),
    ))
      expect([f.path, f.repository_only]).toEqual([f.path, true]);
  });

  test("read the docs section's fields", () => {
    expect(under("docs").sort()).toEqual([...DOCS_FIELDS].sort());
  });

  test("read the changelog section's fields, all of them repository-only", () => {
    expect(under("changelog").sort()).toEqual([...CHANGELOG_FIELDS].sort());
    for (const f of schema.fields.filter((f) =>
      f.path.startsWith("changelog."),
    )) {
      expect([f.path, f.repository_only]).toEqual([f.path, true]);
      // `next` until the release stamps the version it ships in.
      expect([f.path, f.since]).toEqual([
        f.path,
        expect.stringMatching(/^(next|\d+\.\d+\.\d+)$/),
      ]);
    }
  });

  test("use the defaults the schema lists", () => {
    const policy = parsePrPolicy({});
    const defaults = Object.fromEntries(
      schema.fields
        .filter((f) => f.default !== undefined)
        .map((f) => [f.path, f.default]),
    );
    expect(defaults).toEqual({
      "pull_requests.stacking": policy.stacking,
      "pull_requests.mark_ready": policy.markReady,
      "pull_requests.branch_name": policy.branchName,
      "pull_requests.issue_link": policy.issueLink,
      "drive.max_rounds": DEFAULT_MAX_ROUNDS,
      "drive.pass_deadline_retries": DEFAULT_PASS_DEADLINE_RETRIES,
      "drive.pass_model": DEFAULT_PASS_MODEL,
      "drive.pass_args": DEFAULT_PASS_ARGS,
      "do_item.arm_drive": DEFAULT_ARM_DRIVE,
      "issue_tracker.adapter": DEFAULT_ADAPTER,
      "issue_tracker.github.states_from": DEFAULT_STATES_FROM,
      "issue_tracker.github.status_field": DEFAULT_STATUS_FIELD,
      "issue_tracker.jira.issue_type": DEFAULT_ISSUE_TYPE,
      "issue_tracker.taxonomy": DEFAULT_TAXONOMY,
      "do_item.execution_plan_block": DEFAULT_BLOCK,
      "changelog.notes_dir": CHANGELOG_DEFAULTS.notesDir,
      "changelog.authors": CHANGELOG_DEFAULTS.authors,
      "changelog.tag_prefix": CHANGELOG_DEFAULTS.tagPrefix,
      "changelog.release.push": CHANGELOG_DEFAULTS.push,
      "changelog.release.branch": CHANGELOG_DEFAULTS.branch,
      "code_stats.default_area": CODE_STATS_DEFAULT_AREA,
      "docs.stale_after_days": DEFAULT_STALE_AFTER_DAYS,
      "work_batch.point_budget": DEFAULT_POINT_BUDGET,
      "work_batch.max_items": DEFAULT_MAX_ITEMS,
      "work_batch.ranking.provenance": DEFAULT_RANKING.provenance,
      "work_batch.ranking.shared_area_label": DEFAULT_RANKING.sharedAreaLabel,
      "resolve_conflicts.hotspot_min_merges": DEFAULT_HOTSPOT_MIN_MERGES,
      "repository.remote": DEFAULT_REMOTE,
      "review.scanner_apps": DEFAULT_SCANNER_APPS,
      "specs.body_section": DEFAULT_BODY_SECTION,
      "routing.raise.reviews": parseRouting({}, parseWorkTypes({})).raise
        .reviews,
      "workspace_name.template": DEFAULT_WORKSPACE_TEMPLATE,
      "verify.output_lines": DEFAULT_OUTPUT_LINES,
      "verify.timeout_minutes": DEFAULT_TIMEOUT_MINUTES,
      "verify.retention_days": DEFAULT_RETENTION_DAYS,
      "autonomy.level": DEFAULT_LEVEL,
    });
  });

  test("accept a review bot as a login or a mapping with its markers", () => {
    const problems = (bots: unknown[]) =>
      checkConfig({ review: { bots } }, schema).map((f) => f.message);
    expect(
      problems(["a[bot]", { login: "b[bot]", chat_marker: "<!-- c -->" }]),
    ).toEqual([]);
    expect(problems([{ login: "b", override: true }]).join()).toContain(
      "unknown key override",
    );
    expect(problems([5]).join()).toContain("or a mapping");
  });

  test("accept the autonomy levels the resolver reads", () => {
    for (const path of ["autonomy.level", "autonomy.max_level"])
      expect(field(path)?.values).toEqual([...AUTONOMY_LEVELS]);
  });

  test("accept only integers the skills read exactly", () => {
    const problems = (value: number) =>
      checkConfig({ drive: { max_rounds: value } }, schema).map(
        (f) => f.message,
      );
    expect(problems(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(problems(2 ** 53)).toEqual([
      "drive.max_rounds must be a whole number ≥ 1",
    ]);
  });

  test("reject the drive.pass_args words the reading skill refuses, and accept the rest", () => {
    const problems = (words: string[]) =>
      checkConfig({ drive: { pass_args: words } }, schema).length;
    for (const refused of [
      ["--model", "opus"],
      ["--model=opus"],
      ["-p", "text"],
      ["--print"],
      ["--"],
    ]) {
      expect(refusedPassArgs(refused)).toBeDefined();
      expect(problems(refused)).toBeGreaterThan(0);
    }
    // The schema cannot see an operand missing at the end of the list; the reading skill refuses it.
    expect(refusedPassArgs(["--permission-mode"])).toBeDefined();
    for (const accepted of [
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=auto"],
      ["--modelish"],
    ]) {
      expect(refusedPassArgs(accepted)).toBeUndefined();
      expect(problems(accepted)).toBe(0);
    }
  });

  test("report as errors the nulls remoteName refuses, and other nulls as not set", () => {
    const severities = (config: Record<string, unknown>) =>
      checkConfig(config, schema).map((f) => [f.id, f.severity]);
    expect(severities({ repository: null })).toEqual([
      ["null:repository", "error"],
    ]);
    expect(severities({ repository: { remote: null } })).toEqual([
      ["null:repository.remote", "error"],
    ]);
    expect(severities({ repository: { base_branch: null } })).toEqual([
      ["null:repository.base_branch", "info"],
    ]);
    expect(severities({ drive: null })).toEqual([]);
  });

  test("bound an integer from above where its reader does", () => {
    const problems = (value: number) =>
      checkConfig({ verify: { timeout_minutes: value } }, schema).map(
        (f) => f.message,
      );
    expect(field("verify.timeout_minutes")?.max).toBe(MAX_TIMEOUT_MINUTES);
    expect(problems(MAX_TIMEOUT_MINUTES)).toEqual([]);
    expect(problems(MAX_TIMEOUT_MINUTES + 1)).toEqual([
      `verify.timeout_minutes must be a whole number ≥ 1 and ≤ ${MAX_TIMEOUT_MINUTES}`,
    ]);
  });

  test("refuse the batch-key labels the deferral helper refuses", () => {
    const itemPattern = (path: string) => {
      const items = field(path)?.items;
      return typeof items === "object" && "pattern" in items
        ? items.pattern
        : undefined;
    };
    expect(field("review.repo_label")?.pattern).toBe(
      SAFE_KEY_COMPONENT_PATTERN,
    );
    expect(itemPattern("review.taxonomy.repos")).toBe(
      SAFE_KEY_COMPONENT_PATTERN,
    );
    expect(itemPattern("review.taxonomy.types")).toBe(
      SAFE_KEY_COMPONENT_PATTERN,
    );
    const messages = checkConfig(
      {
        review: {
          repo_label: "my repo",
          taxonomy: { types: ["bug", "tech debt"], repos: ["web"] },
        },
      },
      schema,
    ).map((f) => f.message);
    expect(messages.some((m) => m.startsWith("review.repo_label"))).toBe(true);
    expect(messages).toContain(
      `review.taxonomy.types entry 2 must match ${SAFE_KEY_COMPONENT_PATTERN}`,
    );
    expect(messages.some((m) => m.startsWith("review.taxonomy.repos"))).toBe(
      false,
    );
  });

  test("read the fields the schema lists in their strict maps", () => {
    expect(under("pull_requests").sort()).toEqual([...KNOWN_KEYS].sort());
    expect(under("issue_tracker.labels").sort()).toEqual(
      [...LABEL_ROLES].sort(),
    );
    expect(under("specs").sort()).toEqual([...SPECS_FIELDS].sort());
    expect(under("work_batch.ranking").sort()).toEqual(
      [...RANKING_FIELDS].sort(),
    );
    expect(
      [
        ...new Set(under("work_batch").map((path) => path.split(".")[0])),
      ].sort(),
    ).toEqual([...WORK_BATCH_FIELDS].sort());
    for (const prefix of schema.strict)
      expect([
        prefix,
        schema.fields.some(
          (f) => f.path === prefix || f.path.startsWith(`${prefix}.`),
        ),
      ]).toEqual([prefix, true]);
  });

  test("exist under the names the schema gives as readers", () => {
    for (const f of schema.fields)
      for (const skill of f.read_by)
        expect([
          f.path,
          skill,
          existsSync(
            skill === "gc" || skill === "dispatch"
              ? join(plugin, "jig.ts")
              : skill === "evidence"
                ? join(plugin, "shared", "evidence.ts")
                : join(plugin, "skills", skill, "SKILL.md"),
          ),
        ]).toEqual([f.path, skill, true]);
  });
});

test("Jig's own configuration fits", () => {
  const run = runScript("config-fit.ts", ["--offline", "--json"], repoRoot);
  const report = JSON.parse(run.out) as {
    findings: { id: string; severity: string }[];
  };
  // A checkout behind origin/main says where this clone stands, not whether
  // the configuration fits; it holds on any branch the moment main moves.
  expect(
    report.findings.filter(
      (f) =>
        (f.severity === "error" || f.severity === "warning") &&
        f.id !== "fact:behind-integration-branch",
    ),
  ).toEqual([]);
  expect(run.code).toBe(0);
});

describe("the schema's own format", () => {
  const withField = (entry: Record<string, unknown>) => ({
    version: 1,
    strict: [],
    refused: {},
    fields: { "a.b": { read_by: ["x"], ...entry } },
  });
  test("a list nested in a list or map has its entries typed", () => {
    const errors = checkConfig(
      {
        do_item: { gates: [{ labels: [1], paths: ["a"], skill: "s" }] },
        resolve_conflicts: { generated: [{ paths: [42], command: "x" }] },
      },
      schema,
    ).filter((f) => f.severity === "error");
    expect(errors.map((f) => f.id)).toEqual([
      "type:do_item.gates",
      "type:resolve_conflicts.generated",
    ]);
    expect(
      checkConfig({ do_item: { scouts: { a: ["x", {}] } } }, schema).map(
        (f) => f.id,
      ),
    ).toEqual(["type:do_item.scouts"]);
  });
  test("nullable, distinct and nonempty are true or false", () => {
    for (const key of ["nullable", "distinct", "nonempty"])
      expect(() =>
        parseSchema(
          withField({ type: "list", items: "string", [key]: "false" }),
        ),
      ).toThrow(`${key} must be true or false`);
    expect(() =>
      parseSchema(withField({ type: "list", items: { type: "list" } })),
    ).toThrow("a list needs items");
  });
  test("a pattern constrains only a text type, at any depth", () => {
    for (const type of ["integer", "boolean", "enum", "list", "map", "any"])
      expect(() =>
        parseSchema(
          withField({ type, values: ["a"], items: "string", pattern: "^1$" }),
        ),
      ).toThrow("pattern applies only to string, command and path");
    for (const type of ["integer", "boolean", "list", "map", "any"])
      expect(() =>
        parseSchema(
          withField({
            type: "list",
            items: { type, items: "string", pattern: "^1$" },
          }),
        ),
      ).toThrow("a list needs items");
    const nested = parseSchema(
      withField({ type: "list", items: { type: "path", pattern: "^1$" } }),
    );
    expect(checkConfig({ a: { b: ["1"] } }, nested)).toEqual([]);
    expect(checkConfig({ a: { b: ["2"] } }, nested).map((f) => f.id)).toEqual([
      "type:a.b",
    ]);
  });
  test("a nested enum lists its values, and only an enum does", () => {
    expect(() =>
      parseSchema(withField({ type: "list", items: { type: "enum" } })),
    ).toThrow("a list needs items");
    expect(() =>
      parseSchema(
        withField({ type: "list", items: { type: "string", values: ["a"] } }),
      ),
    ).toThrow("a list needs items");
    const nested = parseSchema(
      withField({ type: "list", items: { type: "enum", values: ["a"] } }),
    );
    expect(checkConfig({ a: { b: ["a"] } }, nested)).toEqual([]);
    expect(checkConfig({ a: { b: ["z"] } }, nested).map((f) => f.id)).toEqual([
      "type:a.b",
    ]);
  });
  test("a default is a value the field accepts", () => {
    expect(() =>
      parseSchema(withField({ type: "enum", values: ["a"], default: "b" })),
    ).toThrow("default must be a value the field accepts");
    expect(
      parseSchema(withField({ type: "integer", min: 1, default: 1 })).fields[0]
        ?.default,
    ).toBe(1);
  });
});
