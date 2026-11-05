/**
 * Make a PR's stored drive state unreadable from inside a stub, for the
 * probes that model it going bad mid-command:
 * `bun corrupt-state.ts <state dir> <PR>`.
 */
import { writeStateRow } from "../../scripts/lib/state/store.ts";

writeStateRow(process.argv[2] as string, process.argv[3] as string, "not json");
