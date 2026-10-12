/**
 * The skill's own section of `.config/jig.yaml`.
 *
 * The section was called `do_issue` before the skill became `do-item`, and the
 * old name is deliberately not read. It is refused instead of ignored: an
 * ignored `do_issue` would run with default routing, no scouts and no
 * mandatory review gates, quietly weakening the repository's review policy on
 * a machine that updated before the repository renamed its section.
 */

export const RENAMED_SECTION_MESSAGE =
  "the do_issue section of .config/jig.yaml is now called do_item: rename the section (its fields are unchanged) and run again";

/** Throws with the rename instruction when the overlay still has `do_issue`. */
export function refuseRenamedSection(
  overlay: Record<string, unknown> | null,
): void {
  if (overlay !== null && Object.hasOwn(overlay, "do_issue"))
    throw new Error(RENAMED_SECTION_MESSAGE);
}

/** The raw `do_item` section, after refusing the pre-rename name. */
export function doItemSection(
  overlay: Record<string, unknown> | null,
): unknown {
  refuseRenamedSection(overlay);
  return overlay?.do_item;
}
