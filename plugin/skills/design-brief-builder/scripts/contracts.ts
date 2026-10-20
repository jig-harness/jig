import { decodeJson, isRecord, isStringArray } from "../../../shared/guards.ts";
export interface Scenario {
  name: string;
  url: string;
  ready: string;
  screenshot: string;
}
export interface Manifest {
  version: 1;
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
/** The renderer's own output directory: never bundle input or delivered evidence. */
export const renderDirectory = ".handback-render";
export const reportFile = "handback-report.json";
/** The file name a scenario's verification image is written under. */
export function renderName(scenario: string): string {
  return scenario.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function nonempty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function reserved(path: string): boolean {
  const normalized = path.replace(/^(?:\.\/)+/, "");
  return (
    normalized === reportFile ||
    normalized === renderDirectory ||
    normalized.startsWith(`${renderDirectory}/`)
  );
}
function scenario(v: unknown): v is Scenario {
  return (
    isRecord(v) &&
    nonempty(v.name) &&
    nonempty(v.url) &&
    nonempty(v.ready) &&
    nonempty(v.screenshot) &&
    /\.png$/i.test(v.screenshot) &&
    !reserved(v.screenshot)
  );
}
function distinct(values: string[]): boolean {
  return new Set(values).size === values.length;
}
function manifest(v: unknown): v is Manifest {
  return (
    isRecord(v) &&
    v.version === 1 &&
    Array.isArray(v.scenarios) &&
    v.scenarios.length > 0 &&
    v.scenarios.every(scenario) &&
    distinct(v.scenarios.map((s) => s.name)) &&
    distinct(v.scenarios.map((s) => renderName(s.name))) &&
    distinct(v.scenarios.map((s) => s.screenshot))
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
export const settingsRequirement =
  "design_brief.handback needs distinct positive integer widths and nonempty rubric, scorecard and browser_executable; forbidden_terms, when set, lists nonempty strings";
