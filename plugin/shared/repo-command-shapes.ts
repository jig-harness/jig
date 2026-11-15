/** JSON outputs that callers read from commands a repository supplies. */
import { type Infer, s } from "./shapes.ts";

const text = () => s.string({ pattern: "\\S" });

export const CLASSIFY_KINDS = [
  "code",
  "test",
  "docs",
  "config",
  "data",
  "generated",
  "fixture",
  "asset",
  "vendored",
  "other",
] as const;

/** One line of code_stats.classify_command; area names are checked against the repository's catalog. */
export const CLASSIFY_OUTPUT_SHAPE = s.object(
  {
    path: s.string(),
    area: s.optional(s.string()),
    kind: s.optional(s.enum(CLASSIFY_KINDS)),
    language: s.optional(text()),
    module: s.optional(text()),
  },
  { additionalProperties: false },
);

/**
 * The part of drive.validation_plan_command that its reader requires.
 * Other plan fields are passed through: this preserves repositories whose
 * JSON-mode output carries their own fields and values.
 */
export const VALIDATION_PLAN_SHAPE = s.object({
  validation: s.object({ testbox: s.object({ required: s.boolean() }) }),
});
export type ValidationPlan = Infer<typeof VALIDATION_PLAN_SHAPE>;

/**
 * A reflection store's check response. Existing readers accept any object:
 * only literal true means ok, and only string reason/fix fields are shown.
 */
export const REFLECTION_CHECK_SHAPE = s.object({
  ok: s.optional(s.unknown()),
  reason: s.optional(s.unknown()),
  fix: s.optional(s.unknown()),
});
/** A field is acted on only when it has the type the operation understands. */
export const REFLECTION_CHECK_FIELDS = {
  ok: s.literal(true),
  reason: s.string(),
  fix: s.string(),
} as const;
/** An append entry is used only when it names an id; an unrecognized ref becomes null. */
export const REFLECTION_STORED_SHAPE = s.object({ id: s.string() });
/** Existing readers ignore an absent/non-array stored field and unrecognized entries. */
export const REFLECTION_APPEND_SHAPE = s.object({
  stored: s.optional(s.unknown()),
});
/** Diagnose notices are JSON objects whose fields are specific to the store. */
export const REFLECTION_DIAGNOSE_SHAPE = s.object({});

export const COMMAND_OUTPUT_SHAPES = {
  "validation-plan": VALIDATION_PLAN_SHAPE,
  "classify-output": CLASSIFY_OUTPUT_SHAPE,
  "reflection-check": REFLECTION_CHECK_SHAPE,
  "reflection-append": REFLECTION_APPEND_SHAPE,
  "reflection-diagnose": REFLECTION_DIAGNOSE_SHAPE,
} as const;
