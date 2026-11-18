import { shapeOfKey } from "../skills/do-item/scripts/lib/tracker/keys.ts";
import { isRecordId, readRecord } from "./lib/launches.ts";
import { delegateRelease, reserveRelease } from "./lib/release-needs.ts";
import { releaseTag } from "../shared/records/release-tags.ts";
import { sameToken } from "./result.ts";

/** Reserve the release's filing, then attach the tracker item before completing the follow-up. */
export function releaseOwedMain(
  id: string,
  token: string,
  tag: string,
  item?: string,
): number {
  const record = isRecordId(id) ? readRecord(id) : null;
  if (record?.action !== "followup" || !sameToken(record.token, token)) {
    console.error(
      "jig dispatch release-owed: expected a follow-up record and its token",
    );
    return 2;
  }
  if (!releaseTag(tag) || (item !== undefined && shapeOfKey(item) === null)) {
    console.error(
      "jig dispatch release-owed: expected a release tag and, when supplied, a canonical tracker item",
    );
    return 2;
  }
  if (record.followupOwner === false && item !== undefined) {
    console.error(
      "jig dispatch release-owed: the repository owner files the delegated release",
    );
    return 2;
  }
  const written =
    record.followupOwner === false
      ? delegateRelease(record.repo, tag, id)
      : reserveRelease(record.repo, tag, id, item);
  if (!written.ok) {
    console.error(`jig dispatch release-owed: ${written.failure.reason}`);
    return 2;
  }
  console.log(JSON.stringify(written.value));
  return 0;
}
