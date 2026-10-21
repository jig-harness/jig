/** Stable volume identity for macOS device-number drift; absence keeps strict comparison. */
import { run } from "../proc.ts";

export type VolumeIdentityReader = (dir: string) => Promise<string | null>;
export const VOLUME_UUID_RE =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Read the volume containing this directory, without guessing from st_dev. */
export const readVolumeIdentity: VolumeIdentityReader = async (dir) => {
  if (process.platform !== "darwin") return null;
  // df resolves arbitrary directories, including paths macOS maps onto its data volume;
  // diskutil accepts the device it names, but not an arbitrary directory.
  const device = await run(["/bin/df", "-P", dir], { timeoutSec: 2 });
  if (device.code !== 0) return null;
  const match = /^\/dev\/[a-zA-Z0-9]+(?=\s)/m.exec(device.stdout);
  if (match === null) return null;
  const info = await run(["/usr/sbin/diskutil", "info", "-plist", match[0]], {
    timeoutSec: 2,
  });
  if (info.code !== 0) return null;
  const uuid = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/
    .exec(info.stdout)?.[1]
    ?.toLowerCase();
  return uuid !== undefined && VOLUME_UUID_RE.test(uuid) ? uuid : null;
};
