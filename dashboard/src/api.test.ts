import { describe, expect, it } from "bun:test";
import { fixture } from "../fixtures.ts";
import {
  answerOf,
  isRowsAnswer,
  isStateAnswer,
  ReadRejected,
  readState,
  resultOf,
} from "./api.ts";

const STATE = {
  now: "2026-11-03T16:47:30.000Z",
  timeZone: "UTC",
  plugin: "0.0.0",
  schema: 3,
  line: fixture("quiet").line,
};

describe("what a guard admits", () => {
  it("refuses a state whose parts the page would throw on", () => {
    expect(isStateAnswer({ ...STATE, timeZone: "invalid" })).toBe(false);
    expect(isStateAnswer({ ...STATE, now: "x" })).toBe(false);
    expect(isStateAnswer({ ...STATE, line: {} })).toBe(false);
    expect(isStateAnswer({ ...STATE, line: null })).toBe(true);
    expect(isStateAnswer(STATE)).toBe(true);
  });

  it("takes a zone the formatter accepts, listed or not, and refuses one it rejects", () => {
    expect(isStateAnswer({ ...STATE, timeZone: "Etc/GMT+5" })).toBe(true);
    expect(isStateAnswer({ ...STATE, timeZone: "Not/AZone" })).toBe(false);
  });

  it("refuses a line whose links the page reads outside its panels and cannot", () => {
    const line = {
      ...STATE.line,
      queue: [{ url: { toString: null } }],
    };
    expect(isStateAnswer({ ...STATE, line })).toBe(false);
    expect(
      isStateAnswer({
        ...STATE,
        line: { ...STATE.line, queue: [{ url: null }] },
      }),
    ).toBe(true);
  });

  it("refuses rows with null counts, null options or entries that are not rows", () => {
    expect(isRowsAnswer({})).toBe(false);
    expect(isRowsAnswer({ counts: null, options: null, rows: [null] })).toBe(
      false,
    );
  });
});

describe("what an answer means", () => {
  it("is the answer, for a value this page reads", () => {
    expect(resultOf(200, { ok: true, value: STATE }, isStateAnswer)).toEqual({
      kind: "answer",
      value: STATE,
    });
  });

  it("is refused for a 403 token-refused", () => {
    expect(
      resultOf(
        403,
        { ok: false, failure: { code: "token-refused", reason: "needs it" } },
        isStateAnswer,
      ),
    ).toEqual({ kind: "refused", reason: "needs it" });
  });

  it("is a coded failure for any other code, with its reason", () => {
    expect(
      resultOf(
        503,
        {
          ok: false,
          failure: { code: "log-unreadable", reason: "cannot read" },
        },
        isRowsAnswer,
      ),
    ).toEqual({
      kind: "failed",
      code: "log-unreadable",
      reason: "cannot read",
    });
    expect(
      resultOf(
        500,
        { ok: false, failure: { code: "defect", reason: "a bug" } },
        isRowsAnswer,
      ),
    ).toMatchObject({ kind: "failed", code: "defect" });
  });

  it("is not a refusal for that code on another status", () => {
    expect(
      resultOf(
        500,
        { ok: false, failure: { code: "token-refused", reason: "odd" } },
        isStateAnswer,
      ),
    ).toMatchObject({ kind: "failed", code: "token-refused" });
  });

  it("is unreadable for anything else", () => {
    for (const body of [
      null,
      "text",
      {},
      { ok: true },
      { ok: true, value: { now: "x" } },
      { ok: false },
      { ok: false, failure: { code: 1 } },
    ])
      expect(resultOf(200, body, isStateAnswer)).toMatchObject({
        kind: "failed",
        code: "answer-unreadable",
      });
  });
});

describe("a read", () => {
  const realFetch = globalThis.fetch;

  async function withFetch<T>(
    fake: typeof fetch,
    work: () => Promise<T>,
  ): Promise<T> {
    globalThis.fetch = fake;
    try {
      return await work();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("is gone when the fetch itself fails", async () => {
    const fake = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    expect(await withFetch(fake, () => readState("t"))).toEqual({
      kind: "gone",
    });
  });

  it("is unreadable for a body that is not JSON", async () => {
    const fake = (async () =>
      new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await withFetch(fake, () => readState("t"))).toMatchObject({
      kind: "failed",
      code: "answer-unreadable",
    });
  });

  it("asks with the token encoded", async () => {
    let asked = "";
    const fake = (async (url: string) => {
      asked = url;
      return Response.json({ ok: true, value: STATE });
    }) as unknown as typeof fetch;
    await withFetch(fake, () => readState("a b&c"));
    expect(asked).toBe("/state?token=a%20b%26c");
  });
});

describe("the one crossing into a rejection", () => {
  it("passes an answer through", () => {
    expect(answerOf({ kind: "answer", value: 1 })).toBe(1);
  });

  it("carries the failure value in its error", () => {
    let caught: unknown;
    try {
      answerOf({ kind: "failed", code: "c", reason: "r" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReadRejected);
    expect((caught as ReadRejected).failure).toEqual({
      kind: "failed",
      code: "c",
      reason: "r",
    });
  });
});
