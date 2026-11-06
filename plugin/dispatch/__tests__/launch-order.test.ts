import { expect, it } from "bun:test";
import { applyInTurns, backgroundOrder } from "../lib/apply-order.ts";
import { rotated, type ApplyState } from "../lib/actions/launch.ts";

it("alternates launch groups globally while retaining repository rotation within each", async () => {
  for (const tick of [0, 1]) {
    const seen: string[] = [];
    const repos = ["first", "second"].map((repo) => ({
      apply: async (group: string) => {
        seen.push(`${repo}:${group}`);
      },
      finish: async () => {
        seen.push(`${repo}:finish`);
      },
    }));
    await applyInTurns(repos, tick);
    const groups =
      tick === 0 ? ["drives", "background"] : ["background", "drives"];
    expect(seen).toEqual([
      ...groups.flatMap((group) => [`first:${group}`, `second:${group}`]),
      "first:finish",
      "second:finish",
    ]);
  }
});

it("lets every target lead on successive opportunities of a background stage", () => {
  for (const repos of [1, 2, 4]) {
    const items = ["a", "b", "c", "d"];
    const leads = items.map(
      (_, cycle) =>
        rotated(
          { tick: 1 + 4 * repos * cycle, repos } as ApplyState,
          items,
          "targets",
        )[0],
    );
    expect(leads).toEqual(items);
  }
});

it("lets each background stage lead in every repository under sustained drive traffic", async () => {
  for (const count of [1, 2, 4]) {
    const led = Array.from({ length: count }, () => new Set<string>());
    for (let tick = 0; tick < count * 4; tick++) {
      let available = true;
      await applyInTurns(
        Array.from({ length: count }, (_, repo) => ({
          apply: async (group) => {
            if (!available) return;
            available = false;
            if (group === "background")
              led[repo]?.add(
                backgroundOrder(
                  ["pickup", "followup"],
                  tick,
                  count,
                )[0] as string,
              );
          },
          finish: async () => {
            /* This fixture has no notifications. */
          },
        })),
        tick,
      );
    }
    for (const stages of led)
      expect([...stages].sort()).toEqual(["followup", "pickup"]);
  }
});

it("lets every repository lead each group, including even repository counts", async () => {
  for (const count of [2, 4]) {
    const leads = { drives: new Set<number>(), background: new Set<number>() };
    for (let tick = 0; tick < count * 2; tick++) {
      let available = true;
      const first = tick % 2 === 0 ? "drives" : "background";
      await applyInTurns(
        Array.from({ length: count }, (_, repo) => ({
          apply: async (group) => {
            if (available) {
              leads[group].add(repo);
              available = false;
            }
          },
          finish: async () => {
            /* No notifications in this admission fixture. */
          },
        })),
        tick,
      );
      expect(leads[first].size).toBeGreaterThan(0);
    }
    expect(leads.drives.size).toBe(count);
    expect(leads.background.size).toBe(count);
  }
});
