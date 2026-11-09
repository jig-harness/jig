import { describe, expect, it } from "bun:test";
import { busyLoad } from "../fixture-line.ts";
import { loadView } from "./load-view.ts";

describe("the load gauge's view", () => {
  it("shows the factor, the gauge that binds and what it would have held", () => {
    const view = loadView(busyLoad());
    expect(view).toMatchObject({
      percent: "82%",
      width: 82,
      over: false,
      binds: "memory binds",
      summary: "Reporting only: 1 launch would have been held this tick.",
    });
    expect(view.gauges[0]).toEqual({
      name: "Memory",
      fill: "82%",
      reads: "13.5 GiB available of 62.5 GiB",
      line: "15% of memory kept free",
    });
    expect(view.reservations[2]?.text).toBe(
      "1.0 GiB, default (3 of 5 samples)",
    );
  });

  it("says what enforcement held, a gauge not read, and a factor past its line", () => {
    const load = busyLoad();
    const view = loadView({
      ...load,
      enforce: true,
      factor: 1.3,
      holds: [{ ...(load.holds[0] as (typeof load.holds)[0]), held: true }],
      gauges: [{ ...(load.gauges[1] as (typeof load.gauges)[0]), fill: null }],
    });
    expect(view).toMatchObject({
      percent: "130%",
      width: 100,
      over: true,
      summary: "Enforced: 1 launch held this tick.",
    });
    expect(view.gauges[0]?.fill).toBe("not read");
    expect(view.holds[0]?.text).toStartWith("held the pickup");
  });
});
