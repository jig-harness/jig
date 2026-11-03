/**
 * The recorded run the home page walks through (website/src/data/walkthrough.yaml):
 * one pull request of Jig's own, from the first push to the follow-up, each
 * event at the station of the line it happened at, with who acted and where
 * it is written down. The parser refuses an event at a station the factory
 * does not have, an actor the page cannot draw, events out of time order, and
 * a run without its date or its pull request, so the file cannot drift from
 * FACTORY.md without failing the build.
 */
import { parse } from "yaml";

/** Who acted: a coding agent, a person, the dispatcher, or a plugin skill by name. */
export type WalkActor =
  | { kind: "agent" }
  | { kind: "person" }
  | { kind: "dispatcher" }
  | { kind: "skill"; name: string };

export interface WalkEvent {
  /** When it happened, UTC, to the minute: `2026-11-02T14:27Z`. */
  at: string;
  /** The end of a stretch of events told as one, when it is one. */
  until?: string;
  /** The station of the line, as FACTORY.md names it. */
  station: string;
  by: WalkActor;
  what: string;
  /** Where the event is written down. */
  record: string;
  /** A second pull request the event made, when it made one. */
  link?: string;
}

export interface Walkthrough {
  /** The run's date, `YYYY-MM-DD`. */
  date: string;
  pr: { number: number; url: string; change: string };
  events: WalkEvent[];
}

/** walkthrough.yaml does not hold a run the page can draw. */
class WalkthroughError extends Error {}

const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;
const PR_URL = /^https:\/\/github\.com\/jig-harness\/jig\/pull\/(\d+)$/;
const NAMED = new Set(["agent", "person", "dispatcher"]);

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new WalkthroughError(`walkthrough.yaml: ${where} is missing`);
  return value.trim();
}

function minute(value: unknown, where: string): string {
  const at = text(value, where);
  if (!MINUTE.test(at))
    throw new WalkthroughError(
      `walkthrough.yaml: ${where} is ${JSON.stringify(at)}, not a UTC time to the minute`,
    );
  return at;
}

function actor(
  value: unknown,
  where: string,
  skills: ReadonlySet<string>,
): WalkActor {
  const by = text(value, where);
  if (NAMED.has(by)) return { kind: by as "agent" | "person" | "dispatcher" };
  if (skills.has(by)) return { kind: "skill", name: by };
  throw new WalkthroughError(
    `walkthrough.yaml: ${where} is ${JSON.stringify(by)}, which is neither agent, person, dispatcher nor a plugin skill`,
  );
}

/**
 * Read the run. `stations` are the names of the line's stations (from
 * FACTORY.md's parser), `skills` the plugin's skill names.
 */
export function parseWalkthrough(
  yaml: string,
  stations: readonly string[],
  skills: ReadonlySet<string>,
): Walkthrough {
  const doc = parse(yaml) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object")
    throw new WalkthroughError("walkthrough.yaml: not a map");
  const date = text(doc.date, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new WalkthroughError(
      `walkthrough.yaml: date is ${JSON.stringify(date)}, not YYYY-MM-DD`,
    );
  const pr = (doc.pr ?? {}) as Record<string, unknown>;
  const url = text(pr.url, "pr.url");
  const number = PR_URL.exec(url)?.[1];
  if (!number || Number(number) !== pr.number)
    throw new WalkthroughError(
      `walkthrough.yaml: pr.url ${url} is not pull request ${String(pr.number)} of jig-harness/jig`,
    );
  if (!Array.isArray(doc.events) || doc.events.length === 0)
    throw new WalkthroughError("walkthrough.yaml: the run has no events");
  let last = "";
  const events = doc.events.map(
    (raw: Record<string, unknown>, i: number): WalkEvent => {
      const where = `event ${i + 1}`;
      const station = text(raw.station, `${where}.station`);
      if (!stations.includes(station))
        throw new WalkthroughError(
          `walkthrough.yaml: ${where} is at ${JSON.stringify(station)}, which is not a station of the line (${stations.join(", ")})`,
        );
      const at = minute(raw.at, `${where}.at`);
      const until =
        raw.until === undefined
          ? undefined
          : minute(raw.until, `${where}.until`);
      if (at < last || (until !== undefined && until < at))
        throw new WalkthroughError(
          `walkthrough.yaml: ${where} at ${at} is out of time order`,
        );
      last = until ?? at;
      const link =
        raw.link === undefined ? undefined : text(raw.link, `${where}.link`);
      if (link !== undefined && !PR_URL.test(link))
        throw new WalkthroughError(
          `walkthrough.yaml: ${where}.link ${link} is not a pull request of jig-harness/jig`,
        );
      return {
        at,
        ...(until ? { until } : {}),
        station,
        by: actor(raw.by, `${where}.by`, skills),
        what: text(raw.what, `${where}.what`),
        record: text(raw.record, `${where}.record`),
        ...(link ? { link } : {}),
      };
    },
  );
  if (!events[0]?.at.startsWith(date))
    throw new WalkthroughError(
      `walkthrough.yaml: the run's date ${date} is not the day its first event happened`,
    );
  return {
    date,
    pr: { number: Number(number), url, change: text(pr.change, "pr.change") },
    events,
  };
}
