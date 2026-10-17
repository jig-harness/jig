// The line every command prints first, so a disagreement between the plugin
// version on a machine and the one a CI pins is visible.
import { pluginVersion } from "../../../shared/plugin-version.ts";

/** Which plugin version the command ran as. */
export const banner = (command: string): string =>
  `jig changelog ${command} (plugin ${pluginVersion() ?? "unknown"})`;
