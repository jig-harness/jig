/**
 * The configuration schema is the one list of `.config/jig.yaml` fields.
 * These tests keep the two other places that list them in step with it:
 * CONFIGURATION.md (every field documented, with the same readers, and a
 * complete example that passes) and the skills that read the fields (the
 * value sets they accept).
 */
import {
  REPOSITORY_ONLY_FIELDS,
  USER_ONLY_FIELDS,
} from "../../../shared/config-layers.ts";
import { AUTONOMY_LEVELS, DEFAULT_LEVEL } from "../../../shared/autonomy.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../shared/yaml.ts";
import { LABEL_KEYS } from "../../../shared/tracker-labels.ts";
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
import { REVIEWER_EVIDENCE } from "../../../shared/reviewer-profiles.ts";
import { specialCiSettings } from "../../drive-pr/scripts/lib/ci-special-checks.ts";
import {
  ARM_DRIVE_MODES,
  DEFAULT_ARM_DRIVE,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_PASS_DEADLINE_RETRIES,
  DEFAULT_CODEX_BYPASS,
  DEFAULT_PASS_ARGS,
  DEFAULT_PASS_MODEL,
  PASS_ARG_PATTERN,
  passArgsProblem,
  refusedPassArgs,
  PASS_MODEL_PATTERN,
} from "../../drive-pr/scripts/lib/overlay.ts";
import { DEFAULT_REVIEWER_POLL_MAX_SECONDS } from "../../drive-pr/scripts/lib/status/reviewer-poll.ts";
import {
  DEFAULT_MAX_TOTAL_ROUNDS,
  MAX_TOTAL_ROUNDS_BOUND,
  MIN_WALL_CLOCK_HOURS,
} from "../../drive-pr/scripts/lib/circuit-settings.ts";
import {
  CODEX_PASS_ARG_PATTERN,
  codexPassArgsProblem,
  DEFAULT_CODEX_PASS_ARGS,
} from "../../drive-pr/scripts/lib/codex-pass-args.ts";
import { readStatusPolling } from "../../drive-pr/scripts/lib/status/poll-pacing.ts";
import { CI_REPAIR_ROUNDS_DEFAULT } from "../../drive-pr/scripts/lib/driver/settings.ts";
import {
  DEFAULT_CHURN_ROUNDS,
  MAX_CHURN_ROUNDS,
  MIN_CHURN_ROUNDS,
} from "../../drive-pr/scripts/lib/state/churn.ts";
import { DEFAULT_HOTSPOT_MIN_MERGES } from "../../resolve-conflicts/scripts/lib/classify.ts";
import { SKILL_NAME_PATTERN } from "../../../shared/ci-status.ts";
import { DEFAULT_REMOTE } from "../../../shared/consumer.ts";
import {
  BOARD_CONFIG_KEYS,
  BOARD_STAGES,
  COLUMN_ID,
} from "../../../shared/orca-board.ts";
import { DEFAULT_LABELS } from "../../../dispatch/lib/labels.ts";
import { dispatchSection } from "../../../dispatch/lib/section.ts";
import { DEFAULT_SCANNER_APPS } from "../../resolve-review-comments/scripts/lib/scanner-annotations.ts";
import { DEFAULT_BLOCK } from "../../do-item/scripts/lib/execution-plan.ts";
import { parseWorkTypes } from "../../do-item/scripts/lib/work-types.ts";
import {
  DEFAULT_POST_MERGE,
  POST_MERGE_STATES,
} from "../../do-item/scripts/lib/post-merge.ts";
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
import { ARM_IDS } from "../../followup/scripts/lib/arms.ts";
import { ACT_IDS, LEVELS } from "../../followup/scripts/lib/authority.ts";
import {
  REPO_ARM_FORMS,
  REPO_ARM_ID_PATTERN,
  REPO_ARM_SKILL_PATTERN,
} from "../../followup/scripts/lib/repo-arms.ts";
import { parseFollowupSettings } from "../../followup/scripts/lib/settings.ts";
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
  DEFAULT_PROMOTED_STATUSES,
  DEFAULT_INDEX_SETTINGS,
  FIELDS as DOCS_FIELDS,
  INDEX_FIELDS,
} from "../../docs/scripts/lib/settings.ts";
import {
  DEFAULT_BODY_SECTION,
  DEFAULT_VERIFICATION_SECTION,
  parseSpecsConfig,
  SPECS_FIELDS,
} from "../../../shared/spec/config.ts";
import { ADAPTERS } from "../../../shared/spec/registry.ts";
import { sweepSettings } from "../../file-issue/scripts/lib/sweep-settings.ts";
import { runScript } from "./helpers.ts";

