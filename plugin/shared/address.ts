/**
 * Addresses: the name of one station of the execution line on one piece of
 * work, `station@repository#key` (`drive@jig-harness/jig#456`). An address
 * is derived from the records the station leaves, never declared
 * ([ADR-0014](../../docs/adr/ADR-0014-addresses-are-derived-and-requests-are-records.md)),
 * so nothing registers one and an address nobody holds is still valid.
 *
 * - **The station** is one of a closed list in code (`STATIONS`).
 * - **The repository** is `owner/name` as the forge writes it. On input the
 *   short name is accepted where the machine's dispatch file lists exactly
 *   one repository of that name, and it may be left out (`drive#456`) inside
 *   a checkout, which then names it.
 * - **The key** is the piece of work: a pull request's number for `drive`
 *   and `followup`, the tracker's item key for `pickup`. Some shells give `#`
 *   a meaning of their own, so the key is also taken as a second argument
 *   (`drive@jig 456`).
 *
 * Parsing is pure and returns an `Outcome`: a malformed address, an unknown
 * station, a repository that names none or two, and a key not in its
 * tracker's or forge's form are each a failure with a reason that a usage
 * error prints; the reason for a malformed address or an unknown station
 * lists the valid stations. A tracker key's form belongs to the tracker
 * adapter, which this module does not import, so a caller passes the
 * check (`TrackerKeyForm`).
 */
import { failed, ok, type Outcome } from "./outcome.ts";

/** The stations of the line that leave records keyed by a piece of work. */
const STATIONS = ["pickup", "drive", "followup"] as const;
export type Station = (typeof STATIONS)[number];

/** The stations whose key is a pull request's number. */
const PULL_REQUEST_STATIONS: ReadonlySet<Station> = new Set([
  "drive",
  "followup",
]);

/** An address resolved: its repository in full and its key in canonical form. */
export interface Address {
  station: Station;
  /** `owner/name`. */
  repo: string;
  /** A pull request's number in decimal, or the tracker's canonical item key. */
  key: string;
}

/** An address as written: the repository as given, `null` where it was left out. */
export interface WrittenAddress {
  station: Station;
  repo: string | null;
  key: string;
}

/** A repository this machine knows: one its dispatch file lists. */
export interface KnownRepository {
  /** `owner/name`, or `null` where its checkout names no forge repository. */
  slug: string | null;
  path: string;
}

/** What a written repository resolves against. */
export interface RepositoryChoices {
  /** The repositories the machine's dispatch file lists. */
  known: readonly KnownRepository[];
  /** The repository of the checkout the command runs in; `null` outside one, or where it names no forge repository. */
  checkout: string | null;
}

/** A tracker's item key form: the key in canonical form, or `null` when it names no item of that tracker. */
export type TrackerKeyForm = (input: string) => string | null;

const FULL_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHORT_REPO = /^[A-Za-z0-9._-]+$/;
/** A key as written, before its station's form is checked: no whitespace, no separator. */
const RAW_KEY = /^[A-Za-z0-9#_.-]+$/;
const PR_NUMBER = /^#?([1-9][0-9]*)$/;

/** The valid stations, for a usage error. */
export function stationList(): string {
  return STATIONS.join(", ");
}

function isStation(value: string): value is Station {
  return (STATIONS as readonly string[]).includes(value);
}

const malformed = (input: string, why: string) =>
  failed(
    "malformed",
    `${JSON.stringify(input)} is not an address: ${why}. An address is station@owner/name#key (drive@jig-harness/jig#456); the stations are ${stationList()}`,
  );

/**
 * Split `input` into its parts. `second` is the key given as a second
 * argument, which an address that already names a key refuses.
 */
export function parseAddress(
  input: string,
  second?: string,
): Outcome<WrittenAddress, "malformed" | "unknown-station"> {
  const text = input.trim();
  const hash = text.indexOf("#");
  const head = hash < 0 ? text : text.slice(0, hash);
  const inline = hash < 0 ? null : text.slice(hash + 1);
  const at = head.indexOf("@");
  const station = at < 0 ? head : head.slice(0, at);
  const repo = at < 0 ? null : head.slice(at + 1);
  if (station === "") return malformed(input, "it names no station");
  if (!isStation(station))
    return failed(
      "unknown-station",
      `${JSON.stringify(station)} is not a station; the stations are ${stationList()}`,
    );
  if (repo !== null && !FULL_REPO.test(repo) && !SHORT_REPO.test(repo))
    return malformed(
      input,
      `${JSON.stringify(repo)} is not a repository (owner/name, or its name)`,
    );
  if (inline !== null && second !== undefined)
    return malformed(input, "it names its key twice");
  const key = (inline ?? second ?? "").trim();
  if (key === "") return malformed(input, "it names no key");
  if (!RAW_KEY.test(key))
    return malformed(input, `${JSON.stringify(key)} is not a key`);
  return ok({ station, repo, key });
}

/**
 * The repository a written one names, in full: an `owner/name` as it is; a
 * short name when the dispatch file lists exactly one repository of that
 * name; none, the checkout's.
 */
export function resolveRepository(
  written: string | null,
  choices: RepositoryChoices,
): Outcome<
  string,
  "unknown-repository" | "ambiguous-repository" | "no-repository"
> {
  if (written === null)
    return choices.checkout === null
      ? failed(
          "no-repository",
          "the address names no repository and this directory is in no checkout of one; write it as station@owner/name#key",
        )
      : ok(choices.checkout);
  if (FULL_REPO.test(written)) return ok(written);
  const named = [
    ...new Set(
      choices.known
        .map((r) => r.slug)
        .filter(
          (slug): slug is string =>
            slug !== null &&
            slug.split("/")[1]?.toLowerCase() === written.toLowerCase(),
        ),
    ),
  ];
  if (named.length === 1) return ok(named[0] as string);
  if (named.length > 1)
    return failed(
      "ambiguous-repository",
      `${written} names ${named.length} repositories the dispatch file lists (${named.join(", ")}); write the one you mean as owner/name`,
    );
  return failed(
    "unknown-repository",
    `the dispatch file lists no repository named ${written}; write it as owner/name`,
  );
}

/**
 * A key in its station's form: a pull request's number for `drive` and
 * `followup` (`456` or `#456`), the tracker's form for `pickup`, which
 * `tracker` checks (`null` when the tracker's form is not known here).
 */
export function checkKey(
  station: Station,
  key: string,
  tracker: TrackerKeyForm | null,
): Outcome<string, "malformed-key"> {
  if (PULL_REQUEST_STATIONS.has(station)) {
    const m = PR_NUMBER.exec(key);
    return m !== null && Number.isSafeInteger(Number(m[1]))
      ? ok(m[1] as string)
      : failed(
          "malformed-key",
          `${JSON.stringify(key)} is not a pull request's number, which a ${station} address's key is`,
        );
  }
  if (tracker === null)
    return failed(
      "malformed-key",
      `the tracker of this repository is not known here, so the item key ${JSON.stringify(key)} cannot be checked against its form; run the command in a checkout of the repository, or one the dispatch file lists`,
    );
  const canonical = tracker(key);
  return canonical === null
    ? failed(
        "malformed-key",
        `${JSON.stringify(key)} is not an item key of this repository's tracker`,
      )
    : ok(canonical);
}

/** An address as every answer prints it: the repository in full, a pull request's key after `#`, an item key as the tracker writes it. */
export function formatAddress(address: Address): string {
  const key = address.key.startsWith("#") ? address.key.slice(1) : address.key;
  return `${address.station}@${address.repo}#${key}`;
}
