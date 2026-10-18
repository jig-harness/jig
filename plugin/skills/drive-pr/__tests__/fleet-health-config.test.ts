/**
 * fleet-health-config.test.ts — where the fleet-health configuration comes
 * from: the consumer repository (never the plugin's own directory), its
 * overlay's tracker vocabulary, and the snapshot directory the drive brief
 * reads the published report from.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dashboardDir,
  expandDir,
} from "../scripts/lib/fleet-health-advisory.ts";
import {
  defaultConfigPath,
  EMPTY_CONTEXT,
  loadConfig,
  parseConfig,
} from "../scripts/lib/fleet-health-config.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fleet-health.yaml");
const SAVED = {
  root: process.env.JIG_CONSUMER_ROOT,
  overlay: process.env.JIG_OVERLAY,
};
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fleet-health-config-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".config"));
  process.env.JIG_CONSUMER_ROOT = repo;
  delete process.env.JIG_OVERLAY;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const [k, v] of [
    ["JIG_CONSUMER_ROOT", SAVED.root],
    ["JIG_OVERLAY", SAVED.overlay],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function overlay(text: string): void {
  writeFileSync(join(repo, ".config", "jig.yaml"), text);
}

describe("loadConfig", () => {
  it("with no argument reads the consumer's default path and its overlay", () => {
    copyFileSync(FIXTURE, join(repo, ".config", "fleet-health.yaml"));
    overlay(
      [
        "issue_tracker:",
        "  team: ENG",
        "review:",
        "  taxonomy:",
        "    epic_label: initiative",
        "    repos: [web, api]",
        "drive:",
        "  change_areas_catalog: areas.yaml",
      ].join("\n"),
    );
    const cfg = loadConfig();
    expect(cfg.root).toBe(repo);
    expect(cfg.teamKey).toBe("ENG");
    expect(cfg.labels).toEqual({
      epic: "initiative",
      followup: "follow-up",
      deliverySystem: "delivery-system",
      repositories: ["web", "api"],
    });
    expect(cfg.catalogPath).toBe(join(repo, "areas.yaml"));
    expect(cfg.ledger).toEqual({
      label: "follow-up",
      project: "Debt",
      closedStateTypes: ["completed", "canceled", "duplicate"],
    });
    expect(cfg.baselines.rounds_median?.value).toBe(10);
  });

  it("follows fleet_health.config to the consumer's own file", () => {
    copyFileSync(FIXTURE, join(repo, "metrics.yaml"));
    overlay("fleet_health:\n  config: metrics.yaml\n");
    expect(defaultConfigPath()).toBe(join(repo, "metrics.yaml"));
    expect(loadConfig().window.days).toBe(14);
  });

  it("with a path reads the overlay of the repository that holds it", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "fleet-health-cwd-"));
    try {
      delete process.env.JIG_CONSUMER_ROOT;
      const path = join(repo, ".config", "fleet-health.yaml");
      copyFileSync(FIXTURE, path);
      overlay("issue_tracker:\n  team: OPS\n");
      expect(loadConfig(path).teamKey).toBe("OPS");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("names the file when it is missing", () => {
    expect(() => loadConfig()).toThrow(/could not be read/);
  });

  it("takes the follow-up label from the review taxonomy unless the config names one", () => {
    const path = join(repo, ".config", "fleet-health.yaml");
    copyFileSync(FIXTURE, path);
    overlay("review:\n  taxonomy:\n    provenance_label: deferred\n");
    expect(loadConfig().labels.followup).toBe("follow-up");
    writeFileSync(
      path,
      readFileSync(FIXTURE, "utf8").replace("  followup: follow-up\n", ""),
    );
    expect(loadConfig().labels.followup).toBe("deferred");
    expect(loadConfig().ledger.label).toBe("deferred");
  });

  it("takes the epic and follow-up labels from issue_tracker.labels, and leaves an unnamed follow-up unmeasured", () => {
    const path = join(repo, ".config", "fleet-health.yaml");
    writeFileSync(
      path,
      readFileSync(FIXTURE, "utf8")
        .replace("  followup: follow-up\n", "")
        .replace(/^  epic: .*\n/m, ""),
    );
    overlay(
      "issue_tracker:\n  labels:\n    epic: Initiative\n    followup: review-fu\n",
    );
    expect(loadConfig().labels.epic).toBe("Initiative");
    expect(loadConfig().labels.followup).toBe("review-fu");
    overlay("issue_tracker:\n  team: OPS\n");
    expect(loadConfig().labels.followup).toBeNull();
    overlay(
      "issue_tracker:\n  labels:\n    epic: Epic\nreview:\n  taxonomy:\n    epic_label: Initiative\n",
    );
    expect(() => loadConfig()).toThrow(/name different labels/);
  });

  it("rejects a labels or ledger key the sensor does not read", () => {
    const base = {
      version: 1,
      window: { days: 14 },
      progress: {
        product_areas: ["api"],
        weights: {
          merged_product_pr: 1,
          criterion_closed: 1,
          epic_accepted: 1,
        },
      },
      ceremony: {
        free_rounds: 3,
        weights: {
          rounds_beyond_free: 1,
          followups_minted: 1,
          sdlc_issues_opened: 1,
        },
        unmeasured: {},
      },
      signals: {
        stuck_epic: { days: 14 },
        ceremony_ratio: { suspect_at: 5, high_at: 10, min_ceremony: 5 },
        followup_depth: { suspect_at: 2, max_walk: 6 },
        delivery_system_share: { suspect_at: null },
        review_carousel: {
          min_rounds: 12,
          high_rounds: 25,
          min_post_review_share: 0.45,
        },
      },
      lifecycle: { cooldown_days: 14 },
    };
    const plain = parseConfig(base);
    expect(plain.labels).toEqual({
      epic: "epic",
      followup: null,
      deliverySystem: null,
      repositories: [],
    });
    expect(plain.signals.tailBlocked).toEqual({
      minDoneShare: 0.8,
      maxOpen: 2,
    });
    const tuned = parseConfig(
      {
        ...base,
        labels: { repositories: ["svc"] },
        signals: {
          ...(base.signals as object),
          tail_blocked: { done_share: 0.5, max_open: 3 },
        },
      },
      { ...EMPTY_CONTEXT, repositoryLabels: ["ignored"] },
    );
    expect(tuned.labels.repositories).toEqual(["svc"]);
    expect(tuned.signals.tailBlocked).toEqual({
      minDoneShare: 0.5,
      maxOpen: 3,
    });
    for (const [tail, where] of [
      [{ done_share: 1.5 }, /signals\.tail_blocked\.done_share/],
      [{ max_open: 0 }, /signals\.tail_blocked\.max_open/],
      [{ max_open: 1.5 }, /signals\.tail_blocked\.max_open/],
      [{ days: 3 }, /signals\.tail_blocked\.days/],
    ] as const)
      expect(() =>
        parseConfig({
          ...base,
          signals: { ...(base.signals as object), tail_blocked: tail },
        }),
      ).toThrow(where);
    expect(() =>
      parseConfig({ ...base, labels: { repositories: "web" } }),
    ).toThrow(/labels\.repositories/);
    expect(plain.ledger.label).toBeNull();
    expect(() => parseConfig({ ...base, labels: { sdlc: "x" } })).toThrow(
      /labels\.sdlc/,
    );
    expect(() => parseConfig({ ...base, ledger: { team: "x" } })).toThrow(
      /ledger\.team/,
    );
    expect(() =>
      parseConfig({ ...base, baselines: { rounds_median: { value: "x" } } }),
    ).toThrow(/baselines\.rounds_median\.value/);
  });
});

describe("the snapshot directory", () => {
  it("prefers DEV_DASHBOARD_DIR, then fleet_health.snapshot_dir, then the default", () => {
    expect(dashboardDir({ DEV_DASHBOARD_DIR: " /tmp/dash " }, "/home/u")).toBe(
      "/tmp/dash",
    );
    expect(dashboardDir({}, "/home/u")).toBe(
      join("/home/u", ".local", "state", "jig", "dashboard"),
    );
    overlay("fleet_health:\n  snapshot_dir: ~/panels\n");
    expect(dashboardDir({}, "/home/u")).toBe(join("/home/u", "panels"));
    overlay("fleet_health:\n  snapshot_dir: var/panels\n");
    expect(dashboardDir({}, "/home/u")).toBe(join(repo, "var/panels"));
  });

  it("expands ~ alone and ~/ prefixes only", () => {
    expect(expandDir("~", "/home/u")).toBe("/home/u");
    expect(expandDir("~/x", "/home/u")).toBe(join("/home/u", "x"));
    expect(expandDir("/abs/x", "/home/u")).toBe("/abs/x");
  });
});
