/**
 * Reading and rewriting a pull request's body by read-modify-write against
 * its `updated_at`, so a person's edit to the body is not silently
 * overwritten.
 *
 * The forge has no compare-and-set on a body. The change is built from one
 * read, the body is read again just before the write, and a body that moved
 * in between is rebuilt from the newer read, up to `WRITE_ATTEMPTS` times.
 * That leaves a person's edit at risk only inside one request's latency,
 * not inside a round. After the write the body is read back and the change
 * confirmed in it. Every forge call carries the plugin's `gh` deadline.
 */
import { ghCall } from "../../../../shared/proc.ts";

const WRITE_ATTEMPTS = 3;

/** The forge could not read or write the body, or it kept moving. */
export class PrBodyError extends Error {
  override name = "PrBodyError";
}

export interface PrBody {
  body: string;
  updatedAt: string;
  /** The pull request's web url. */
  url: string;
}

/** What the scripts need of the forge: a pull request's body, read and written. */
export interface PrBodyForge {
  read(pr: string): Promise<PrBody>;
  write(pr: string, body: string): Promise<void>;
}

async function gh(args: string[], stdin?: string): Promise<string> {
  const r = await ghCall(args, {
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (r.timedOut)
    throw new PrBodyError(`gh ${args[0] ?? ""} ran past its deadline`);
  if (r.code !== 0)
    throw new PrBodyError(
      `gh exited ${r.code}: ${r.stderr.trim().split("\n").at(-1) ?? ""}`,
    );
  return r.stdout;
}

/** The forge through the signed-in `gh` client. */
export function ghPrBodyForge(): PrBodyForge {
  return {
    async read(pr) {
      const raw = await gh([
        "api",
        `repos/{owner}/{repo}/pulls/${pr}`,
        "--jq",
        '{body: (.body // ""), updatedAt: .updated_at, url: .html_url}',
      ]);
      const v = JSON.parse(raw) as Partial<PrBody>;
      if (
        typeof v.body !== "string" ||
        typeof v.updatedAt !== "string" ||
        typeof v.url !== "string"
      )
        throw new PrBodyError(`pull request #${pr} could not be read`);
      return { body: v.body, updatedAt: v.updatedAt, url: v.url };
    },
    async write(pr, body) {
      await gh(
        [
          "api",
          "--method",
          "PATCH",
          `repos/{owner}/{repo}/pulls/${pr}`,
          "--input",
          "-",
        ],
        JSON.stringify({ body }),
      );
    },
  };
}

/**
 * Apply `change` to the pull request's body. `change` returns the new body,
 * or `null` when the body already holds what it would add. `holds` confirms
 * the change in the body read back after the write.
 */
export async function updatePrBody(
  forge: PrBodyForge,
  pr: string,
  change: (body: string) => string | null,
  holds: (body: string) => boolean,
): Promise<{ url: string; changed: boolean }> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const first = await forge.read(pr);
    const next = change(first.body);
    if (next === null) return { url: first.url, changed: false };
    const again = await forge.read(pr);
    if (again.updatedAt !== first.updatedAt || again.body !== first.body)
      continue;
    await forge.write(pr, next);
    const after = await forge.read(pr);
    if (holds(after.body)) return { url: after.url, changed: true };
  }
  throw new PrBodyError(
    `pull request #${pr}'s body kept changing under ${WRITE_ATTEMPTS} attempts to write it; nothing was lost, run again`,
  );
}
