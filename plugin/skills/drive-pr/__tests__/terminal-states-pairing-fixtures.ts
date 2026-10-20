export function createPairingFixtures() {
  const IMPORTS = [
    "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
    "import { outOfBand } from './lib/status/terminal-states.ts';",
  ].join("\n");
  return { IMPORTS };
}
