/**
 * The release of the plugin this tick runs from, which every row of the
 * outcome log, every tick receipt and every launch record names: a run
 * counts under the release in effect when it was launched, whatever release
 * is installed when it ends. Read from the plugin's manifest; `undefined`
 * when no manifest is beside this copy, and then the record names none.
 */
import { pluginVersion } from "../../shared/plugin-version.ts";

/** The release in effect now, or `undefined` when the copy has no manifest. */
export function releaseOf(): string | undefined {
  return pluginVersion() ?? undefined;
}
