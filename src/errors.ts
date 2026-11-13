// Exceptions thrown by the library. Use instanceof to tell them apart.
// Every error also carries a stable `code` and machine-readable `params`, so callers
// (like the CLI) can show their own wording while `message` stays English.

/** Stable identifiers for the failures toolpair reports. */
export type ErrorCode =
  | "item-not-object"
  | "item-unrecognized"
  | "mixed-shapes"
  | "no-list"
  | "no-list-for-format"
  | "not-conversation"
  | "unknown-format-option"
  | "bad-budget"
  | "bad-count-tokens"
  | "circular"
  | "bad-missing-results"
  | "bad-open-call"
  | "bad-synthetic-result";

export type ErrorParams = Record<string, string | number>;

/** Parent of every exception toolpair throws. */
export class ToolpairError extends Error {
  /** Stable machine-readable identifier of the failure. */
  readonly code: ErrorCode | undefined;
  /** Values that fill the message (for example the item index or the format name). */
  readonly params: ErrorParams;

  constructor(message: string, code?: ErrorCode, params: ErrorParams = {}) {
    super(message);
    this.name = "ToolpairError";
    this.code = code;
    this.params = params;
  }
}

/** Input that is not an array or request body object (number, string, null...), or a bad option. */
export class InvalidInputError extends ToolpairError {
  constructor(message: string, code?: ErrorCode, params: ErrorParams = {}) {
    super(message, code, params);
    this.name = "InvalidInputError";
  }
}

/** An array or object whose provider format cannot be determined. */
export class UnknownFormatError extends ToolpairError {
  constructor(message: string, code?: ErrorCode, params: ErrorParams = {}) {
    super(message, code, params);
    this.name = "UnknownFormatError";
  }
}
