/**
 * The converged CI wait's line (`lib/driver/wait-line.ts`): printed when the
 * wait starts and when what it waits for changes, never on every poll.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  nextWaitPoll,
  sayWaiting,
  type WaitLines,
} from "../scripts/lib/driver/wait-line.ts";

let printed: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  printed = [];
  errorSpy = spyOn(console, "error").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

/** One convergence poll that waits on `key`, or does not wait (`null`). */
function poll(state: WaitLines, key: string | null): void {
  nextWaitPoll(state);
  if (key !== null) sayWaiting(state, `waiting on ${key}`, key);
}

describe("the converged CI wait line", () => {
  test("prints once over a wait's polls", () => {
    const state: WaitLines = {};
    for (let i = 0; i < 30; i++) poll(state, "abc failing: gates");
    expect(printed).toEqual(["waiting on abc failing: gates"]);
  });

  test("prints again when what the wait waits for changes", () => {
    const state: WaitLines = {};
    poll(state, "abc failing: gates");
    poll(state, "abc failing: gates");
    poll(state, "abc failing: gates, tests");
    poll(state, "abc failing: gates, tests");
    poll(state, "def failing: gates, tests");
    expect(printed).toEqual([
      "waiting on abc failing: gates",
      "waiting on abc failing: gates, tests",
      "waiting on def failing: gates, tests",
    ]);
  });

  test("prints again when the same wait starts after a poll that did not wait", () => {
    const state: WaitLines = {};
    poll(state, "abc failing: gates");
    poll(state, null);
    poll(state, "abc failing: gates");
    expect(printed).toEqual([
      "waiting on abc failing: gates",
      "waiting on abc failing: gates",
    ]);
  });

  test("keys on the line itself when no key is given", () => {
    const state: WaitLines = {};
    nextWaitPoll(state);
    sayWaiting(state, "the same line");
    nextWaitPoll(state);
    sayWaiting(state, "the same line");
    expect(printed).toEqual(["the same line"]);
  });
});
