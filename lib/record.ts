/**
 * The plain-object guard (not null, not an array) for everything outside the
 * plugin. It is the plugin's shared definition re-exported, so a record means
 * one thing everywhere and no second definition exists.
 */
export { isRecord } from "../plugin/shared/guards.ts";