const plugin = join(import.meta.dir, "..", "..", "..");
const repoRoot = join(plugin, "..");
import {
  LOAD_DEFAULTS,
  loadSettings,
} from "../../../dispatch/lib/load-config.ts";
import { notifyChannels } from "../../../dispatch/lib/notify-config.ts";
import { WEBHOOK_FORMATS } from "../../../chat/webhook.ts";

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
      // The triage and fleet-health files and the hub's settings file are separate files with their own fields.
      skip =
        /^### The |^## (What is derived|Environment variables|Complete example|The hub's settings file)/.test(
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

test("documents the dispatch machine file's validation share in the audit schema", () => {
  const validation = schema.machineFields?.find(
    ({ path }) => path === "load.validation",
  );
  expect(validation).toMatchObject({
    type: "number",
    min: Number.MIN_VALUE,
    max: 1,
    default: LOAD_DEFAULTS.validation,
    read_by: ["dispatch"],
  });
  expect(loadSettings({ validation: validation?.min }).ok).toBe(true);
  expect(loadSettings({ validation: validation?.max }).ok).toBe(true);
  expect(loadSettings({ validation: 0 }).ok).toBe(false);
});

test("documents the dispatch machine file's notification channels in the audit schema", () => {
  const channels = schema.machineFields?.find(
    ({ path }) => path === "notify.channels",
  );
  expect(channels).toMatchObject({
    type: "list",
    items: {
      fields: {
        name: "string",
        kind: { type: "enum", values: ["webhook"] },
        url_env: "string",
        format: { type: "enum", values: [...WEBHOOK_FORMATS] },
      },
      optional: ["format"],
    },
    read_by: ["dispatch"],
  });
  for (const format of WEBHOOK_FORMATS)
    expect(
      notifyChannels({
        channels: [{ name: "phone", kind: "webhook", url_env: "HOOK", format }],
      }).ok,
    ).toBe(true);
});

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

  test("marks as user-only exactly the fields a repository's file refuses", () => {
    const [dotted, whole] = [
      USER_ONLY_FIELDS.filter((f) => f.includes(".")),
      USER_ONLY_FIELDS.filter((f) => !f.includes(".")),
    ];
    expect(
      schema.fields
        .filter((f) => f.user_only)
        .map((f) => f.path)
        .sort(),
    ).toEqual([...dotted].sort());
    // A field with no section has no entry of its own: the schema refuses it whole.
    for (const name of whole)
      expect(Object.keys(schema.refused)).toContain(name);
  });

  test("names the same readers as the schema", () => {
    for (const [path, readers] of documented)
      if (readers !== null)
        expect([path, readers.sort()]).toEqual([
          path,
          [...(field(path)?.read_by ?? [])].sort(),
        ]);
  });

  test("its complete example sets every active field and passes the schema and the skills", () => {
    const example = completeExample();
    const findings = checkConfig(example, schema);
    expect(findings.filter((f) => !f.id.startsWith("deprecated:"))).toEqual([]);
    expect(() => parsePrPolicy(example)).not.toThrow();
    expect(() => parseTrackerConfig(example)).not.toThrow();
    expect(() => readStatusPolling(example)).not.toThrow();
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
    // The example may omit deprecated keys. A repository file refuses host-only keys.
    for (const f of schema.fields) {
      const present = set(f.path) !== undefined;
      if (!present && f.deprecated !== undefined) continue;
      expect([f.path, present]).toEqual([f.path, f.user_only !== true]);
    }
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

test("its complete example's followup section passes the skill", () => {
  expect(parseFollowupSettings(completeExample()).ok).toBe(true);
});

test("its complete example's file_issue section passes the skill", () => {
  expect(sweepSettings(completeExample()).move).toBe(false);
});

describe("the reading skills", () => {
  test("accept the value sets the schema lists", () => {
    expect(field("pull_requests.stacking")?.values).toEqual([
      ...STACKING_MODES,
    ]);
    expect(field("pull_requests.open_as")?.values).toEqual([...OPEN_AS]);
    expect(field("do_item.arm_drive")?.values).toEqual([...ARM_DRIVE_MODES]);
    expect(field("review.reviewer_evidence")?.values).toEqual([
      ...REVIEWER_EVIDENCE,
    ]);
    expect(field("do_item.post_merge_state")?.values).toEqual([
      ...POST_MERGE_STATES,
    ]);
    const passModelPattern = field("drive.pass_model")?.pattern;
    expect(passModelPattern).toBeDefined();
    const schemaPassModel = new RegExp(passModelPattern as string);
    for (const value of [
      "sonnet",
      "provider/model",
      "-sonnet",
      "has space",
      "has,comma",
      "has;semicolon",
      "has=equals",
      "模型",
      "\u{10400}-model",
      "model\uD800",
      "model\uDC00",
      "\uD800\uD800\uDC00",
      "\uDC00\uD800\uDC00",
      "has\u2003em",
      ...[
        0x00a0, 0x1680, 0x2000, 0x2007, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
        0xfeff,
      ].map((code) => `has${String.fromCodePoint(code)}space`),
      ...[
        ...Array.from({ length: 0x20 }, (_, i) => i),
        ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
      ].map((code) => `has${String.fromCodePoint(code)}control`),
      "",
      ...[
        0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
        0x2067, 0x2068, 0x2069,
      ].map((code) => `has${String.fromCodePoint(code)}control`),
    ]) {
      expect(schemaPassModel.test(value)).toBe(PASS_MODEL_PATTERN.test(value));
      const findings = checkConfig({ drive: { pass_model: value } }, schema);
      if (PASS_MODEL_PATTERN.test(value)) {
        expect(findings).toEqual([]);
      } else {
        expect(findings.map((f) => `${f.id}:${f.severity}`)).toEqual([
          "type:drive.pass_model:error",
        ]);
      }
    }
    // Each lone surrogate is refused on its own, independent of the other pattern.
    for (const value of [
      "model\uDC00",
      "\uDC00model",
      "a\uD800\u{10400}",
      "\u{10400}\uDC00",
    ]) {
      expect(schemaPassModel.test(value)).toBe(false);
      expect(PASS_MODEL_PATTERN.test(value)).toBe(false);
    }
    // A non-ASCII letter is an ordinary model character: both validators accept it.
    expect(schemaPassModel.test("模型")).toBe(true);
    expect(PASS_MODEL_PATTERN.test("模型")).toBe(true);
    expect(checkConfig({ drive: { pass_model: "模型" } }, schema)).toEqual([]);
    // A supplementary-plane letter is an ordinary model character too.
    expect(schemaPassModel.test("\u{10400}-model")).toBe(true);
    expect(PASS_MODEL_PATTERN.test("\u{10400}-model")).toBe(true);
    expect(field("ci.repair_skill")?.pattern).toBe(SKILL_NAME_PATTERN.source);
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
    expect(field("followup.off")?.items).toEqual({
      type: "enum",
      values: [...ARM_IDS],
    });
    expect(field("followup.authority")?.keys).toEqual([...ACT_IDS]);
    expect(field("followup.authority")?.values_type).toEqual({
      type: "enum",
      values: [...LEVELS],
    });
  });

  test("type a repository arm's keys as the follow-up reads them", () => {
    const items = field("followup.arms")?.items as
      | { fields: Record<string, { pattern?: string }> }
      | undefined;
    const fields = items?.fields ?? {};
    expect(Object.keys(fields)).toEqual([
      "id",
      "title",
      "when",
      ...REPO_ARM_FORMS,
    ]);
    expect(fields.id?.pattern).toBe(REPO_ARM_ID_PATTERN.source);
    expect(fields.skill?.pattern).toBe(REPO_ARM_SKILL_PATTERN.source);
  });

  test("map the board stages the Orca card moves through", () => {
    expect(field("orca.board")?.keys).toEqual(
      BOARD_STAGES.map((s) => BOARD_CONFIG_KEYS[s]),
    );
    expect(field("orca.board")?.values_type).toEqual({
      type: "string",
      pattern: COLUMN_ID.source,
    });
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
    expect(
      [...new Set(under("docs").map((path) => path.split(".")[0]))].sort(),
    ).toEqual([...DOCS_FIELDS].sort());
    expect(under("docs.index").sort()).toEqual([...INDEX_FIELDS].sort());
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
    const statusPolling = readStatusPolling({});
    const dispatch = dispatchSection({});
    if (!dispatch.ok) throw new Error(dispatch.failure.reason);
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
      "drive.max_total_rounds": DEFAULT_MAX_TOTAL_ROUNDS,
      "drive.status_poll.waiting_share": statusPolling.waitingShare,
      "drive.status_poll.max_interval_seconds":
        statusPolling.maxIntervalSeconds,
      "drive.churn_rounds": DEFAULT_CHURN_ROUNDS,
      "drive.pass_deadline_retries": DEFAULT_PASS_DEADLINE_RETRIES,
      "drive.ci_repair_rounds": CI_REPAIR_ROUNDS_DEFAULT,
      "drive.pass_model": DEFAULT_PASS_MODEL,
      "drive.pass_args": DEFAULT_PASS_ARGS,
      "drive.codex_bypass": DEFAULT_CODEX_BYPASS,
      "ci.hold_sentinels": specialCiSettings({}).holdSentinels,
      "ci.advisory_checks": specialCiSettings({}).advisoryChecks,
      "ci.rerun_failed_once": true,
      "drive.codex_pass_args": DEFAULT_CODEX_PASS_ARGS,
      "do_item.arm_drive": DEFAULT_ARM_DRIVE,
      "do_item.post_merge_state": DEFAULT_POST_MERGE.state,
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
      "changelog.release.rerun_failed_gates":
        CHANGELOG_DEFAULTS.rerunFailedGates,
      "changelog.release.tagged_by": CHANGELOG_DEFAULTS.taggedBy,
      "changelog.consumer_actions": CHANGELOG_DEFAULTS.consumerActions,
      "code_stats.default_area": CODE_STATS_DEFAULT_AREA,
      "docs.stale_after_days": DEFAULT_STALE_AFTER_DAYS,
      "docs.promoted_statuses": DEFAULT_PROMOTED_STATUSES,
      "docs.index.descriptions_from_readme":
        DEFAULT_INDEX_SETTINGS.descriptionsFromReadme,
      "docs.index.order": DEFAULT_INDEX_SETTINGS.order,
      "work_batch.point_budget": DEFAULT_POINT_BUDGET,
      "work_batch.max_items": DEFAULT_MAX_ITEMS,
      "work_batch.ranking.provenance": DEFAULT_RANKING.provenance,
      "work_batch.ranking.shared_area_label": DEFAULT_RANKING.sharedAreaLabel,
      "file_issue.sweep.move": sweepSettings({}).move,
      "resolve_conflicts.hotspot_min_merges": DEFAULT_HOTSPOT_MIN_MERGES,
      "review.reviewer_poll_max_seconds": DEFAULT_REVIEWER_POLL_MAX_SECONDS,
      "repository.remote": DEFAULT_REMOTE,
      "review.scanner_apps": DEFAULT_SCANNER_APPS,
      "specs.body_section": DEFAULT_BODY_SECTION,
      "specs.verification_section": DEFAULT_VERIFICATION_SECTION,
      "routing.raise.reviews": parseRouting({}, parseWorkTypes({})).raise
        .reviews,
      "verify.output_lines": DEFAULT_OUTPUT_LINES,
      "verify.timeout_minutes": DEFAULT_TIMEOUT_MINUTES,
      "verify.retention_days": DEFAULT_RETENTION_DAYS,
      "autonomy.level": DEFAULT_LEVEL,
      "dispatch.labels.enabled": DEFAULT_LABELS.enabled,
      "dispatch.labels.prefix": DEFAULT_LABELS.prefix,
      "dispatch.labels.only_labeled": DEFAULT_LABELS.onlyLabeled,
      "dispatch.adopt.enabled": dispatch.value.adopt.enabled,
      "dispatch.adopt.trusted_automation":
        dispatch.value.adopt.excludeTrusted !== true,
      "dispatch.overlap.max_per_file": dispatch.value.overlap?.maxPerFile,
      "dispatch.overlap.file_rate": dispatch.value.overlap?.fileRate,
      "dispatch.overlap.area_rate": dispatch.value.overlap?.areaRate,
      "dispatch.overlap.unknown_cost": dispatch.value.overlap?.unknownCost,
      "dispatch.reviewer_failures_before_escalation":
        dispatch.value.reviewerFailures?.threshold,
    });
  });

  test("docs.promoted_statuses accepts what the docs skill accepts", () => {
    const problems = (statuses: unknown[]) =>
      checkConfig({ docs: { promoted_statuses: statuses } }, schema).map(
        (f) => f.message,
      );
    expect(problems(["approved", "active"])).toEqual([]);
    for (const bad of [
      ["two words"],
      [" active"],
      ["active\n"],
      ["active", "active"],
    ])
      expect(problems(bad).length).toBeGreaterThan(0);
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

  test("bound the round ceiling and the wall-clock cap as the drive reads them", () => {
    expect(field("drive.max_total_rounds")?.min).toBe(1);
    expect(field("drive.max_total_rounds")?.max).toBe(MAX_TOTAL_ROUNDS_BOUND);
    expect(field("drive.max_wall_clock_hours")?.min).toBe(MIN_WALL_CLOCK_HOURS);
    const problems = (drive: Record<string, unknown>) =>
      checkConfig({ drive }, schema).map((f) => f.message);
    expect(
      problems({ max_total_rounds: 50, max_wall_clock_hours: 0.1 }),
    ).toEqual([]);
    expect(problems({ max_total_rounds: 51 }).join()).toContain(
      "drive.max_total_rounds",
    );
    expect(problems({ max_wall_clock_hours: 0 }).join()).toContain(
      "drive.max_wall_clock_hours",
    );
  });

  test("reject the drive.pass_args words the reading skill refuses, and accept the rest", () => {
    const fits = (word: string) => PASS_ARG_PATTERN.test(word);
    for (const refused of [
      ["--model", "opus"],
      ["--model=opus"],
      ["-p", "text"],
      ["--print"],
      ["--"],
    ]) {
      expect(refusedPassArgs(refused)).toBeDefined();
      expect(passArgsProblem(refused)).toBeDefined();
      expect(refused.every(fits)).toBe(false);
    }
    // The pattern cannot see an operand missing at the end of the list; the reading skill refuses it.
    expect(refusedPassArgs(["--permission-mode"])).toBeDefined();
    expect(passArgsProblem(["--permission-mode"])).toBeDefined();
    expect(fits("--permission-mode")).toBe(true);
    for (const accepted of [
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=auto"],
      ["--modelish"],
    ]) {
      expect(refusedPassArgs(accepted)).toBeUndefined();
      expect(passArgsProblem(accepted)).toBeUndefined();
      expect(accepted.every(fits)).toBe(true);
    }
    expect(passArgsProblem("--verbose")).toContain("must be a list of words");
  });

  test("reject the drive.codex_pass_args words the reading skill refuses wherever they stand, and accept the rest", () => {
    expect(
      schema.fields.find((f) => f.path === "drive.codex_pass_args")?.items,
    ).toEqual({ type: "string", pattern: CODEX_PASS_ARG_PATTERN.source });
    const fits = (word: string) => CODEX_PASS_ARG_PATTERN.test(word);
    for (const word of [
      "--",
      "-",
      "--model",
      "--model=x",
      "-m",
      "-mx",
      "--image",
      "--image=a.png",
      "-i",
      "--config=model=x",
      "-cmodel=x",
      "--dangerously-bypass-approvals-and-sandbox",
    ]) {
      expect(fits(word)).toBe(false);
      expect(codexPassArgsProblem([word])).toBeDefined();
    }
    for (const accepted of [
      ["--dangerously-bypass-hook-trust"],
      ["--sandbox", "workspace-write"],
      ["-c", "model_reasoning_effort=high"],
    ]) {
      expect(accepted.every(fits)).toBe(true);
      expect(codexPassArgsProblem(accepted)).toBeUndefined();
    }
  });

  test("report a host's own field in a repository's file once, whatever its value", () => {
    const ids = (value: unknown) =>
      checkConfig({ drive: { pass_args: value } }, schema).map((f) => [
        f.id,
        f.severity,
      ]);
    for (const value of [[], null, "--verbose", ["--permission-mode", "auto"]])
      expect(ids(value)).toEqual([["user-only:drive.pass_args", "error"]]);
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
    expect(severities({ drive: null })).toEqual([["null:drive", "error"]]);
    expect(severities({ routing: { model_tiers: null } })).toEqual([
      ["null:routing.model_tiers", "error"],
    ]);
    expect(severities({ routing: { stages: null } })).toEqual([
      ["null:routing.stages", "error"],
    ]);
    expect(severities({ review: null })).toEqual([]);
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

  test("accept the churn rounds the brake accepts: 0 or its range, never the hole", () => {
    const accepted = (value: number) =>
      checkConfig({ drive: { churn_rounds: value } }, schema).length === 0;
    expect(field("drive.churn_rounds")?.min).toBe(0);
    expect(field("drive.churn_rounds")?.max).toBe(MAX_CHURN_ROUNDS);
    expect(accepted(0)).toBe(true);
    expect(accepted(MIN_CHURN_ROUNDS - 1)).toBe(false);
    expect(accepted(MIN_CHURN_ROUNDS)).toBe(true);
    expect(accepted(MAX_CHURN_ROUNDS)).toBe(true);
    expect(accepted(MAX_CHURN_ROUNDS + 1)).toBe(false);
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
      [...LABEL_KEYS].sort(),
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
    const readerFile = (skill: string): string => {
      if (skill === "gc" || skill === "dispatch") return join(plugin, "jig.ts");
      if (skill === "evidence") return join(plugin, "shared", "evidence.ts");
      if (skill === "jig-gates")
        return join(repoRoot, "scripts", "dispatch-gates.ts");
      return join(plugin, "skills", skill, "SKILL.md");
    };
    for (const f of schema.fields)
      for (const skill of f.read_by)
        expect([f.path, skill, existsSync(readerFile(skill))]).toEqual([
          f.path,
          skill,
          true,
        ]);
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
  test("a number takes a fraction within its bounds", () => {
    const rate = parseSchema(withField({ type: "number", min: 0, max: 1 }));
    expect(checkConfig({ a: { b: 0.25 } }, rate)).toEqual([]);
    for (const bad of [1.5, -0.1, "0.5", Number.NaN])
      expect(
        checkConfig({ a: { b: bad } }, rate).map((f) => f.message),
      ).toEqual([expect.stringContaining("must be a number ≥ 0 and ≤ 1")]);
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

  test("a retired section is noted once, not refused or called unknown", () => {
    const retiring = parseSchema({
      ...withField({ type: "string" }),
      retired: { old: "nothing reads it" },
    });
    expect(
      checkConfig({ old: { anything: 1 }, a: { b: "x" } }, retiring),
    ).toEqual([
      {
        id: "retired:old",
        severity: "info",
        message: "old no longer has an effect: nothing reads it",
      },
    ]);
    expect(() =>
      parseSchema({ ...withField({ type: "string" }), retired: { old: 1 } }),
    ).toThrow("retired must map a section to a message");
    for (const retired of [{ a: "x" }, { "a.b": "x" }])
      expect(() =>
        parseSchema({ ...withField({ type: "string" }), retired }),
      ).toThrow("which the schema also declares");
  });
});

test("workspace_name is retired: a file that keeps it gets only a notice", () => {
  const findings = checkConfig(
    { workspace_name: { template: "{id} {status} {title}", statuses: {} } },
    schema,
  );
  expect(findings.map((f) => [f.id, f.severity])).toEqual([
    ["retired:workspace_name", "info"],
  ]);
});

test("dispatch.person accepts only usable recipient logins", () => {
  const pattern = field("dispatch.person")?.pattern;
  expect(pattern).toBeDefined();
  if (pattern === undefined) throw new Error("missing dispatch.person pattern");
  const login = new RegExp(pattern);
  for (const value of ["maintainer", "review-bot[bot]", "A1", "mona_acme"])
    expect(login.test(value)).toBe(true);
  for (const value of [
    "not a login",
    "@person",
    "team/person",
    "",
    "a".repeat(40),
  ])
    expect(login.test(value)).toBe(false);
});
