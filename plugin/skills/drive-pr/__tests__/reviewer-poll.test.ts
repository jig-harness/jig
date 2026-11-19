import { expect, it } from "bun:test";
import {
  DEFAULT_REVIEWER_POLL_MAX_SECONDS,
  reviewerPollSeconds,
} from "../scripts/lib/status/reviewer-poll.ts";

it("bounds the forge evaluations during the default 1800-second reviewer wait", () => {
  const interval = 30;
  let remaining = 1800;
  let previous = 0;
  let evaluations = 1;
  const waits: number[] = [];
  while (remaining > interval) {
    previous = reviewerPollSeconds(
      interval,
      DEFAULT_REVIEWER_POLL_MAX_SECONDS,
      previous,
      remaining * 1000,
    );
    waits.push(previous);
    remaining -= previous;
    evaluations += 1;
  }
  expect(waits.slice(0, 5)).toEqual([30, 60, 120, 240, 300]);
  expect(evaluations).toBeLessThanOrEqual(10);
});

it("respects the configured cap, the initial interval, and remaining budget", () => {
  expect(reviewerPollSeconds(30, 90, 60, 180_000)).toBe(90);
  expect(reviewerPollSeconds(30, 10, 30, 180_000)).toBe(30);
  expect(reviewerPollSeconds(30, 300, 240, 40_000)).toBe(39);
  expect(reviewerPollSeconds(30, 300, 240, 150_000)).toBe(149);
});
