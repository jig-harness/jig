/** A tracker setting that cannot be used; `field` is its dotted path. */
export class TrackerConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}
