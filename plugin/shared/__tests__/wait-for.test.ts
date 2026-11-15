import { expect, test } from "bun:test";
import { waitFor } from "../wait-for.ts";

test("an already-aborted signal rejects with its reason without waiting", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cut"));
  const never = new Promise<never>(() => undefined);
  await expect(waitFor(never, controller.signal)).rejects.toThrow("cut");
});

test("an abort while pending rejects, and an answer resolves", async () => {
  const controller = new AbortController();
  const never = new Promise<never>(() => undefined);
  const waiting = waitFor(never, controller.signal);
  controller.abort(new Error("later"));
  await expect(waiting).rejects.toThrow("later");
  expect(await waitFor(Promise.resolve(3), new AbortController().signal)).toBe(
    3,
  );
});

test("an already-aborted signal still observes the pending rejection", async () => {
  const unhandled: unknown[] = [];
  const catcher = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", catcher);
  try {
    const controller = new AbortController();
    controller.abort(new Error("cut"));
    await expect(
      waitFor(Promise.reject(new Error("request failed")), controller.signal),
    ).rejects.toThrow("cut");
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", catcher);
  }
});
