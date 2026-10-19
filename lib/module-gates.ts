/** Portable gates over exported files. Keep the original line-oriented formats
 * intentionally narrow: adopting a full YAML parser would change gate behavior.
 * One gate reads full YAML instead, because a workflow can spell one value
 * through folded scalars, quoted keys, flow collections and anchors, and the
 * gate must see the value every other reader sees: the PR-target safety lint
 * for GitHub Actions workflows, through the shared workflow reader in
 * `workflows.ts`, with js-yaml vendored in `vendor/` beside this file. js-yaml
 * rejects a repeated key where Bun's parser keeps the last one; vendoring
 * `lib/` alone therefore keeps that check. */
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  linkSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, isAbsolute } from "node:path";
import { readYaml, workflowFiles as listWorkflows } from "./workflows.ts";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
export type Environment = Record<string, string | undefined>;
const result = (code: number, stdout = "", stderr = ""): Result => ({
  code,
  stdout,
  stderr,
});
const error = (message: string) => result(2, "", `ERROR: ${message}\n`);
const file = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((_, i, all) => i < all.length - 1 || all[i] !== "");
const scalar = (value: string) =>
  value
    .replace(/^[^:]*:\s*/, "")
    .replace(/^#.*$/, "")
    .replace(/\s+#.*$/, "")
    .replace(/^["']|["']\s*$/g, "")
    .trimEnd();
const missing = (value: string) => ["", "~", "null", "{}"].includes(value);
const field = (name: string) =>
  new RegExp(`^\\s*(?:-\\s+)?["']?${name}["']?\\s*:`);
const verdicts = new Map([
  ["addressed", "addressed"],
  ["accepted", "addressed"],
  ["fixed", "addressed"],
  ["done", "addressed"],
  ["rejected", "rejected"],
  ["wontfix", "rejected"],
  // The verdict resolve-review-comments writes for "valid but declined".
  ["wont-fix", "rejected"],
  ["declined", "rejected"],
  ["invalid", "rejected"],
  ["deferred", "deferred"],
  ["followup", "deferred"],
  ["follow-up", "deferred"],
  ["moot", "moot"],
  ["obsolete", "moot"],
  ["superseded", "moot"],
]);
const canon = (word: string) => verdicts.get(word.toLowerCase()) || "";

/** Strip rendered comments, preserving the legacy greedy inline-comment rule. */
function stripComment(line: string, inHtml: boolean): [string, boolean] {
  if (inHtml) {
    if (!line.includes("-->")) return ["", true];
    line = line.replace(/^.*-->/, "");
    inHtml = false;
  }
  line = line.replace(/<!--.*-->/g, "");
  if (line.includes("<!--")) {
    line = line.replace(/<!--.*$/, "");
    inHtml = true;
  }
  return [line, inHtml];
}
export function requiredSections(args: string[], env: Environment): Result {
  const artifact = args[0] || env.ARTIFACT || "";
  if (!artifact) return error("no artifact file given (arg 1 or ARTIFACT=)");
  if (!file(artifact)) return error(`artifact not found: ${artifact}`);
  let raw = env.SECTIONS || "";
  if (!raw.replace(/[\s|]/g, "")) {
    const manifest = args[1] || env.MANIFEST || "";
    if (!manifest)
      return error(
        "no required sections (set SECTIONS= or pass a manifest as arg 2 / MANIFEST=)",
      );
    if (!file(manifest)) return error(`manifest not found: ${manifest}`);
    raw = readFileSync(manifest, "utf8");
  }
  const headings = new Set<string>();
  let frontmatter = false,
    fence = false,
    html = false;
  for (const [i, rawLine] of lines(artifact).entries()) {
    if (i === 0 && /^---\s*$/.test(rawLine)) {
      frontmatter = true;
      continue;
    }
    if (frontmatter) {
      if (/^---\s*$/.test(rawLine)) frontmatter = false;
      continue;
    }
    let line: string;
    [line, html] = stripComment(rawLine, html);
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !/^ {0,3}#{1,6}\s+/.test(line)) continue;
    headings.add(
      line
        .replace(/^ {0,3}#{1,6}\s+/, "")
        .replace(/\s*#+\s*$/, "")
        .trimEnd()
        .replace(/:\s*$/, "")
        .trimEnd()
        .toLowerCase(),
    );
  }
  let parsed = 0,
    present = 0;
  const absent: string[] = [];
  for (const want of raw.replace(/\|/g, "\n").split("\n")) {
    if (!want || want.startsWith("#")) continue;
    const normalized = want
      .trimStart()
      .replace(/\s*#+\s*$/, "")
      .replace(/\s*:?[\s]*$/, "")
      .toLowerCase();
    if (!normalized) continue;
    parsed++;
    if (headings.has(normalized)) present++;
    else absent.push(want.trim());
  }
  if (!parsed)
    return error(
      "no required section labels parsed (empty SECTIONS / manifest)",
    );
  if (absent.length)
    return result(
      1,
      absent.map((w) => `MISSING required section: "${w}"\n`).join("") +
        `\nRequired-sections gate FAILED for ${artifact}: ${absent.length} missing, ${present} present.\n`,
    );
  return result(
    0,
    `OK — all ${present} required sections present in ${artifact}\n`,
  );
}
export function stageAccepted(args: string[], env: Environment): Result {
  const artifact = args[0] || env.ARTIFACT || "";
  if (!artifact) return error("no artifact file given (arg 1 or ARTIFACT=)");
  if (!file(artifact)) return error(`artifact not found: ${artifact}`);
  let fm = false,
    closed = false,
    status = "",
    reviewed = "",
    nstatus = 0,
    nreviewed = 0,
    fence = false,
    html = false,
    review = false,
    content = false;
  for (const [i, raw] of lines(artifact).entries()) {
    if (i === 0 && /^---\s*$/.test(raw)) {
      fm = true;
      continue;
    }
    if (fm && !closed) {
      if (/^---\s*$/.test(raw)) {
        closed = true;
        continue;
      }
      if (/^\s*status\s*:/.test(raw)) {
        nstatus++;
        status = raw
          .replace(/^\s*status\s*:\s*/, "")
          .replace(/\s+#.*$/, "")
          .replace(/["']/g, "")
          .trim()
          .toLowerCase();
      } else if (/^\s*reviewed\s*:/.test(raw)) {
        nreviewed++;
        let v = raw.replace(/^\s*reviewed\s*:\s*/, "").trim();
        v = /^["']/.test(v)
          ? v.slice(1).split(v[0] || "")[0] || ""
          : v.replace(/\s+#.*$/, "");
        reviewed = v.trim();
      }
      continue;
    }
    let line = raw;
    if (!fence) [line, html] = stripComment(line, html);
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (review && line.trim()) content = true;
      continue;
    }
    if (/^##\s+[Rr]eview(?![\w-])/.test(line)) {
      review = true;
      continue;
    }
    if (/^#{1,2}\s+/.test(line)) {
      review = false;
      continue;
    }
    if (review && line.trim()) content = true;
  }
  if (fm && !closed)
    return error(
      `malformed frontmatter (opened with --- but never closed): ${artifact}`,
    );
  if (nstatus > 1)
    return error(`duplicate status: key in frontmatter: ${artifact}`);
  if (nreviewed > 1)
    return error(`duplicate reviewed: key in frontmatter: ${artifact}`);
  const anchor = /\d{4}-\d{2}-\d{2}|#\d+|https?:\/\/|[0-9a-fA-F]{7,40}/.test(
    reviewed,
  );
  const rest = reviewed
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/#\d+/g, " ")
    .replace(/[0-9a-fA-F]{7,40}/g, " ");
  const who =
    /[A-Za-z]/.test(rest) &&
    !["true", "false", "yes", "no"].includes(rest.trim().toLowerCase());
  if (status !== "accepted")
    return result(
      0,
      status
        ? `OK — status: ${status}; no review record required\n`
        : "OK — no accepted status; no review record required\n",
    );
  if ((anchor && who) || content)
    return result(0, "OK — accepted and carries a review record\n");
  return result(
    1,
    "FAIL — status: accepted but no review record\n       add a reviewed: <reviewer, date/ref> frontmatter key, or a non-empty ## Review section\n",
  );
}
export function hasReference(trail: string): boolean {
  let previous = "";
  for (const raw of trail.trim().split(/\s+/)) {
    const word = raw
      .replace(/^[`'"([{<]+/, "")
      .replace(/[`'")\]}>.,;:!?]+$/, "");
    if (
      (/^[0-9a-fA-F]{7,40}$/.test(word) && /\d/.test(word)) ||
      /^#\d+$/.test(word) ||
      /^[A-Z][A-Z0-9]*-\d+$/.test(word) ||
      /^https?:\/\/\S+$/.test(word)
    )
      return true;
    if (
      /^([Cc]ommit|[Ss]ha):?$/.test(previous) &&
      /^[0-9a-fA-F]{7,40}$/.test(word)
    )
      return true;
    previous = word;
  }
  return false;
}
export function threadsResolved(args: string[], env: Environment): Result {
  const path = args[0] || env.THREADS || "";
  if (!path) return error("no states file given (arg or THREADS=)");
  if (!file(path)) return error(`states file not found: ${path}`);
  let open = 0,
    noReason = 0,
    undeclared = 0,
    unknown = 0,
    out = "";
  const refs = new Map([
    ["addressed", "the commit/change that fixed it"],
    ["deferred", "the follow-up issue/PR it was filed as"],
    ["moot", "the commit/change that superseded it"],
  ]);
  let threads = 0;
  for (const line of lines(path)) {
    const match = line.trim().match(/^(\S+)(?:\s+(\S+))?(?:\s+(.*))?$/);
    if (!match || match[1]?.startsWith("#")) continue;
    threads++;
    const [, id, state = "", reason = ""] = match;
    const trailHint = refs.get(state);
    if (trailHint) {
      if (!reason.replace(/ /g, "")) {
        out += `FAIL ${id} — '${state}' with no audit trail (name ${trailHint})\n`;
        noReason++;
      } else if (!hasReference(reason)) {
        out += `FAIL ${id} — '${state}' trail '${reason}' names no commit/change/tracker/URL reference (${trailHint})\n`;
        noReason++;
      }
    } else if (state === "rejected") {
      if (!reason.replace(/ /g, "")) {
        out += `FAIL ${id} — 'rejected' with no reason (needs an audit trail)\n`;
        noReason++;
      }
    } else if (state === "unclassified") {
      out += `FAIL ${id} — resolved, but the reply declares no verdict (see ../../mappings.md § Encoding the declared verdict)\n`;
      undeclared++;
    } else if (!state || state === "open") {
      out += `FAIL ${id} — thread still open (resolve it before merge)\n`;
      open++;
    } else {
      out += `FAIL ${id} — unknown state '${state}' (want: addressed|rejected|deferred|moot)\n`;
      unknown++;
    }
  }
  if (open + noReason + undeclared + unknown)
    return result(
      1,
      out +
        `\nUnresolved-threads gate FAILED: ${open} open, ${noReason} trail-less, ${undeclared} undeclared, ${unknown} unknown.\n`,
    );
  return result(0, threadsPassed(threads));
}
/** The pass line of the threads gate; zero threads is an empty review. */
function threadsPassed(threads: number): string {
  if (!threads)
    return "OK — 0 review threads (an empty export is a review with no threads)\n";
  return `OK — ${threads} review thread(s), each terminal with a trail\n`;
}
export function normalizeThreads(args: string[], env: Environment): Result {
  const path = args[0] || env.ROWS || "",
    encoding = env.VERDICT_ENCODING || "token";
  if (!["token", "trailer"].includes(encoding))
    return error(`VERDICT_ENCODING must be token or trailer: ${encoding}`);
  if (!path) return error("no rows file given (arg or ROWS=)");
  if (!file(path)) return error(`rows file not found: ${path}`);
  let id = "",
    state = "",
    trail = "",
    newest = "",
    out = "",
    errors = "";
  const flush = () => {
    if (id)
      out += `${id} ${state || "unclassified"}${state ? (trail ? ` ${trail}` : "") : newest ? ` ${newest}` : ""}\n`;
    state = "";
    trail = "";
    newest = "";
  };
  const separator = (s: string) =>
    s.replace(/^\s*([-—–:,.|·]+\s*)?/, "").trimEnd();
  for (const line of lines(path)) {
    // Bash read with tab IFS collapses adjacent tabs, then leaves remaining tabs in body.
    const parts = line.replace(/^\t+/, "").split(/\t+/);
    const nextId = parts.shift() || "",
      resolved = parts.shift() || "",
      body = parts.join("\t").replace(/\s+/g, " ").trim();
    if (!nextId || nextId.startsWith("#")) continue;
    if (nextId !== id) {
      flush();
      id = nextId;
    }
    if (resolved === "false") {
      state = "open";
      continue;
    }
    if (resolved !== "true") {
      errors += `ERROR: ${id} — resolved column must be true or false, got '${resolved}'\n`;
      continue;
    }
    if (!newest) newest = body;
    if (state) continue;
    let word = "",
      remainder = "";
    if (encoding === "token") {
      const lead = body.split(/\s/)[0] || "";
      word = lead.replace(/[*_`]/g, "").replace(/[^A-Za-z0-9-].*$/, "");
      remainder = separator(body.slice(lead.length));
    } else {
      const m = body.match(/^(.*)[Vv]erdict:\s*([A-Za-z-]+)\s*[.]?$/);
      if (m) {
        word = m[2] || "";
        remainder = separator(m[1] || "");
      }
    }
    const decoded = canon(word);
    if (decoded) {
      state = decoded;
      trail = remainder;
    }
  }
  flush();
  return result(errors ? 2 : 0, out, errors);
}
export function roundConverged(args: string[], env: Environment): Result {
  const path = args[0] || env.STATUS || "";
  if (!path) return error("no status file given (arg or STATUS=)");
  if (!file(path)) return error(`status file not found: ${path}`);
  const values: Record<string, string> = {},
    seen = new Set<string>(),
    reviewers = new Set<string>();
  let reported = 0,
    expected = 0,
    pending = "",
    errors = "";
  const fail = (s: string) => {
    errors += `ERROR: ${s}\n`;
  };
  for (const raw of lines(path)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes(":")) {
      fail(`not a 'key: value' line: ${line}`);
      continue;
    }
    const pos = line.indexOf(":"),
      key = line.slice(0, pos).trim(),
      value = line.slice(pos + 1).trim();
    if (["pr_state", "open_threads", "round"].includes(key)) {
      if (seen.has(key)) {
        fail(`duplicate key: ${key}`);
        continue;
      }
      seen.add(key);
      if (!value) {
        fail(`key '${key}' declared with no value`);
        continue;
      }
      values[key] = value;
    } else if (key === "reviewer") {
      const pos = value.indexOf(" "),
        identity = (pos < 0 ? value : value.slice(0, pos)).trim(),
        state = (pos < 0 ? value : value.slice(pos + 1)).trim();
      if (!identity || identity === state) {
        fail(`reviewer needs '<identity> <reported|pending>', got '${value}'`);
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._@/+-]*$/.test(identity)) {
        fail(`reviewer identity must be a plain token, got '${identity}'`);
        continue;
      }
      if (reviewers.has(identity)) {
        fail(`duplicate reviewer identity: ${identity}`);
        continue;
      }
      reviewers.add(identity);
      if (state === "reported") {
        expected++;
        reported++;
      } else if (state === "pending") {
        expected++;
        pending += ` ${identity}`;
      } else
        fail(
          `reviewer ${identity} state must be reported or pending, got '${state}'`,
        );
    } else fail(`unknown key: ${key}`);
  }
  for (const key of ["pr_state", "open_threads", "round"])
    if (!values[key]) fail(`missing required key: ${key}`);
  if (!expected)
    fail(
      "no 'reviewer:' lines — name at least one reviewer, or the round has nothing to settle",
    );
  if (values.open_threads && !/^(0|[1-9][0-9]*)$/.test(values.open_threads))
    fail(
      `open_threads must be a canonical non-negative integer, no leading zeros, got '${values.open_threads}'`,
    );
  if (values.round && !/^[1-9][0-9]*$/.test(values.round))
    fail(
      `round must be an integer >= 1 (it is 1-based), got '${values.round}'`,
    );
  if (!["open", "merged", "closed"].includes(values.pr_state || "open"))
    fail(`pr_state must be open, merged or closed, got '${values.pr_state}'`);
  if (errors) return result(2, "", errors);
  const state = values.pr_state,
    round = values.round || "",
    count = values.open_threads || "";
  const decide = (decision: string, code: number, reason: string) =>
    result(
      code,
      `${decision} round=${round} open_threads=${count} reviewers=${reported}/${expected} pr_state=${state}\n`,
      `${reason}\n`,
    );
  if (state !== "open")
    return decide(
      "ABORT",
      4,
      `PR is ${state} — stop the loop; a fix pushed now lands on a branch nothing will merge.`,
    );
  if (BigInt(count) > 0)
    return decide(
      "WORK",
      1,
      `${count} thread(s) to resolve — fix them, push, then run round ${BigInt(round) + 1n}.`,
    );
  if (reported < expected)
    return decide(
      "WAIT",
      3,
      `No open threads, but only ${reported} of ${expected} named reviewers have reported — still pending:${pending}. This is not convergence yet.`,
    );
  return decide(
    "CONVERGED",
    0,
    `Round ${round} settled with all ${expected} named reviewers reported and no open threads — the loop may stop.`,
  );
}
/** Expression contexts that name the base side of a pull request. Under
 * `pull_request_target` a `ref:`/`repository:` value is trusted only when every
 * expression in it is one of these. Anything else (the head, an `env.` or step
 * output indirection, bracket access, an operator) counts as untrusted, and so
 * does a `pull/` ref, so a spelling the lint does not know over-flags rather
 * than passes. */
const BASE_CONTEXT =
  /^github\.(?:base_ref|sha|ref|ref_name|repository|repository_owner|event\.repository\.(?:full_name|default_branch)|event\.pull_request\.base\.(?:sha|ref|repo\.full_name))$/;
const untrustedRef = (value: string) =>
  /(?:^|\/)pull\//.test(value) ||
  value
    .replace(/\$\{\{([\s\S]*?)\}\}/g, (_, body: string) =>
      BASE_CONTEXT.test(body.trim()) ? "" : "${{",
    )
    .includes("${{");
interface WorkflowShape {
  untrusted: boolean;
  executes: boolean;
}
const SCRIPT_TYPES = new Set(["string", "number", "boolean"]);
/** Whether a `with:` map (a step's or a reusable-workflow call's inputs)
 * selects an untrusted `ref` or `repository`. GitHub matches input names
 * without regard to case, so `REF` counts as `ref`. */
function untrustedInputs(inputs: unknown): boolean {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
    return false;
  return Object.entries(inputs).some(
    ([key, value]) =>
      ["ref", "repository"].includes(key.toLowerCase()) &&
      value != null &&
      untrustedRef(String(value)),
  );
}
/** Record what one mapping of a parsed workflow contributes: inputs under its
 * `with:` that select untrusted code, or one of the two ways a job runs
 * checked-out code, a `run:` script and a local `uses: ./` action. Only `with:`
 * inputs are read, so an `env:` value named `ref` is data, not a checkout. */
function mappingShape(map: Record<string, unknown>, shape: WorkflowShape) {
  for (const [key, value] of Object.entries(map))
    if (key.toLowerCase() === "with" && untrustedInputs(value))
      shape.untrusted = true;
  const local =
    typeof map.uses === "string" && map.uses.trim().startsWith("./");
  if (local || SCRIPT_TYPES.has(typeof map.run)) shape.executes = true;
}
/** Whether a parsed workflow's `on:` names `pull_request_target`, written as
 * one event, a list of events or a map keyed by event. */
function privilegedTrigger(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const on = (doc as Record<string, unknown>).on;
  const events =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.map(String)
        : on && typeof on === "object"
          ? Object.keys(on)
          : [];
  return events.includes("pull_request_target");
}
function workflowShape(
  node: unknown,
  shape: WorkflowShape,
  seen: Set<object>,
): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (!Array.isArray(node))
    mappingShape(node as Record<string, unknown>, shape);
  for (const child of Object.values(node)) workflowShape(child, shape, seen);
}
/** The workflow files under `dir`; a missing folder holds none, and one that
 * cannot be read is an error result. */
function workflowFiles(dir: string): string[] | Result {
  const listing = listWorkflows(dir);
  if ("missing" in listing)
    return result(0, `OK — ${dir} does not exist (no workflows to check)\n`);
  if ("error" in listing)
    return error(
      listing.error.startsWith("not a directory")
        ? `workflows path is ${listing.error}`
        : listing.error,
    );
  return listing.files;
}
/** Whether one workflow is fork-unsafe, or an error result when it cannot be
 * read as YAML. js-yaml rejects a repeated key, which a parser keeping the
 * last copy would let hide an unsafe step. */
function unsafeWorkflow(path: string): boolean | Result {
  const read = readYaml(path);
  if ("error" in read) return error(read.error);
  const { raw, doc } = read;
  const shape = { untrusted: false, executes: false };
  workflowShape(doc, shape, new Set());
  // The raw text also counts, so a trigger spelling the parsed check does not
  // know over-flags rather than passes.
  const privileged =
    privilegedTrigger(doc) || raw.includes("pull_request_target");
  return privileged && shape.untrusted && shape.executes;
}
export function prTargetSafety(args: string[], env: Environment): Result {
  const files = args.length
    ? args
    : workflowFiles(env.WORKFLOWS_DIR || ".github/workflows");
  if (!Array.isArray(files)) return files;
  let out = "";
  for (const path of files) {
    const unsafe = unsafeWorkflow(path);
    if (typeof unsafe !== "boolean") return unsafe;
    if (unsafe)
      out += `UNSAFE ${path}\n  pull_request_target + checkout of untrusted head/fork code + a run: step or local action.\n  A forked PR can exfiltrate this job's secrets.\n  Fix: under pull_request_target, check out the BASE ref only and treat\n       fork code as data; run the PR's own code on the pull_request\n       trigger (no secrets) and pass results back via artifacts.\n\n`;
  }
  return out
    ? result(
        1,
        out +
          "PR-target safety lint FAILED — fork-unsafe reviewer wiring found.\n",
      )
    : result(0, "OK — no fork-unsafe pull_request_target workflows\n");
}
interface Entry {
  section: string;
  fields: Record<string, string>;
  duplicate: string;
}
/** Parse list entries regardless of which field occurs first. */
function entries(
  path: string,
  fields: string[],
): { keys: string[]; entries: Entry[] } {
  const keys: string[] = [],
    records: Entry[] = [];
  let section = "",
    entry: Entry | undefined;
  const emit = () => {
    if (entry) records.push(entry);
    entry = undefined;
  };
  for (const line of lines(path)) {
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
    if (top) {
      emit();
      section = top[1] || "";
      keys.push(section);
      continue;
    }
    if (/^\s*-\s/.test(line)) {
      emit();
      entry = { section, fields: {}, duplicate: "" };
    }
    if (entry)
      for (const name of fields)
        if (field(name).test(line)) {
          if (name in entry.fields) entry.duplicate = name;
          entry.fields[name] = scalar(line);
        }
  }
  emit();
  return { keys, entries: records };
}
export function formula(args: string[], env: Environment): Result {
  const record = args[0] || env.RECORD || "",
    path =
      args[1] || env.FORMULA || join(dirname(record), "phase-formula.yaml");
  if (!record) return error("no phase record given (arg or RECORD=)");
  if (!file(record)) return error(`phase record not found: ${record}`);
  if (!file(path)) return error(`phase formula not found: ${path}`);
  const phases = entries(path, ["id", "required"]).entries.filter(
      (e) => e.section === "phases",
    ),
    required: string[] = [];
  for (const phase of phases) {
    const id = phase.fields.id || "",
      req = phase.fields.required || "";
    if (phase.duplicate)
      return error(
        `a phase entry in ${path} has a duplicate '${phase.duplicate}:' field`,
      );
    if (!id) return error(`a phase entry in ${path} has no id`);
    if (["true", "yes", "on"].includes(req.toLowerCase()))
      required.push(...id.split(/\s+/));
    else if (!["", "false", "no", "off"].includes(req.toLowerCase()))
      return error(`phase '${id}' has a non-boolean required: '${req}'`);
  }
  if (!phases.length) return error(`no phases declared in ${path}`);
  let status: string | undefined;
  let complete = " ";
  for (const raw of lines(record)) {
    const line = raw.trim().split("#")[0]?.trimEnd() || "";
    if (!line) continue;
    const m = line.match(/^status\s*:(.*)$/);
    if (m) {
      if (status !== undefined)
        return error(`duplicate 'status:' line in record ${record}`);
      status = (m[1] || "")
        .trim()
        .replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b)
        .trim();
      continue;
    }
    const phase = line
      .replace(/^- /, "")
      .replace(/^phase\s*:\s*/, "")
      .trim();
    if (!/^[^\s:]+$/.test(phase))
      return error(
        `unrecognized line in record ${record} (want 'status: <value>' or one phase id per line): ${line}`,
      );
    complete += `${phase} `;
  }
  if (status === undefined)
    return error(`no 'status:' line in record ${record}`);
  if (
    !(env.DONE_STATES || "done closed merged")
      .split(/\s+/)
      .includes(status.toLowerCase())
  )
    return result(
      0,
      `OK — item status '${status}' is not a done state; required-phase gate not yet applicable\n`,
    );
  const absent = required.filter((p) => !complete.includes(` ${p} `));
  if (absent.length)
    return result(
      1,
      `Required-phases gate FAILED — item is '${status}' but a required phase is not recorded complete:\n${absent.map((p) => `  - ${p}\n`).join("")}`,
    );
  return result(
    0,
    `OK — item is '${status}' and every required phase is recorded complete\n`,
  );
}
export function corpus(args: string[], env: Environment): Result {
  const path = args[0] || env.CORPUS || "corpus.yaml",
    taxonomy = env.TAXONOMY || join(dirname(path), "miss-taxonomy.yaml");
  if (!file(path)) return error(`corpus not found: ${path}`);
  if (!file(taxonomy)) return error(`taxonomy not found: ${taxonomy}`);
  const declarations = lines(path).filter((l) =>
    /^["']?fixtures["']?\s*:/.test(l),
  );
  if (!declarations.length)
    return error(
      `no 'fixtures:' collection found in ${path} (nothing to validate)`,
    );
  if (declarations.length > 1)
    return error(`more than one 'fixtures:' collection in ${path}`);
  const categories = new Set<string>();
  let inCategories = false;
  for (const line of lines(taxonomy)) {
    if (/^categories:\s*$/.test(line)) {
      inCategories = true;
      continue;
    }
    if (inCategories && /^[a-z_]+:/.test(line)) inCategories = false;
    if (inCategories && /^\s*-\s*id:/.test(line))
      categories.add(line.replace(/^[^:]*:\s*/, "").replace(/\s/g, ""));
  }
  interface Fixture {
    fields: Record<string, string>;
    duplicates: string[];
    validated: boolean;
    date: boolean;
  }
  const fixtures: Fixture[] = [];
  let fx: Fixture | undefined,
    active = false,
    sawItem = false,
    itemIndent = -1,
    fieldIndent = -1,
    validated = false,
    validatedIndent = -1,
    seenValidated = false;
  const emit = () => {
    if (fx) fixtures.push(fx);
    fx = undefined;
  };
  for (const line of lines(path)) {
    const declaration = line.match(/^["']?fixtures["']?\s*:(.*)$/);
    if (declaration) {
      const value = (declaration[1] || "").replace(/(^|\s)#.*$/, "").trim();
      if (value && value !== "[]")
        return error(
          `'fixtures:' in ${path} must be a block list or [], got '${value}'`,
        );
      active = value === "";
      continue;
    }
    if (active && /^["']?[A-Za-z_]/.test(line)) {
      emit();
      active = false;
    }
    if (!active) continue;
    const lineIndent = line.match(/^ */)?.[0].length || 0;
    if (!sawItem && line.trim() && !/^\s*(#|-\s)/.test(line))
      return error(
        `'fixtures:' in ${path} must hold a list of '- ' entries; found: ${line.trim()}`,
      );
    if (sawItem && line.trim() && !/^\s*#/.test(line)) {
      const marker = /^\s*-\s/.test(line);
      if (lineIndent < itemIndent || (lineIndent === itemIndent && !marker))
        return error(
          `'fixtures:' in ${path} must hold only '- ' entries and fields indented under them; found: ${line.trim()}`,
        );
    }
    const isMarker = /^\s*-\s/.test(line),
      isNewItem = isMarker && (!sawItem || lineIndent === itemIndent);
    if (isNewItem) {
      if (!sawItem) itemIndent = lineIndent;
      sawItem = true;
      emit();
      fx = { fields: {}, duplicates: [], validated: false, date: false };
      validated = false;
      validatedIndent = -1;
      seenValidated = false;
      const rest = line.replace(/^\s*-\s+/, "");
      fieldIndent =
        rest.trim() && !rest.startsWith("#") ? line.length - rest.length : -1;
    }
    if (!fx) continue;
    if (!isNewItem && fieldIndent < 0 && line.trim() && !/^\s*#/.test(line))
      fieldIndent = lineIndent;
    const indent = lineIndent;
    if (validated && indent <= validatedIndent) validated = false;
    // Only the fixture mapping's own keys count; anything nested deeper, or in
    // a nested list, belongs to another key.
    const own = isNewItem
      ? fieldIndent >= 0
      : !isMarker && lineIndent === fieldIndent;
    if (own)
      for (const name of [
        "lever",
        "category",
        "pinned_commit",
        "lens",
        "required",
      ])
        if (field(name).test(line)) {
          if (name in fx.fields) fx.duplicates.push(name);
          fx.fields[name] = scalar(line);
        }
    if (own && field("validated").test(line)) {
      if (seenValidated) fx.duplicates.push("validated");
      seenValidated = true;
      if (/^\s*(?:-\s+)?["']?validated["']?\s*:\s*\S/.test(line)) {
        if (!missing(scalar(line))) fx.validated = true;
      } else {
        validated = true;
        validatedIndent = fieldIndent;
      }
      continue;
    }
    if (
      validated &&
      /^\s+["']?date["']?\s*:/.test(line) &&
      !missing(scalar(line))
    ) {
      fx.date = true;
      fx.validated = true;
    }
  }
  emit();
  let out = "",
    errors = 0;
  const seen = new Set<string>(),
    fail = (s: string) => {
      out += `  - ${s}\n`;
      errors++;
    };
  for (const fx of fixtures) {
    const lever = fx.fields.lever || "",
      category = fx.fields.category || "",
      pinned = fx.fields.pinned_commit || "",
      lens = fx.fields.lens || "",
      req = fx.fields.required || "";
    out += `FIX ${lever || "(no lever)"}\n`;
    for (const name of new Set(fx.duplicates))
      fail(`fixture has a duplicate '${name}:' field`);
    if (fx.duplicates.length) continue;
    if (!lever) {
      fail("fixture has no lever id (a record must start with a lever)");
      continue;
    }
    if (!/^L-[0-9]{4}$/.test(lever)) fail(`lever '${lever}' is not L-NNNN`);
    if (seen.has(lever)) fail(`duplicate lever id '${lever}'`);
    else seen.add(lever);
    if (!category) fail("missing category");
    else if (!categories.has(category))
      fail(`category '${category}' not in the taxonomy`);
    if (missing(pinned)) fail("missing pinned_commit (pin the PRE-fix commit)");
    if (missing(lens)) fail("missing lens (every miss gets an additive lens)");
    const required = ["true", "yes", "on"].includes(req.toLowerCase());
    if (!required && !["", "false", "no", "off"].includes(req.toLowerCase()))
      fail(`required: '${req}' is not a recognized boolean (use true/false)`);
    if (required) {
      if (!fx.validated)
        fail("required: true but no validated record (validate before gating)");
      if (!fx.date) fail("validated record has no date");
    }
  }
  return errors
    ? result(
        1,
        out +
          `\nCorpus-lint FAILED: ${errors} problem(s) across ${fixtures.length} fixture(s).\n`,
      )
    : result(0, `${out}\nOK — ${fixtures.length} corpus fixture(s) valid\n`);
}
export function parity(args: string[], env: Environment): Result {
  const path = args[0] || env.TALLIES || "",
    minimum = env.MIN_PRECISION || "0.90";
  if (!/^(0([.][0-9]+)?|1([.]0+)?)$/.test(minimum))
    return error(`MIN_PRECISION must be a decimal in [0,1]: ${minimum}`);
  if (!path) return error("no tallies file given (arg or TALLIES=)");
  if (!file(path)) return error(`tallies file not found: ${path}`);
  const seen = new Set<string>();
  let out = "",
    errors = "",
    missed = false;
  for (const line of lines(path)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [reviewer = "", tp = "", fp = "", miss = "", ...extra] = line
      .trim()
      .split(/\s+/);
    if (
      extra.length ||
      !reviewer ||
      ![tp, fp, miss].every((v) => /^[0-9]+$/.test(v))
    ) {
      errors += `ERROR: bad row: ${line}\n`;
      continue;
    }
    if (seen.has(reviewer)) {
      errors += `ERROR: duplicate reviewer: ${reviewer}\n`;
      continue;
    }
    seen.add(reviewer);
    const positives = Number(tp),
      falsePositives = Number(fp),
      misses = Number(miss),
      denom = positives + falsePositives,
      recallDenom = positives + misses;
    const precision = denom ? (positives / denom).toFixed(2) : "n/a",
      recall = recallDenom ? (positives / recallDenom).toFixed(2) : "n/a",
      promotable = denom && positives / denom >= Number(minimum) ? "yes" : "no";
    out += `${reviewer.padEnd(14)} TP=${tp.padEnd(4)} FP=${fp.padEnd(4)} missed=${miss.padEnd(3)} precision=${precision.padEnd(5)} recall=${recall.padEnd(5)} promotable=${promotable}\n`;
    if (misses > 0) missed = true;
  }
  if (errors) return result(2, out, errors);
  if (!seen.size)
    return result(
      0,
      `${out}\nOK — no reviewers tallied (nothing to measure)\n`,
    );
  return missed
    ? result(
        1,
        out +
          "\nParity gate FAILED — a reviewer missed a blocker an oracle caught (open a lever).\n",
      )
    : result(
        0,
        out +
          `\nOK — no missed blockers; promotable? shown against MIN_PRECISION=${minimum}\n`,
      );
}
class OwnerRecordError extends Error {
  constructor() {
    super("not a reflection lock owner record");
  }
}
const TRANSIENT_LOCK_ERRORS = new Set(["ENOENT", "EPERM", "EBUSY", "EACCES"]),
  MAX_TRANSIENT_LOCK_RETRIES = 400,
  TRANSIENT_LOCK_RETRY_MS = 25;
const errorCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "";
/**
 * The pause between transient-lock retries. `REFLECTION_LOCK_RETRY_MS` is a
 * test pacing seam, not configuration: a probe of the retry bound would
 * otherwise sleep through every production pause. It only lowers the pause;
 * unset or unusable keeps it.
 */
function transientLockRetryMs(env: Environment): number {
  const raw = env.REFLECTION_LOCK_RETRY_MS ?? "";
  return /^[0-9]+$/.test(raw)
    ? Math.min(TRANSIENT_LOCK_RETRY_MS, Math.max(1, Number(raw)))
    : TRANSIENT_LOCK_RETRY_MS;
}
export async function reflection(
  args: string[],
  env: Environment,
  platform: NodeJS.Platform = process.platform,
): Promise<Result> {
  const decisionFile = args[0] || env.DECISION || "",
    change = env.CHANGE || "",
    threshold = env.ROUND_THRESHOLD || "3",
    timeout = env.LOCK_TIMEOUT || "30",
    archive = env.ARCHIVE || "",
    retryMs = transientLockRetryMs(env);
  let inbox = env.INBOX || "";
  if (!decisionFile) return error("no decision file given (arg or DECISION=)");
  if (!file(decisionFile))
    return error(`decision file not found: ${decisionFile}`);
  if (!change)
    return error(
      "CHANGE is required (the aggregation key — a PR number, branch, or ticket key)",
    );
  if (!inbox) return error("INBOX is required (path to the reflection inbox)");
  if (!file(inbox))
    return error(
      `inbox not found: ${inbox} (copy templates/reflection-inbox.md; this script will not create it)`,
    );
  if (archive) {
    try {
      if (!file(archive)) throw new Error("not file");
      accessSync(archive, constants.R_OK);
    } catch {
      return error(
        `ARCHIVE is set but is not a readable regular file: ${archive}\n       (it is part of the duplicate census — skipping it would double-count a processed change)`,
      );
    }
  }
  for (let links = 0; ; links++) {
    if (!lstatSync(inbox).isSymbolicLink()) break;
    if (links >= 16)
      return error(`too many symlink levels for INBOX: ${inbox}`);
    const target = readlinkSync(inbox);
    inbox = isAbsolute(target) ? target : join(dirname(inbox), target);
  }
  if (!file(inbox))
    return error(`inbox symlink does not resolve to a file: ${inbox}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/#@-]*$/.test(change))
    return error(`CHANGE must be a plain identifier, got '${change}'`);
  if (!/^[1-9][0-9]*$/.test(threshold))
    return error(`ROUND_THRESHOLD must be an integer >= 1, got '${threshold}'`);
  if (!/^(0|[1-9][0-9]*)$/.test(timeout))
    return error(
      `LOCK_TIMEOUT must be a non-negative integer (seconds), got '${timeout}'`,
    );
  const records = lines(decisionFile).filter((l) => !/^\s*(#|$)/.test(l));
  if (records.length !== 1)
    return error(
      `expected exactly one decision record in ${decisionFile}, found ${records.length}\n       (a stale record above a current one would otherwise fire on the stale one)`,
    );
  const raw = records[0] || "",
    match = raw.match(
      /^(CONVERGED|WORK|WAIT|ABORT) round=([1-9][0-9]*) open_threads=(0|[1-9][0-9]*) reviewers=(0|[1-9][0-9]*)\/(0|[1-9][0-9]*) pr_state=(open|merged|closed)$/,
    );
  if (!match)
    return error(
      `not a complete M7 convergence record: ${raw}\n       want: <CONVERGED|WORK|WAIT|ABORT> round=<n> open_threads=<n> reviewers=<n>/<n> pr_state=<open|merged|closed>`,
    );
  const [
    ,
    decision = "",
    round = "",
    open = "",
    reported = "",
    expected = "",
    state = "",
  ] = match;
  if (expected === "0")
    return error(
      `record names zero reviewers, so it cannot describe a settled round: ${raw}`,
    );
  if (BigInt(reported) > BigInt(expected))
    return error(
      `record reports more reviewers than it expects (${reported}/${expected}): ${raw}`,
    );
  const derived =
    state !== "open"
      ? "ABORT"
      : BigInt(open) > 0n
        ? "WORK"
        : BigInt(reported) < BigInt(expected)
          ? "WAIT"
          : "CONVERGED";
  if (decision !== derived)
    return error(
      `record says ${decision} but its own fields say ${derived}: ${raw}\n       (open_threads=${open} reviewers=${reported}/${expected} pr_state=${state})`,
    );
  const emit = (kind: string, code: number, reason: string) =>
    result(
      code,
      `${kind} change=${change} rounds=${round} threshold=${threshold}\n`,
      `${reason}\n`,
    );
  if (decision !== "CONVERGED")
    return emit(
      "SKIP",
      3,
      `Decision is ${decision}, not CONVERGED — reflection fires at convergence, when the detail is still there.`,
    );
  if (BigInt(round) < BigInt(threshold))
    return emit(
      "SKIP",
      3,
      `Converged in ${round} round(s), under the threshold of ${threshold} — an ordinary review.`,
    );
  const lock = `${inbox}.lock`,
    owner = String(process.pid),
    staged = `${inbox}.staged.${owner}`;
  // Publish a complete owner record atomically. POSIX symlinks preserve the
  // existing protocol; Windows hard-links a prewritten file without requiring
  // symbolic-link privileges. Neither protocol reclaims a foreign/stale lock.
  const fileOwners = platform === "win32";
  const ownerRecord = `jig-reflection-lock-v1 ${owner} ${randomUUID()}\n`;
  const ownerFile = `${lock}.owner.${randomUUID()}`;
  const lockHolder = () => {
    if (!fileOwners) return readlinkSync(lock);
    const record = readFileSync(lock, "utf8");
    const match = record.match(
      /^jig-reflection-lock-v1 ([1-9][0-9]*) [A-Za-z0-9-]+\n$/,
    );
    if (!match) throw new OwnerRecordError();
    return match[1] || "";
  };
  const release = () => {
    try {
      if (
        fileOwners
          ? readFileSync(lock, "utf8") === ownerRecord
          : readlinkSync(lock) === owner
      )
        unlinkSync(lock);
    } catch {}
    if (fileOwners) {
      try {
        unlinkSync(ownerFile);
      } catch {}
    }
  };
  const { registerCleanup } = await import("../plugin/shared/cleanup.ts");
  let acquired = false;
  using cleanup = registerCleanup(() => {
    if (acquired) release();
  });
  void cleanup;
  try {
    if (fileOwners) writeFileSync(ownerFile, ownerRecord, { flag: "wx" });
    let transient = 0;
    for (let waited = 0; ; ) {
      try {
        if (fileOwners) linkSync(ownerFile, lock);
        else symlinkSync(owner, lock);
        acquired = true;
        break;
      } catch (e) {
        // A contender can see the lock mid-release: on Windows a file that is
        // being deleted cannot be opened, so reads and links fail briefly with
        // one of the transient codes. Those retry on a short sleep that does
        // not count against the whole-second timeout.
        let busy: unknown;
        try {
          if (
            fileOwners
              ? !lstatSync(lock).isFile()
              : !lstatSync(lock).isSymbolicLink()
          )
            return error(
              `lock path exists and is not a ${fileOwners ? "regular owner file" : "symlink"}: ${lock}\n       refusing to remove it — inspect and clear it yourself`,
            );
        } catch (inspection) {
          if (!TRANSIENT_LOCK_ERRORS.has(errorCode(inspection)))
            return error(`cannot inspect lock ${lock}: ${String(inspection)}`);
          busy = inspection;
        }
        if (errorCode(e) !== "EEXIST") {
          if (!(fileOwners && TRANSIENT_LOCK_ERRORS.has(errorCode(e))))
            return error(`cannot create lock ${lock}: ${String(e)}`);
          busy = e;
        }
        let holder = "";
        if (busy === undefined) {
          try {
            holder = lockHolder();
          } catch (read) {
            if (read instanceof OwnerRecordError)
              return error(
                `lock path is not a reflection owner record: ${lock} (refusing to remove it)`,
              );
            if (TRANSIENT_LOCK_ERRORS.has(errorCode(read))) busy = read;
            else if (fileOwners)
              return error(`cannot read lock ${lock}: ${String(read)}`);
          }
        }
        if (busy !== undefined) {
          if (++transient > MAX_TRANSIENT_LOCK_RETRIES)
            return error(
              `lock ${lock} stayed unreadable after ${MAX_TRANSIENT_LOCK_RETRIES} retries: ${String(busy)}`,
            );
          await Bun.sleep(retryMs);
          continue;
        }
        if (BigInt(waited) >= BigInt(timeout)) {
          let alive = false;
          if (/^[1-9][0-9]*$/.test(holder)) {
            try {
              process.kill(Number(holder), 0);
              alive = true;
            } catch (e) {
              alive = (e as NodeJS.ErrnoException).code === "EPERM";
            }
          }
          if (holder && !alive)
            return error(
              `stale lock: ${lock} names PID ${holder}, which is gone. Remove it and re-run:\n       rm -f ${lock}`,
            );
          return error(
            `could not lock ${inbox} within ${timeout}s (held by PID ${holder || "unknown"})`,
          );
        }
        await Bun.sleep(1000);
        waited++;
      }
    }
    const marker = `<!-- reflection: ${change} rounds=${round} -->`;
    for (const haystack of [inbox, ...(archive ? [archive] : [])]) {
      const text = readFileSync(haystack, "utf8"),
        position = text.indexOf(marker);
      if (position < 0) continue;
      const rest = text.slice(position + marker.length).split(/^## /m)[0] || "";
      if (haystack === inbox && /^- disposition: </m.test(rest))
        return emit(
          "PROMPT",
          0,
          `An unfilled record for ${change} is already in ${inbox} — reflection never completed. Re-prompting; fill that record in rather than adding another.`,
        );
      return emit(
        "SKIP",
        3,
        `Already recorded for ${change} at ${round} round(s) (in ${haystack}).`,
      );
    }
    try {
      copyFileSync(inbox, staged);
      chmodSync(staged, statSync(inbox).mode);
    } catch {
      return error(
        `could not stage a replacement for ${inbox} (disk full? quota? read-only directory?)`,
      );
    }
    try {
      appendFileSync(
        staged,
        `\n## ${change} — converged in ${round} rounds (threshold ${threshold})\n\n${marker}\n\n- change: ${change}\n- rounds: ${round}\n- levers: <what under-served this change — an instruction that did not land, a\n  rule the reviewer had to teach twice, a convention that should be mechanised,\n  a reviewer config that let a known class through>\n- disposition: <lever id, or \`reviewer-config\` / \`eval-corpus\` if the reviewer\n  was the one that was wrong repeatedly>\n`,
      );
    } catch {
      return error("could not write the reflection record (disk full? quota?)");
    }
    try {
      renameSync(staged, inbox);
    } catch {
      return error(
        `could not install the updated ${inbox} (left unchanged; nothing was recorded)`,
      );
    }
    return emit(
      "PROMPT",
      0,
      `Recorded in ${inbox} — now run reflection while the detail is still there.`,
    );
  } finally {
    if (acquired) release();
    try {
      unlinkSync(staged);
    } catch {}
    if (fileOwners) {
      try {
        unlinkSync(ownerFile);
      } catch {}
    }
  }
}
export const gates: Record<
  string,
  (args: string[], env: Environment) => Result | Promise<Result>
> = {
  "check-required-sections": requiredSections,
  "check-stage-accepted": stageAccepted,
  "check-threads-resolved": threadsResolved,
  "normalize-thread-states": normalizeThreads,
  "check-round-converged": roundConverged,
  "check-pr-target-safety": prTargetSafety,
  "check-formula": formula,
  "check-corpus": corpus,
  "check-parity": parity,
  "reflection-trigger": reflection,
};
export async function runGate(
  name: string,
  args = process.argv.slice(2),
  env: Environment = process.env,
): Promise<number> {
  let output: Result;
  try {
    const gate = gates[name];
    if (!gate) throw new Error(`unknown gate: ${name}`);
    output = await gate(args, env);
  } catch (e) {
    output = error(String(e));
  }
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  return output.code;
}
