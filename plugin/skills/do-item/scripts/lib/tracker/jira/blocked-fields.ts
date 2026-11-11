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

/** The value `field` is given: `value`'s part for its role in the form its type takes, or `null` to clear it. */
export function blockedFieldValue(
  field: BlockedField,
  value: BlockedFields | null,
): unknown {
  if (value === null) return null;
  const { type, custom } = kindOf(field.schema);
  const text = field.role === "reason" ? value.reason : value.since;
  if (type === "string")
    return custom.endsWith(":textarea")
      ? markdownToAdf(text)
      : text.length > TEXT_MAX
        ? `${text.slice(0, TEXT_MAX - 1)}…`
        : text;
  if (field.role === "since" && type === "date")
    return value.since.slice(0, 10);
  if (field.role === "since" && type === "datetime")
    return jiraDateTime(value.since);
  throw new TrackerRequestError(
    "invalid",
    `issue_tracker.jira.blocked_fields.${field.role} names '${field.name}', a ${type || "untyped"} field; the ${field.role} needs a text${field.role === "since" ? ", date or date-time" : ""} field`,
  );
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
