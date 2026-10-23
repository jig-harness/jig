/** A changelog script's failure with a message for the person running it. */
export class ChangelogError extends Error {}

/** A configuration a changelog script refuses: invalid, or without a value it needs. */
export class ConfigurationError extends ChangelogError {}
