/**
 * The standard input of the store contract's operations, read the same way
 * by every built-in store.
 */
import { readStdinAll } from "../../../../shared/cli.ts";
import {
  jsonlLines,
  parseEvent,
  parseObject,
  type ReflectionEvent,
} from "./events.ts";

export interface InputEvent {
  event: ReflectionEvent;
  /** The line as received, which a store keeps byte for byte. */
  text: string;
}

/**
 * The events an `append` was given, or what is wrong with the first line
 * that is not one: a store refuses the whole input before writing any of it.
 */
export async function appendInput(): Promise<
  { events: InputEvent[] } | { problem: string }
> {
  const events: InputEvent[] = [];
  for (const [index, text] of jsonlLines(await readStdinAll()).entries()) {
    try {
      events.push({ event: parseEvent(text), text });
    } catch (error) {
      return {
        problem: `line ${index + 1} is not a reflection event: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { events };
}

/** The time a `list` was asked to start at, or null for every event. */
export async function sinceInput(): Promise<string | null> {
  const input = (await readStdinAll()).trim();
  if (input === "") return null;
  const query = parseObject(input, "the list query");
  if (query.since === undefined || query.since === null) return null;
  if (typeof query.since !== "string") throw new Error("since must be a time");
  return query.since;
}
