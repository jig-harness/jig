import { failureLine } from "../scripts/lib/pace.ts";
import { describe, expect, it } from "bun:test";
import { pacedWriter, WriteRefused } from "../scripts/lib/pace.ts";
import {
  sweep,
  sweepComment,
  sweepLines,
  sweepMarker,
} from "../scripts/lib/sweep.ts";
import {
  FakeRepo,
  facetsFor,
  fakeClock,
  LABEL_SECTION,
  labelled,
  NATIVE_SECTION,
} from "./fake-repo.ts";

const none = () => [];

/** A repository on labels: complete issues, and incomplete ones in every state. */
function setup() {
  const repo = new FakeRepo();
  for (let n = 1; n <= 6; n++)
    repo.add(`#${n}`, { labels: labelled("bug", "high", "small") });
  repo.add("#10", { labels: ["bug", "small"] }); // no priority
  repo.add("#11", { labels: ["feature", "priority: low"] }); // no size
  repo.add("#12", { labels: ["epic", "feature", "priority: low"] }); // an epic needs none
  repo.add("#13", { state: "started", labels: ["priority: low", "xs"] }); // no type, started
  repo.add("#14", { state: "triage", labels: [] }); // in triage: not read again
  repo.add("#15", { state: "unstarted", labels: ["docs", "xs"] }); // no priority
  repo.add("#16", { state: "closed", labels: [] });
  return repo;
}

