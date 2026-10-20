import { decodeJson, isRecord, isStringArray } from "../../../shared/guards.ts";
export interface Scenario {
  name: string;
  url: string;
  screenshot: string;
}
export interface Manifest {
  version: 1;
  prototype: string;
  scenarios: Scenario[];
}
export interface Report {
  version: 1;
  ours: string;
  exportBase: string;
  previousExportBase: string;
  provenance: string;
  conflicts: string[];
  regressions: { file: string; hunk: string; acknowledged: boolean }[];
}
export interface Settings {
  forbidden_terms?: string[];
  widths: number[];
  rubric: string;
  scorecard: string;
  browser_executable: string;
}
function nonempty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function scenario(v: unknown): v is Scenario {
  return (
    isRecord(v) &&
    nonempty(v.name) &&
    nonempty(v.url) &&
    nonempty(v.screenshot) &&
    /\.png$/i.test(v.screenshot)
  );
}
function manifest(v: unknown): v is Manifest {
  return (
    isRecord(v) &&
    v.version === 1 &&
    nonempty(v.prototype) &&
    Array.isArray(v.scenarios) &&
    v.scenarios.length > 0 &&
    v.scenarios.every(scenario) &&
    new Set(v.scenarios.map((s) => s.name)).size === v.scenarios.length &&
    new Set(v.scenarios.map((s) => s.screenshot)).size === v.scenarios.length
  );
}
function regression(v: unknown): boolean {
  return (
    isRecord(v) &&
    nonempty(v.file) &&
    nonempty(v.hunk) &&
    typeof v.acknowledged === "boolean"
  );
}
function report(v: unknown): v is Report {
  return (
    isRecord(v) &&
    v.version === 1 &&
    [v.ours, v.exportBase, v.previousExportBase].every(
      (x) => typeof x === "string" && /^[a-f\d]{40,64}$/.test(x),
    ) &&
    nonempty(v.provenance) &&
    isStringArray(v.conflicts) &&
    Array.isArray(v.regressions) &&
    v.regressions.every(regression)
  );
}
export function parseManifest(text: string): Manifest {
  return decodeJson(text, manifest, "design-handback.json");
}
export function parseReport(text: string): Report {
  return decodeJson(text, report, "handback-report.json");
}
export function validSettings(v: unknown): v is Settings {
  return (
    isRecord(v) &&
    Array.isArray(v.widths) &&
    v.widths.length > 0 &&
    v.widths.every((n) => Number.isInteger(n) && n > 0) &&
    new Set(v.widths).size === v.widths.length &&
    nonempty(v.rubric) &&
    nonempty(v.scorecard) &&
    nonempty(v.browser_executable) &&
    (v.forbidden_terms === undefined ||
      (isStringArray(v.forbidden_terms) && v.forbidden_terms.every(nonempty)))
  );
}
