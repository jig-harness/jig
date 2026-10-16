import { describe, expect, test } from "bun:test";
import {
  DecodeError,
  decodeJson,
  field,
  isRecord,
  isString,
  isStringArray,
} from "../guards.ts";

describe("the guards", () => {
  test("isRecord accepts objects and rejects arrays, null and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    for (const value of [[], null, undefined, "x", 1, true])
      expect(isRecord(value)).toBe(false);
  });

  test("isStringArray accepts only arrays of strings", () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(["a", "b"])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringArray("a")).toBe(false);
  });

  test("field returns a value its guard accepts and names the key otherwise", () => {
    expect(field({ a: "x" }, "a", isString)).toBe("x");
    expect(() => field({ a: 1 }, "a", isString)).toThrow(
      "$.a is a number, which isString rejects",
    );
    expect(() => field({}, "a", isString)).toThrow("$.a is missing");
  });
});

describe("decodeJson", () => {
  type State = { state: string; labels: string[] };
  const isState = (v: unknown): v is State =>
    isRecord(v) &&
    field(v, "state", isString) !== undefined &&
    field(v, "labels", isStringArray) !== undefined;

  test("returns the narrowed value", () => {
    const value = decodeJson(
      '{"state":"open","labels":["a"]}',
      isState,
      "gh pr view",
    );
    expect(value.state).toBe("open");
    expect(value.labels).toEqual(["a"]);
  });

  test("names the input and the failing field", () => {
    let caught: unknown;
    try {
      decodeJson('{"state":"open","labels":[1]}', isState, "gh pr view");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    const err = caught as DecodeError;
    expect(err.what).toBe("gh pr view");
    expect(err.path).toBe("$.labels");
    expect(err.message).toBe(
      "gh pr view: $.labels is an array, which isStringArray rejects",
    );
  });

  test("names the whole path of a nested field, keeping the inner error as the cause", () => {
    const isPull = (v: unknown): v is { state: string } =>
      isRecord(v) && field(v, "state", isString) !== undefined;
    const isNode = (v: unknown): v is { pullRequest: { state: string } } =>
      isRecord(v) && field(v, "pullRequest", isPull) !== undefined;
    let caught: unknown;
    try {
      decodeJson('{"pullRequest":{"state":7}}', isNode, "gh api graphql");
    } catch (err) {
      caught = err;
    }
    const err = caught as DecodeError;
    expect(err).toBeInstanceOf(DecodeError);
    expect(err.path).toBe("$.pullRequest.state");
    expect(err.message).toBe(
      "gh api graphql: $.pullRequest.state is a number, which isString rejects",
    );
    expect(err.cause).toBeInstanceOf(DecodeError);
  });

  test("describes an object with the right article", () => {
    expect(() => field({ a: {} }, "a", isString)).toThrow(
      "$.a is an object, which isString rejects",
    );
  });

  test("names the input when the whole value is rejected", () => {
    expect(() => decodeJson("[1]", isRecord, "the cache entry")).toThrow(
      "the cache entry: $ is an array, which isRecord rejects",
    );
  });

  test("keeps the parser's error as the cause of text that is not JSON", () => {
    let caught: unknown;
    try {
      decodeJson("{not json", isRecord, "the cache entry");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    const err = caught as DecodeError;
    expect(err.path).toBe("$");
    expect(err.message).toStartWith("the cache entry: $ is not JSON (");
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  test("lets an error that is not a decoding failure through", () => {
    const boom = (_: unknown): _ is never => {
      throw new RangeError("boom");
    };
    expect(() => decodeJson("1", boom, "x")).toThrow(RangeError);
  });
});