describe("the weekly sweep", () => {
  it("reports each incomplete issue by key, and writes nothing without --yes", async () => {
    const repo = setup();
    const { tracker } = repo.view(LABEL_SECTION);
    const report = await sweep(tracker, {
      apply: false,
      retired: none,
      writer: pacedWriter(fakeClock()),
    });
    expect(report.listed.map((i) => [i.identifier, i.missing])).toEqual([
      ["#10", ["priority"]],
      ["#11", ["size"]],
      ["#15", ["priority"]],
    ]);
    expect(report.started.map((i) => [i.identifier, i.missing])).toEqual([
      ["#13", ["type"]],
    ]);
    expect(report.counts.priority).toEqual({ required: 11, lacking: 2 });
    expect(repo.writes).toEqual([]);
    const text = sweepLines(report).join("\n");
    expect(text).toContain("#10  state backlog  missing priority");
    expect(text).not.toContain("title of");
  });

  it("moves each one not yet started to triage once, commenting first, and lists the started ones", async () => {
    const repo = setup();
    const { tracker } = repo.view(LABEL_SECTION);
    const writer = pacedWriter(fakeClock());
    const report = await sweep(tracker, { apply: true, retired: none, writer });
    expect(report.moved).toEqual(["#10", "#11", "#15"]);
    expect(repo.get("#10").state).toBe("triage");
    expect(repo.get("#13").state).toBe("started");
    expect(repo.get("#10").comments).toEqual([
      sweepComment(report.listed[0] as (typeof report.listed)[0]),
    ]);
    expect(repo.get("#10").comments[0]).toStartWith(
      "<!-- jig:issue-fields missing=priority -->\n",
    );
    expect(repo.writes.map((w) => `${w.kind} ${w.key}`)).toEqual([
      "comment #10",
      "transition #10",
      "comment #11",
      "transition #11",
      "comment #15",
      "transition #15",
    ]);
    const again = await sweep(tracker, { apply: true, retired: none, writer });
    expect(again.listed).toEqual([]);
    expect(repo.writes).toHaveLength(6);
  });

  it("stops at its caps and reports what remains", async () => {
    const repo = setup();
    const { tracker } = repo.view(LABEL_SECTION);
    const report = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(fakeClock()),
      limits: { pages: 1, pageSize: 2, moves: 1 },
    });
    expect(report.readCapped).toBe(true);
    expect(report.listed.map((i) => i.identifier)).toEqual(["#10", "#11"]);
    expect(report.moved).toEqual(["#10"]);
    expect(sweepLines(report).slice(-2)).toEqual([
      "moved 1 to triage (1 commented on); 1 remain, and more past the read's page cap",
      "the next run moves what remains past this run's cap",
    ]);
    // The next run starts from the issues still outside triage.
    const next = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(fakeClock()),
      limits: { pages: 1, pageSize: 2, moves: 1 },
    });
    expect(next.moved).toEqual(["#11"]);
  });

  it("stops at a refused write, and a later run moves the issue without a second comment", async () => {
    const repo = setup();
    const { tracker } = repo.view(LABEL_SECTION);
    repo.refuse = (w) =>
      w.kind === "transition" && w.key === "#10"
        ? Object.assign(new Error("Resource not accessible by integration"), {
            status: 403,
          })
        : null;
    const report = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(fakeClock()),
    });
    expect(report.moved).toEqual([]);
    expect(report.commented).toEqual(["#10"]);
    expect(report.stopped).toBe("move #10 to triage: refused (HTTP 403)");
    const lines = sweepLines(report);
    expect(lines).toContain("moved 0 to triage (1 commented on); 3 remain");
    expect(lines.at(-1)).toBe(
      "stopped: move #10 to triage: refused (HTTP 403)",
    );
    repo.refuse = () => null;
    const progress: string[] = [];
    const next = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(fakeClock()),
      progress: (line) => progress.push(line),
    });
    expect(next.moved).toEqual(["#10", "#11", "#15"]);
    expect(next.commented).toEqual(["#11", "#15"]);
    expect(repo.get("#10").comments).toHaveLength(1);
    expect(progress).toEqual([
      "moved #10 to triage (its comment was already there)",
      "moved #11 to triage",
      "moved #15 to triage",
    ]);
  });

  it("waits out a Retry-After three times, and stops at the fourth refusal", async () => {
    const repo = setup();
    const { tracker } = repo.view(LABEL_SECTION);
    let refusals = 3;
    repo.refuse = (w) =>
      w.kind === "comment" && refusals-- > 0
        ? Object.assign(new Error("secondary rate limit"), {
            unavailable: true,
            retryAfterSec: 60,
          })
        : null;
    const clock = fakeClock();
    const report = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(clock),
    });
    expect(clock.slept).toEqual([60_000, 60_000, 60_000]);
    expect(report.moved).toEqual(["#10", "#11", "#15"]);
    refusals = 4;
    repo.add("#20", { labels: ["bug"] });
    const stopped = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(clock),
    });
    expect(stopped.moved).toEqual([]);
    expect(stopped.stopped).toBe(
      "comment on #20: unavailable, retry after 60s (after 3 waits this run)",
    );
  });

  it("honours at most three Retry-After waits a run, across its writes", async () => {
    const clock = fakeClock();
    const writer = pacedWriter(clock);
    const refused = (times: number) => {
      let left = times;
      return async () => {
        if (left-- > 0)
          throw Object.assign(new Error("rate limited"), {
            unavailable: true,
            retryAfterSec: 5,
          });
      };
    };
    await writer.write("comment on #1", refused(2));
    await writer.write("move #1 to triage", refused(1));
    expect(
      await writer
        .write("comment on #2", refused(1))
        .catch((e: unknown) =>
          e instanceof WriteRefused ? e.message : String(e),
        ),
    ).toBe(
      "comment on #2: unavailable, retry after 5s (after 3 waits this run)",
    );
    expect(clock.slept).toEqual([5000, 5000, 5000]);
  });

  it("moves nothing when more than half of the issues that must carry a facet lack it", async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 3; n++) repo.add(`#${n}`, { labels: ["bug", "xs"] });
    repo.add("#4", { labels: labelled("bug", "low", "xs") });
    const { tracker } = repo.view(LABEL_SECTION);
    const report = await sweep(tracker, {
      apply: true,
      retired: none,
      writer: pacedWriter(fakeClock()),
    });
    expect(report.storeProblem).toBe(
      "priority: 3 of the 4 open issues outside triage that must carry it lack it, more than half, which is a store that stopped answering, not a pile of bad filings; moving none",
    );
    expect(report.read).toBe(true);
    expect(report.moved).toEqual([]);
    expect(repo.writes).toEqual([]);
    const lines = sweepLines(report);
    expect(lines).toContain("  #1  state backlog  missing priority");
    expect(lines.at(-1)).toStartWith("store problem, nothing moved: priority:");
  });

  it("moves nothing when a store fails closed", async () => {
    const repo = setup();
    const { tracker } = repo.view(LABEL_SECTION);
    const failing = {
      ...tracker,
      facetStores: async () => {
        const stores = await tracker.facetStores();
        return {
          ...stores,
          facets: stores.facets.map((f) =>
            f.facet === "priority"
              ? {
                  ...f,
                  health: {
                    status: "failed" as const,
                    error: "the Priority field: refused (FORBIDDEN)",
                  },
                }
              : f,
          ),
        };
      },
    };
    const report = await sweep(failing, {
      apply: true,
      retired: none,
      writer: pacedWriter(fakeClock()),
    });
    expect(report.storeProblem).toBe(
      "priority: the Priority field: refused (FORBIDDEN)",
    );
    expect(report.read).toBe(false);
    expect(report.listed).toEqual([]);
    expect(repo.writes).toEqual([]);
    expect(sweepLines(report).at(-1)).toBe(
      "store problem, nothing read or moved: priority: the Priority field: refused (FORBIDDEN)",
    );
  });

  it("paces its writes at 30 a minute", async () => {
    const clock = fakeClock();
    const writer = pacedWriter(clock);
    for (let n = 0; n < 30; n++) await writer.write("w", async () => undefined);
    expect(clock.slept).toEqual([]);
    await writer.write("w", async () => undefined);
    expect(clock.slept).toEqual([60_000]);
    expect(writer.attempts).toBe(31);
  });

  it("lists a retired label, the GitHub priority labels it hides included", async () => {
    const repo = new FakeRepo();
    for (let n = 1; n <= 3; n++)
      repo.add(`#${n}`, {
        native: { type: "bug", priority: 2, size: "small" },
        labels: n === 1 ? ["bug", "priority: high"] : [],
      });
    const { tracker } = repo.view(NATIVE_SECTION, { hidePriority: true });
    const labels = facetsFor(LABEL_SECTION);
    const retired = [labels.type, labels.priority, labels.size].flatMap((s) =>
      ("labels" in s && s.labels !== null ? s.labels : []).flatMap(
        ([, ls]) => ls,
      ),
    );
    const report = await sweep(tracker, {
      apply: false,
      retired: () => retired,
      writer: pacedWriter(fakeClock()),
    });
    expect(report.listed).toEqual([
      {
        identifier: "#1",
        url: null,
        state: { name: "state backlog", type: "backlog" },
        missing: [],
        retired: ["bug", "priority: high"],
      },
    ]);
    expect(sweepMarker(report.listed[0] as (typeof report.listed)[0])).toBe(
      "<!-- jig:issue-fields missing=- retired=bug,priority%3A%20high -->",
    );
    expect((await tracker.openPopulation())[0]?.hiddenLabels).toEqual([
      "priority: high",
    ]);
  });
});

