import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as proc from "../scripts/lib/proc.ts";
import { readTimeline, timelineEvents } from "../scripts/lib/pr-timeline.ts";

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function response(stdout: string, code = 0, stderr = "") {
  const calls = spyOn(proc, "ghCall");
  restore.push(() => calls.mockRestore());
  calls.mockResolvedValue({
    code,
    stdout,
    stderr,
    stderrTail: stderr,
    timedOut: false,
    bufferExceeded: false,
    spawnFailed: false,
  });
}

describe("timeline reads preserve their failure cause", () => {
  it("names the forge exit and authentication failure", async () => {
    response("", 1, "authentication required");
    const result = await readTimeline("123");
    expect(result).toEqual({
      ok: false,
      failure: {
        code: "unreadable",
        reason: "PR #123 timeline: gh api exited 1: authentication required",
      },
    });
    expect(await timelineEvents("123")).toBeNull();
  });
  it("names a JSON decode failure", async () => {
    response("{invalid");
    const result = await readTimeline("123");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failure.reason).toContain(
        "timeline JSON could not be decoded",
      );
    expect(await timelineEvents("123")).toBeNull();
  });
  it("names an invalid response shape", async () => {
    response("{}");
    expect(await readTimeline("123")).toEqual({
      ok: false,
      failure: {
        code: "unreadable",
        reason: "PR #123 timeline response is not a list of pages",
      },
    });
  });
  it("preserves the existing successful list interface", async () => {
    response('[[{"id":1}],[{"id":2}]]');
    expect(await timelineEvents("123")).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
