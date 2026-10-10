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
  loadConfig,
  parseConfig,
} from "../scripts/lib/fleet-health-config.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fleet-health.yaml");
const SAVED = {
  root: process.env.GROUNDWORK_CONSUMER_ROOT,
  overlay: process.env.GROUNDWORK_OVERLAY,
};
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fleet-health-config-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".config"));
  process.env.GROUNDWORK_CONSUMER_ROOT = repo;
  delete process.env.GROUNDWORK_OVERLAY;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const [k, v] of [
    ["GROUNDWORK_CONSUMER_ROOT", SAVED.root],
    ["GROUNDWORK_OVERLAY", SAVED.overlay],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function overlay(text: string): void {
  writeFileSync(join(repo, ".config", "groundwork-overlay.yaml"), text);
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
      delete process.env.GROUNDWORK_CONSUMER_ROOT;
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
    });
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
      "/home/u/.local/state/groundwork/dashboard",
    );
    overlay("fleet_health:\n  snapshot_dir: ~/panels\n");
    expect(dashboardDir({}, "/home/u")).toBe("/home/u/panels");
    overlay("fleet_health:\n  snapshot_dir: var/panels\n");
    expect(dashboardDir({}, "/home/u")).toBe(join(repo, "var/panels"));
  });

  it("expands ~ alone and ~/ prefixes only", () => {
    expect(expandDir("~", "/home/u")).toBe("/home/u");
    expect(expandDir("~/x", "/home/u")).toBe("/home/u/x");
    expect(expandDir("/abs/x", "/home/u")).toBe("/abs/x");
  });
});
