/**
 * The follow-up marker: a hidden-marker comment on a merged pull request
 * that claims its follow-up. The tick posts one naming its launch record
 * before it starts the follow-up's session; a follow-up a person runs by
 * hand posts one saying so (`run: manual`) and edits it to `outcome: done`
 * once its last act succeeded.
 *
 *   <!-- jig-dispatch-followup -->
 *   jig dispatch follow-up · record: <launch record id>
 *
 *   <!-- jig-dispatch-followup -->
 *   jig dispatch follow-up · run: manual · outcome: running|done
 *
 * A marker counts only when written by the dispatcher's own login or by an
 * owner, member or collaborator, as the drive trusts a ledger; of two
 * trusted markers the earlier comment (the lower id) wins. Every forge call
 * goes through `ghCall`, under its deadline, and either answers or says why
 * it could not.
 */
import { isRecord } from "../../shared/guards.ts";
import { TRUSTED_ASSOCIATIONS } from "../../shared/trusted-authors.ts";
import { forge } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { isRecordId } from "./launches.ts";
import type { FollowupMarker } from "./types.ts";

export const MARKER = "<!-- jig-dispatch-followup -->";

/** A tick's marker, naming the launch record it starts the follow-up under. */
export function tickMarker(record: string): string {
  return `${MARKER}\njig dispatch follow-up · record: ${record}`;
}

/** A manual run's marker, carrying its own outcome. */
export function manualMarker(done: boolean): string {
  return `${MARKER}\njig dispatch follow-up · run: manual · outcome: ${done ? "done" : "running"}`;
}

/** What a marker's body says, or why it does not read. */
function parseMarker(body: string): FollowupMarker["run"] {
  const line = body.split("\n")[1]?.trim() ?? "";
  const tick = /^jig dispatch follow-up · record: (\S+)$/.exec(line);
  if (tick !== null && isRecordId(tick[1] as string))
    return { kind: "tick", record: tick[1] as string };
  const manual =
    /^jig dispatch follow-up · run: manual · outcome: (running|done)$/.exec(
      line,
    );
  if (manual !== null) return { kind: "manual", done: manual[1] === "done" };
  return {
    kind: "unreadable",
    reason: `its body does not read as a marker: ${JSON.stringify(line.slice(0, 80))}`,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A comment's author, and whether the dispatcher trusts what they write. */
function authorOf(
  c: Record<string, unknown>,
  self: string | null,
): { login: string; trusted: boolean } {
  const login = isRecord(c.user) ? text(c.user.login) : "";
  return {
    login,
    trusted:
      (self !== null && login === self) ||
      TRUSTED_ASSOCIATIONS.has(text(c.author_association)),
  };
}

function markerOf(c: unknown, self: string | null): FollowupMarker | null {
  if (!isRecord(c) || typeof c.id !== "number") return null;
  const body = text(c.body).replace(/\r\n/g, "\n");
  if (!body.startsWith(`${MARKER}\n`) && body !== MARKER) return null;
  return {
    id: c.id,
    ...authorOf(c, self),
    createdAt: text(c.created_at),
    run: parseMarker(body),
  };
}

/** Every follow-up marker on the pull request, earliest first, or why they could not be read. */
export async function readMarkers(
  slug: string,
  pr: number,
  self: string | null,
): Promise<FollowupMarker[] | { unreadable: string }> {
  const r = await forge([
    "api",
    "--paginate",
    "--slurp",
    `repos/${slug}/issues/${pr}/comments?per_page=100`,
  ]);
  if (!r.ok) return { unreadable: `the comments could not be read (${r.why})` };
  let pages: unknown;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    return { unreadable: "the comment listing is not JSON" };
  }
  const out: FollowupMarker[] = [];
  for (const page of Array.isArray(pages) ? pages : [pages]) {
    if (!Array.isArray(page))
      return { unreadable: "the comment listing is not a list" };
    for (const c of page) {
      const marker = markerOf(c, self);
      if (marker !== null) out.push(marker);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Post a marker: its comment id, or why the post failed. */
export async function postMarker(
  slug: string,
  pr: number,
  body: string,
): Promise<number | string> {
  const r = await forge(
    ["api", `repos/${slug}/issues/${pr}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
  if (!r.ok) return r.why;
  try {
    const posted: unknown = JSON.parse(r.stdout);
    return isRecord(posted) && typeof posted.id === "number"
      ? posted.id
      : "the forge answered the post without a comment id";
  } catch {
    return "the forge answered the post without JSON";
  }
}

/** Rewrite a marker's body; `""` when it was written, else why not. */
export async function editMarker(
  slug: string,
  id: number,
  body: string,
): Promise<string> {
  const r = await forge(
    [
      "api",
      "-X",
      "PATCH",
      `repos/${slug}/issues/comments/${id}`,
      "--input",
      "-",
    ],
    JSON.stringify({ body }),
  );
  return r.ok ? "" : r.why;
}

/** Delete a marker; `""` when it was deleted, else why not. */
export async function deleteMarker(slug: string, id: number): Promise<string> {
  const r = await forge([
    "api",
    "-X",
    "DELETE",
    `repos/${slug}/issues/comments/${id}`,
  ]);
  return r.ok ? "" : r.why;
}

/** The trusted markers, earliest first. */
export function trustedMarkers(
  markers: readonly FollowupMarker[],
): FollowupMarker[] {
  return markers.filter((m) => m.trusted);
}

/**
 * After posting the marker `own`: the earlier trusted marker that wins over
 * it, or `null` when `own` is the earliest.
 */
export function earlierThan(
  markers: readonly FollowupMarker[],
  own: number,
): FollowupMarker | null {
  return trustedMarkers(markers).find((m) => m.id < own) ?? null;
}

/** The run a posted marker must still read as: the tick's own record, or a manual run. */
export type ExpectedRun = { kind: "tick"; record: string } | { kind: "manual" };

/** Whether a marker's body still says what its poster wrote. */
function readsAs(run: FollowupMarker["run"], expected: ExpectedRun) {
  if (expected.kind === "manual") return run.kind === "manual" && !run.done;
  return run.kind === "tick" && run.record === expected.record;
}

/** Whether the read-back lists marker `id` as a trusted marker that still reads as `expected`: a listing that lags behind the post does not, and an edited body is not the claim. */
export function listsOwn(
  markers: readonly FollowupMarker[],
  id: number,
  expected: ExpectedRun,
): boolean {
  return trustedMarkers(markers).some(
    (m) => m.id === id && readsAs(m.run, expected),
  );
}

/** What the read-back after posting marker `own` shows: it stands, or why not. */
export type ReadBack =
  | { kind: "stands" }
  | { kind: "unreadable"; reason: string }
  | { kind: "missing" }
  | { kind: "altered" }
  | { kind: "earlier"; marker: FollowupMarker };

export function readBack(
  markers: FollowupMarker[] | { unreadable: string },
  own: number,
  expected: ExpectedRun,
): ReadBack {
  if ("unreadable" in markers)
    return { kind: "unreadable", reason: markers.unreadable };
  const earlier = earlierThan(markers, own);
  if (earlier !== null) return { kind: "earlier", marker: earlier };
  if (listsOwn(markers, own, expected)) return { kind: "stands" };
  const listed = trustedMarkers(markers).some((m) => m.id === own);
  return { kind: listed ? "altered" : "missing" };
}
