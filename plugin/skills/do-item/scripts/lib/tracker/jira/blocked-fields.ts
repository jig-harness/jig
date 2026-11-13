/**
 * The fields a blocked item carries on Jira (`issue_tracker.jira.blocked_fields`):
 * each configured role resolved to exactly one field of the site, and the
 * value written to it in the form its type takes. The reason goes into a
 * text field (a paragraph's document for a multi-line one); the start goes
 * into a date, a date-time or a text field. Clearing writes `null` to each.
 * A field of any other type is refused before anything is written.
 */
import { TrackerConfigError } from "../config-error.ts";
import { type BlockedFields, TrackerRequestError } from "../port.ts";
import { markdownToAdf } from "./adf.ts";
import { fieldsNamed, type SiteField } from "./facets.ts";
import {
  BLOCKED_FIELD_ROLES,
  type BlockedFieldNames,
  type BlockedFieldRole,
} from "./settings.ts";

/** A configured blocked field, resolved against the site. */
export interface BlockedField {
  role: BlockedFieldRole;
  id: string;
  name: string;
  schema: unknown;
}

/** Each configured role's field, by id first, then by name; refused unless exactly one matches. */
export function resolveBlockedFields(
  names: BlockedFieldNames,
  all: ReadonlyArray<SiteField>,
): BlockedField[] {
  const out: BlockedField[] = [];
  for (const role of BLOCKED_FIELD_ROLES) {
    const configured = names[role];
    if (configured === null) continue;
    const at = `issue_tracker.jira.blocked_fields.${role}`;
    const matches = fieldsNamed(all, configured);
    if (matches.length !== 1)
      throw new TrackerConfigError(
        at,
        `${at}: '${configured}' matches ${matches.length} fields of the site${matches.length > 1 ? ` (${matches.map((f) => f.id).join(", ")}); name the field by its id` : ""}, expected exactly 1`,
      );
    const f = matches[0] as SiteField;
    const same = out.find((o) => o.id === f.id);
    if (same !== undefined)
      throw new TrackerConfigError(
        at,
        `${at}: '${configured}' is field ${f.id}, which issue_tracker.jira.blocked_fields.${same.role} names too; the reason and the start need different fields`,
      );
    out.push({ role, id: f.id, name: f.name, schema: f.schema });
  }
  return out;
}

/** The longest value a single-line Jira text field holds. */
const TEXT_MAX = 255;

/** A field's type and its custom kind, as the site describes it. */
function kindOf(schema: unknown): { type: string; custom: string } {
  const s = (schema ?? {}) as { type?: unknown; custom?: unknown };
  return {
    type: typeof s.type === "string" ? s.type : "",
    custom: typeof s.custom === "string" ? s.custom : "",
  };
}

/** Jira's date-time form: `2026-11-11T09:30:00.000+0000`. */
function jiraDateTime(iso: string): string {
  return new Date(iso).toISOString().replace("Z", "+0000");
}

/** Refuse a field whose type the role cannot be written to, or cleared from. */
function checkType(field: BlockedField, type: string): void {
  const dated =
    field.role === "since" && (type === "date" || type === "datetime");
  if (type === "string" || dated) return;
  throw new TrackerRequestError(
    "invalid",
    `issue_tracker.jira.blocked_fields.${field.role} names '${field.name}', a ${type || "untyped"} field; the ${field.role} needs a text${field.role === "since" ? ", date or date-time" : ""} field`,
  );
}

/** A text field's form of `text`: ADF for a rich field, else one line cut to the field's length. */
function textValue(custom: string, text: string): unknown {
  if (custom.endsWith(":textarea")) return markdownToAdf(text);
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

/** The value `field` is given: `value`'s part for its role in the form its type takes, or `null` to clear it. */
export function blockedFieldValue(
  field: BlockedField,
  value: BlockedFields | null,
): unknown {
  const { type, custom } = kindOf(field.schema);
  checkType(field, type);
  if (value === null) return null;
  if (type === "string")
    return textValue(
      custom,
      field.role === "reason" ? value.reason : value.since,
    );
  return type === "date" ? value.since.slice(0, 10) : jiraDateTime(value.since);
}

/** The fields of one write: each resolved field's value. */
export function blockedFieldsBody(
  fields: ReadonlyArray<BlockedField>,
  value: BlockedFields | null,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => [f.id, blockedFieldValue(f, value)]),
  );
}

/** The blocked fields a move into `blocked` sends, and those left for the update after it. */
export interface ScreenSplit {
  /** The fields the transition's screen carries, each with a value it takes. */
  sent: BlockedField[];
  /** The request's `fields`: each sent field's value. */
  body: Record<string, unknown>;
  /** The fields the screen does not carry. */
  offScreen: BlockedField[];
  /** The fields on the screen whose value could not be formed; the update after the move reports why. */
  unformed: BlockedField[];
}

/** Split the configured fields by the transition's screen (`screen`, its field ids). */
export function splitForScreen(
  fields: ReadonlyArray<BlockedField>,
  screen: ReadonlyArray<string>,
  value: BlockedFields,
): ScreenSplit {
  const out: ScreenSplit = { sent: [], body: {}, offScreen: [], unformed: [] };
  for (const f of fields) {
    if (!screen.includes(f.id)) {
      out.offScreen.push(f);
      continue;
    }
    try {
      out.body[f.id] = blockedFieldValue(f, value);
      out.sent.push(f);
    } catch {
      out.unformed.push(f);
    }
  }
  return out;
}

/** Which blocked fields went with a move into `blocked`, as a refusal names them. */
export function sentWithMove(
  split: ScreenSplit,
  unresolved: string | null,
): string {
  const named = (fs: BlockedField[]) =>
    fs.map((f) => `${f.role} (${f.name})`).join(", ");
  return [
    `sent with it: ${split.sent.length > 0 ? named(split.sent) : "none"}`,
    ...(split.offScreen.length > 0
      ? [`not on its screen: ${named(split.offScreen)}`]
      : []),
    ...(split.unformed.length > 0
      ? [`not of a type the role takes: ${named(split.unformed)}`]
      : []),
    ...(unresolved === null
      ? []
      : [`issue_tracker.jira.blocked_fields did not resolve (${unresolved})`]),
  ].join("; ");
}
