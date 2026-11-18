import { describe, expect, it } from "bun:test";
import { busyLoad, overLoad } from "../fixture-line.ts";
import { LINE_AT, loadView } from "./load-view.ts";

describe("the load's view", () => {
  it("names the factor and the gauge that binds, and draws every gauge against its own line", () => {
    const view = loadView(busyLoad());
    expect(view).toMatchObject({
      figure: "Load 82%",
      binds: "memory binds",
      title: "Would have held 1 launch · reservations",
    });
    expect(view.gauges.map((g) => g.name)).toEqual([
      "Memory",
      "Processors",
      "Test lock",
      "Disk",
      "Forge budget",
      "Accounts",
    ]);
    expect(view.gauges[0]).toEqual({
      gauge: "memory",
      name: "Memory",
      fill: "82%",
      read: true,
      over: false,
      binds: true,
      reads: "13.5 GiB available of 62.5 GiB · line: 15% of memory kept free",
      under: 54.7,
      past: 0,
      label: "Memory at 82% of its line",
    });
    expect(view.gauges.filter((g) => g.binds).map((g) => g.gauge)).toEqual([
      "memory",
    ]);
    expect(view.reservations[2]?.text).toBe(
      "1.0 GiB, default (3 of 5 samples)",
    );
  });

  it("puts the line two thirds along a bar that runs to 150%", () => {
    expect(LINE_AT).toBeCloseTo(66.667, 3);
  });

  it("marks a gauge past its line, the one that binds, and a gauge not read", () => {
    const view = loadView(overLoad());
    expect(view).toMatchObject({
      figure: "Load 150%",
      binds: "processors binds",
      title: "Would have held 2 launches · reservations",
    });
    const [memory, processors, , disk] = view.gauges;
    expect(processors).toMatchObject({
      fill: "150%",
      over: true,
      binds: true,
      under: 66.7,
      past: 33.3,
      label: "Processors at 150% of its line, over it",
    });
    expect(memory).toMatchObject({ over: false, binds: false, under: 64 });
    expect(disk).toEqual({
      gauge: "disk",
      name: "Disk",
      fill: "not read",
      read: false,
      over: false,
      binds: false,
      reads:
        "free space not read (df did not answer within 2 s) · line: 10.0 GiB free",
      under: 0,
      past: 0,
      label: "Disk not read",
    });
  });

  it("stops a fill at the bar's end and counts a gauge at its line as over it", () => {
    const load = overLoad();
    const view = loadView({
      ...load,
      factor: 2.4,
      gauges: [
        { ...(load.gauges[1] as (typeof load.gauges)[0]), fill: 2.4 },
        { ...(load.gauges[0] as (typeof load.gauges)[0]), fill: 1 },
      ],
    });
    expect(view.figure).toBe("Load 240%");
    expect(view.gauges[0]).toMatchObject({ under: 66.7, past: 33.3 });
    expect(view.gauges[1]).toMatchObject({ over: true, past: 0 });
  });

  it("titles the fold with what enforcement held, none included", () => {
    const load = busyLoad();
    const hold = load.holds[0] as (typeof load.holds)[0];
    expect(
      loadView({ ...load, enforce: true, holds: [{ ...hold, held: true }] }),
    ).toMatchObject({ title: "Held 1 launch · reservations" });
    expect(loadView({ ...load, enforce: true, holds: [] }).title).toBe(
      "Held no launch · reservations",
    );
    expect(loadView({ ...load, holds: [] }).title).toBe(
      "Would have held no launch · reservations",
    );
    expect(
      loadView({ ...load, holds: [{ ...hold, held: true }] }).holds[0]?.text,
    ).toStartWith("held the pickup");
  });

  it("says when no gauge read", () => {
    const load = busyLoad();
    expect(loadView({ ...load, factor: null, binds: null })).toMatchObject({
      figure: "Load –",
      binds: "no gauge read",
    });
  });
});
