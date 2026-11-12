import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { postAll } from "./send.tsx";

const to = { repo: "o/r", number: 7 };
const comments = [
  { key: "a", body: "answer a" },
  { key: "b", body: "answer b" },
  { key: "c", body: "answer c" },
];

function answers(...statuses: number[]) {
  const queue = [...statuses];
  return spyOn(globalThis, "fetch").mockImplementation((async () => {
    const status = queue.shift() ?? 201;
    return Response.json(
      status === 201
        ? { html_url: "https://github.com/o/r/pull/7#c" }
        : { message: "no" },
      { status },
    );
  }) as unknown as typeof fetch);
}

describe("posting a card's comments", () => {
  afterEach(() => {
    spyOn(globalThis, "fetch").mockRestore();
  });

  it("posts each comment and reports none refused", async () => {
    answers(201, 201, 201);
    const urls: string[] = [];
    const out = await postAll("t", to, comments, urls, () => true);
    expect(out).toEqual({
      refused: null,
      uncertain: false,
      uncertainKey: null,
    });
    expect(urls).toHaveLength(3);
  });

  it("names a certainly refused decision and the ones after it as not posted", async () => {
    answers(201, 422);
    const urls: string[] = [];
    const out = await postAll("t", to, comments, urls, () => true);
    expect(urls).toHaveLength(1);
    expect(out.uncertain).toBe(false);
    expect(out.refused).toContain("b was refused and not posted");
    expect(out.refused).toContain("not attempted: c");
    expect(out.refused).not.toContain("not attempted: b");
    expect(out.uncertainKey).toBeNull();
  });

  it("keeps an uncertain decision apart from those never attempted", async () => {
    answers(201, 502);
    const urls: string[] = [];
    const out = await postAll("t", to, comments, urls, () => true);
    expect(out.uncertain).toBe(true);
    expect(out.uncertainKey).toBe("b");
    expect(out.refused).toContain("b may or may not have been");
    expect(out.refused).toContain("not attempted: c");
    expect(out.refused).not.toContain("not attempted: b");
  });

  it("stops launching requests once the token is forgotten", async () => {
    const spy = answers(201, 201, 201);
    const urls: string[] = [];
    let live = true;
    const out = await postAll("t", to, comments, urls, () => {
      const was = live;
      live = false;
      return was;
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.refused).toContain("forgotten or replaced");
    expect(out.refused).toContain("b, c");
  });
});
