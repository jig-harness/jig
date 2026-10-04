// Read-only host audit. Prints proposed remediation; never changes settings.
// Offline JSON fixtures need neither a network connection nor a Git origin.
import { readFileSync } from "node:fs";
import { cli } from "../lib/cli.ts";

type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function field(root: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value == null) return undefined;
    if (!object(value)) throw new Error(`unexpected parent type for ${path}`);
    return value[key];
  }, root);
}
export function evaluateProtection(value: unknown): {
  status: number;
  lines: string[];
} {
  if (!object(value))
    throw new Error(
      "expected a JSON object from the branch-protection response",
    );
  const types: Record<string, string> = {
    "required_status_checks.contexts": "array",
    "required_status_checks.strict": "boolean",
    "required_pull_request_reviews.required_approving_review_count": "number",
    "required_conversation_resolution.enabled": "boolean",
    "enforce_admins.enabled": "boolean",
    "allow_force_pushes.enabled": "boolean",
    "allow_deletions.enabled": "boolean",
    restrictions: "object",
    "required_pull_request_reviews.bypass_pull_request_allowances": "object",
  };
  for (const [path, type] of Object.entries(types)) {
    const found = field(value, path);
    if (
      found != null &&
      !(type === "array"
        ? Array.isArray(found)
        : type === "object"
          ? object(found)
          : typeof found === type)
    )
      throw new Error(
        `branch-protection JSON has unexpected field types: ${path} must be ${type}`,
      );
  }
  const controls: [string, boolean][] = [
    [
      "required CI status check(s) configured",
      (
        (field(value, "required_status_checks.contexts") ?? []) as unknown[]
      ).includes("gates"),
    ],
    [
      "required status checks are strict",
      field(value, "required_status_checks.strict") === true,
    ],
    [
      "at least one required human review",
      ((field(
        value,
        "required_pull_request_reviews.required_approving_review_count",
      ) ?? 0) as number) >= 1,
    ],
    [
      "required conversation resolution",
      field(value, "required_conversation_resolution.enabled") === true,
    ],
    [
      "administrator enforcement",
      field(value, "enforce_admins.enabled") === true,
    ],
    [
      "force-push disallowed",
      field(value, "allow_force_pushes.enabled") === false,
    ],
    [
      "branch deletion disallowed",
      field(value, "allow_deletions.enabled") === false,
    ],
  ];
  const lines = controls.map(
    ([label, pass]) => `  ${pass ? "PASS" : "FAIL"}  ${label}`,
  );
  lines.push(
    `  required checks: ${((field(value, "required_status_checks.contexts") ?? []) as unknown[]).join(", ") || "none"}`,
  );
  for (const [label, path] of [
    ["restrictions", "restrictions"],
    [
      "PR review bypass_pull_request_allowances",
      "required_pull_request_reviews.bypass_pull_request_allowances",
    ],
  ]) {
    const actors = field(value, path ?? "");
    const names: string[] = [];
    if (actors != null) {
      if (!object(actors)) throw new Error(`invalid actors: ${path}`);
      for (const key of ["users", "teams", "apps"]) {
        const entries = actors[key] ?? [];
        if (!Array.isArray(entries))
          throw new Error(`${path}.${key} must be an array`);
        for (const entry of entries) {
          if (!object(entry)) throw new Error(`invalid ${path}.${key} actor`);
          names.push(String(entry[key === "users" ? "login" : "slug"] ?? ""));
        }
      }
    }
    lines.push(`  bypass actors (${label}): ${names.join(", ") || "none"}`);
  }
  const satisfied = controls.filter(([, pass]) => pass).length;
  lines.push(`${satisfied}/7 controls satisfied`);
  return { status: satisfied === 7 ? 0 : 1, lines };
}
export function remediation(value: Json): Json {
  const checks = object(value.required_status_checks)
    ? value.required_status_checks
    : {};
  const reviews = object(value.required_pull_request_reviews)
    ? value.required_pull_request_reviews
    : {};
  const actors = (source: unknown): unknown => {
    if (source == null) return null;
    if (!object(source)) throw new Error("invalid actor map");
    return Object.fromEntries(
      ["users", "teams", "apps"].map((key) => [
        key,
        ((source[key] ?? []) as Json[]).map(
          (actor) => actor[key === "users" ? "login" : "slug"],
        ),
      ]),
    );
  };
  const existing = (checks.checks ??
    ((checks.contexts ?? []) as string[]).map((context) => ({
      context,
      app_id: null,
    }))) as Json[];
  return {
    required_status_checks: {
      strict: true,
      contexts: [
        ...new Set([...((checks.contexts ?? []) as string[]), "gates"]),
      ].sort(),
      checks: existing.some((check) => check.context === "gates")
        ? existing
        : [...existing, { context: "gates", app_id: null }],
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: Math.max(
        (reviews.required_approving_review_count ?? 0) as number,
        1,
      ),
      dismiss_stale_reviews: reviews.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews.require_code_owner_reviews ?? false,
      require_last_push_approval: reviews.require_last_push_approval ?? false,
      ...(reviews.bypass_pull_request_allowances
        ? {
            bypass_pull_request_allowances: actors(
              reviews.bypass_pull_request_allowances,
            ),
          }
        : {}),
      ...(reviews.dismissal_restrictions
        ? { dismissal_restrictions: actors(reviews.dismissal_restrictions) }
        : {}),
    },
    required_conversation_resolution: true,
    restrictions: actors(value.restrictions),
    allow_force_pushes: false,
    allow_deletions: false,
    ...Object.fromEntries(
      [
        "required_linear_history",
        "block_creations",
        "lock_branch",
        "allow_fork_syncing",
      ].map((key) => [key, field(value, `${key}.enabled`) ?? false]),
    ),
  };
}
function gh(args: string[]) {
  const result = Bun.spawnSync(["gh", "api", ...args], { timeout: 15000 });
  if (result.exitCode !== 0 && !result.stderr.toString().includes("HTTP 404"))
    throw new Error(result.stderr.toString() || "gh api failed or timed out");
  return result;
}
export function checkProtection(args: string[]): number {
  let input = "";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--input") {
      input = args[++index] ?? "";
      if (!input) throw new Error("--input requires a file");
    } else positional.push(args[index] ?? "");
  }
  if (positional.length > 2 || positional.some((arg) => arg.startsWith("-")))
    throw new Error(
      "usage: check-branch-protection.ts [--input FILE|-] [owner/repo] [branch]",
    );
  let [repo, branch] = positional;
  let raw: string;
  if (input) {
    raw = readFileSync(input === "-" ? 0 : input, "utf8");
    repo ||= "(offline input)";
    branch ||= "main";
  } else {
    if (!repo) {
      const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"]);
      if (remote.exitCode !== 0)
        throw new Error("cannot determine origin; pass owner/repo explicitly");
      repo = remote.stdout
        .toString()
        .trim()
        .replace(
          /^(git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)/,
          "",
        )
        .replace(/\.git$/, "");
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
      throw new Error("could not parse an owner/repo from origin");
    branch ||= gh([`repos/${repo}`, "--jq", ".default_branch"])
      .stdout.toString()
      .trim();
    const response = gh([
      `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
    ]);
    raw = response.exitCode === 0 ? response.stdout.toString() : "{}";
  }
  const value: unknown = JSON.parse(raw);
  const result = evaluateProtection(value);
  console.log(
    `Branch protection recheck — ${repo}@${branch}\n${result.lines.join("\n")}`,
  );
  if (result.status && !input && object(value)) {
    console.log("Recommended remediation — review, then a human runs:");
    console.log(
      `gh api --method PUT repos/${repo}/branches/${encodeURIComponent(branch ?? "main")}/protection --input protection-remediation.json`,
    );
    console.log("Save this payload as protection-remediation.json:");
    console.log(JSON.stringify(remediation(value), null, 2));
  }
  return result.status;
}
if (import.meta.main) cli(() => checkProtection(process.argv.slice(2)));
