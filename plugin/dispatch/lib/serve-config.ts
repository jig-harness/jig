/** People this host serves, read only from its machine file. */
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

const TRACKERS = ["github", "linear", "jira"] as const;
export interface ServedPerson {
  name: string;
  forge: string[];
  tracker: Partial<Record<(typeof TRACKERS)[number], string>>;
}

type Checked<T> = Outcome<T, "invalid">;
const invalid = (reason: string): Checked<never> => failed("invalid", reason);
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Strict host-only configuration: identities cannot ambiguously name two people. */
export function servedPeople(value: unknown): Checked<ServedPerson[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return invalid("serve must be a list");
  const people: ServedPerson[] = [];
  const names = new Set<string>();
  const logins = new Set<string>();
  const identities = new Set<string>();
  for (const [i, item] of value.entries()) {
    const where = `serve[${i}]`;
    const named = personName(item, where, names);
    if (!named.ok) return named;
    const { name, fields } = named.value;
    const readForge = forgeLogins(fields.forge, where, logins);
    if (!readForge.ok) return readForge;
    const forge = readForge.value;
    const readTracker = trackerIdentities(fields.tracker, where, identities);
    if (!readTracker.ok) return readTracker;
    const tracker = readTracker.value;
    people.push({ name, forge, tracker });
  }
  return ok(people);
}

function trackerIdentities(
  value: unknown,
  where: string,
  identities: Set<string>,
): Checked<ServedPerson["tracker"]> {
  if (!isMapping(value)) return invalid(`${where}.tracker must be a mapping`);
  const tracker: ServedPerson["tracker"] = {};
  for (const [adapter, identity] of Object.entries(value)) {
    if (!(TRACKERS as readonly string[]).includes(adapter))
      return invalid(`${where}.tracker has unknown tracker: ${adapter}`);
    if (!text(identity))
      return invalid(`${where}.tracker.${adapter} must be a nonempty string`);
    const normalized = identity.trim();
    const key = `${adapter}:${normalized.toLowerCase()}`;
    if (identities.has(key))
      return invalid(`${where}.tracker identity is listed twice: ${key}`);
    identities.add(key);
    tracker[adapter as keyof ServedPerson["tracker"]] = normalized;
  }
  if (Object.keys(tracker).length === 0)
    return invalid(`${where}.tracker must name at least one tracker identity`);
  return ok(tracker);
}

function forgeLogins(
  value: unknown,
  where: string,
  logins: Set<string>,
): Checked<string[]> {
  if (!Array.isArray(value) || !value.every(text))
    return invalid(`${where}.forge must list nonempty forge logins`);
  const forge = value.map((login) => login.trim());
  for (const login of forge) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login))
      return invalid(`${where}.forge has an invalid login: ${login}`);
    if (logins.has(login.toLowerCase()))
      return invalid(`${where}.forge login is listed twice: ${login}`);
    logins.add(login.toLowerCase());
  }
  return ok(forge);
}

function personName(
  item: unknown,
  where: string,
  names: Set<string>,
): Checked<{ name: string; fields: Record<string, unknown> }> {
  if (!isMapping(item)) return invalid(`${where} must be a mapping`);
  const unknown = Object.keys(item).filter(
    (key) => !["name", "forge", "tracker"].includes(key),
  );
  if (unknown.length > 0)
    return invalid(`${where} has unknown key(s): ${unknown.join(", ")}`);
  if (!text(item.name))
    return invalid(`${where}.name must be a nonempty string`);
  const name = item.name.trim();
  if (names.has(name.toLowerCase()))
    return invalid(`${where}.name is listed twice: ${name}`);
  names.add(name.toLowerCase());
  return ok({ name, fields: item });
}
