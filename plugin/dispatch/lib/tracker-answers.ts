/**
 * The comments on an item of a tracker other than the forge, read as the
 * answers to a pickup's decision are read on the forge
 * (`station-answers.ts`): each comment's author named by the tracker, a
 * comment by a trusted author (`CommentFact.trusted`: a real, non-guest
 * member of the tracker's workspace) read as a member's, and a comment by
 * the user the tracker's credential acts as left out, since a dispatcher
 * never answers on a person's behalf.
 *
 * A tracker that cannot name who wrote each comment (`Tracker.commentAuthors`)
 * is not read: one person's answer could not be told from another's, or
 * from the dispatcher's own. The need shows why.
 *
 * Costs: the item's comment list (the adapter's one paged read, which
 * carries the author, link and edit time with the body) and, once a tick,
 * the user the tracker's credential acts as; each bounded by
 * `TRACKER_READ_MS` on top of the transport's own deadline.
 */
import type {
  CommentFact,
  Tracker,
  TrackerUser,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { failureText } from "./text.ts";

/** The longest one read of the tracker for answers runs. */
const TRACKER_READ_MS = 60_000;

/**
 * The association a comment reads as under the forge's rule
 * (`shared/trusted-authors.ts`): a member's for a trusted author, none for
 * anyone else.
 */
const MEMBER = "MEMBER";
const NONE = "NONE";

/**
 * `body` without Markdown's backslash escapes. A tracker hands its comments
 * over as Markdown, which escapes the brackets around an answer's digest
 * (`\[…\]`); the answer grammar reads the text a person wrote.
 */
function plainText(body: string): string {
  return body.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/**
 * Each author's label as answers show it, one per user id: the answer reader
 * tells people apart by this label alone, so no two users share one. A name
 * two users share carries the user's id, and a label that still equals
 * another user's (a name that spells out `Sam (u1)`) is made distinct by
 * the id again.
 */
function namesOf(comments: readonly CommentFact[]): Map<string, string> {
  const ids = new Map<string, Set<string>>();
  for (const { author } of comments) {
    if (author == null) continue;
    const key = author.name.toLowerCase();
    ids.set(key, (ids.get(key) ?? new Set()).add(author.id));
  }
  const authors = new Map<string, string>();
  for (const { author } of comments)
    if (author != null) authors.set(author.id, author.name);
  const wanted = new Map<string, string>();
  for (const [id, name] of authors)
    wanted.set(
      id,
      (ids.get(name.toLowerCase())?.size ?? 0) > 1 ? `${name} (${id})` : name,
    );
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const [id, label] of [...wanted].sort(([x], [y]) =>
    x.localeCompare(y),
  )) {
    let unique = label;
    while (taken.has(unique.toLowerCase())) unique = `${unique} (${id})`;
    taken.add(unique.toLowerCase());
    names.set(id, unique);
  }
  return names;
}

/**
 * The comments of tracker item `item` as the answer reader reads a
 * conversation, `self`'s left out. A comment whose author the tracker does
 * not name reads with no author, which never answers.
 */
function trackerConversation(
  item: string,
  comments: readonly CommentFact[],
  self: TrackerUser,
): CommentLike[] {
  const names = namesOf(comments);
  return comments
    .filter((c) => c.author?.id !== self.id)
    .map((c) => ({
      author: c.author == null ? "" : (names.get(c.author.id) ?? ""),
      association: c.trusted ? MEMBER : NONE,
      at: c.createdAt,
      editedAt: c.editedAt ?? null,
      url: c.url ?? `${item}#comment-${c.id ?? c.createdAt}`,
      body: plainText(c.body),
    }));
}

/** `work`'s value, or why it failed or did not settle within `TRACKER_READ_MS`. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  what: string,
): Promise<Outcome<T, "unreadable">> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  const late = new Promise<Outcome<T, "unreadable">>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(
        failed(
          "unreadable",
          `${what} did not read within ${TRACKER_READ_MS / 1000} s`,
        ),
      );
    }, TRACKER_READ_MS);
  });
  const read = (async (): Promise<Outcome<T, "unreadable">> => {
    try {
      return ok(await work(stop.signal));
    } catch (error) {
      return failed(
        "unreadable",
        `${what} did not read: ${failureText(error)}`,
      );
    }
  })();
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The answers' conversation on `item` of `tracker`, `self` naming the user
 * its credential acts as (asked once a tick by the caller); why it was not
 * read otherwise.
 */
export async function readTrackerAnswers(
  tracker: Tracker | null,
  item: string,
  self: (tracker: Tracker, signal: AbortSignal) => Promise<TrackerUser>,
): Promise<Outcome<CommentLike[], "unreadable">> {
  if (tracker === null)
    return failed(
      "unreadable",
      `the tracker did not open this tick, so the answers on ${item} were not read`,
    );
  if (tracker.commentAuthors !== true)
    return failed(
      "unreadable",
      `the ${tracker.adapter} tracker does not name who wrote each comment, so answers on ${item} cannot be told apart and are not read; settle the decision on the tracker by hand`,
    );
  const me = await bounded(
    (signal) => self(tracker, signal),
    "the user the tracker's credential acts as",
  );
  if (!me.ok) return me;
  const read = await bounded(
    (signal) => tracker.issueComments(item, signal),
    `the comments of ${item}`,
  );
  return read.ok
    ? ok(trackerConversation(item, read.value.comments, me.value))
    : read;
}