it("does not disclose an unclassified upstream response", () => {
  expect(
    failureLine("update #1", new Error("private upstream plaintext")),
  ).toBe("update #1: failed");
});

it("does not move an issue started while its write was paced", async () => {
  const repo = setup();
  const { tracker } = repo.view(LABEL_SECTION);
  const writer = pacedWriter(fakeClock());
  const report = await sweep(tracker, {
    apply: true,
    retired: none,
    writer: {
      get attempts() {
        return writer.attempts;
      },
      async write(what, run) {
        if (what === "move #10 to triage") repo.get("#10").state = "started";
        return writer.write(what, run);
      },
    },
  });
  expect(repo.get("#10").state).toBe("started");
  expect(report.moved).not.toContain("#10");
  expect(report.skipped).toContain("#10");
});

it("shares one census across the pages and started list", async () => {
  const repo = setup();
  const { tracker } = repo.view(LABEL_SECTION);
  const read = tracker.openPopulation;
  // Count at the core boundary by constructing a new withFacets wrapper below.
  const core = {
    ...tracker,
    openPopulation: async () => {
      calls++;
      return read();
    },
  };
  let calls = 0;
  const { withFacets } = await import(
    "../../do-item/scripts/lib/tracker/facets/tracker.ts"
  );
  const shared = withFacets(
    core as unknown as import("../../do-item/scripts/lib/tracker/facets/tracker.ts").CoreTracker,
    facetsFor(LABEL_SECTION),
    new Set(["type", "priority", "size"]),
  );
  await sweep(shared, {
    apply: false,
    retired: none,
    writer: pacedWriter(fakeClock()),
    limits: { pageSize: 1 },
  });
  expect(calls).toBe(1);
});

it("stops retry sleeps when cancelled and starts no further effect", async () => {
  const cancel = new AbortController();
  let attempts = 0;
  const clock = {
    now: () => 0,
    sleep: async () => {
      cancel.abort();
    },
  };
  const writer = pacedWriter(
    clock,
    { perMinute: 30, retries: 3, maxWaitSec: 600 },
    { signal: cancel.signal },
  );
  await expect(
    writer.write("update #1", async () => {
      attempts++;
      throw Object.assign(new Error("busy"), { retryAfterSec: 10 });
    }),
  ).rejects.toBeDefined();
  expect(attempts).toBe(1);
});

it("retains ownership of a cancelled effect until it settles", async () => {
  const cancel = new AbortController();
  const writer = pacedWriter(fakeClock(), undefined, { signal: cancel.signal });
  let finish: (() => void) | undefined;
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const effect = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const result = writer
    .write("update #1", async (signal) => {
      expect(signal).toBe(cancel.signal);
      started?.();
      await effect;
    })
    .then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
  await entered;
  cancel.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  finish?.();
  await result;
  expect(settled).toBe(true);
});
