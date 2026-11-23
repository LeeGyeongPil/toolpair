// Public types and the adapter interface, gathered in one place.
// Every function passes only these types, so to add a new format, read this file first.

/** The 4 supported conversation history formats. */
export type Format = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

/** Format option: specify it directly, or leave it to detection with "auto" (the default). */
export type FormatOption = Format | "auto";

/** The 7 check rules. Same names as the README rule table. */
export type RuleId =
  | "orphan-result"
  | "missing-result"
  | "open-call-at-end"
  | "duplicate-call-id"
  | "result-not-adjacent"
  | "result-not-first"
  | "empty-message";

export type Severity = "error" | "warning";

/** One problem returned by validate. path is a JSON path in the input (`$[1]`, `$.messages[2].content[0]`). */
export interface Issue {
  rule: RuleId;
  severity: Severity;
  path: string;
  ids: string[];
}

export interface ValidateResult {
  format: Format;
  /** true if there are 0 errors. Warnings do not prevent ok. */
  ok: boolean;
  issues: Issue[];
}

/** One thing repair did. path always points to a position in the "input you passed". */
export type ChangeOp =
  | "drop-orphan-result"
  | "insert-synthetic-result"
  | "move-result"
  | "drop-call"
  | "drop-empty-message"
  | "merge-same-role";

export interface Change {
  op: ChangeOp;
  path: string;
  ids: string[];
}

export interface ValidateOptions {
  format?: FormatOption;
}

export interface RepairOptions {
  format?: FormatOption;
  /** A call that moved on to the next turn with no result: insert a synthetic result (default) or remove the call. */
  missingResults?: "synthesize" | "drop-call";
  /** An open call at the very end: it may still be running, so it is left alone by default. With "cancel" it is closed using the missingResults policy. */
  openCallAtEnd?: "keep" | "cancel";
  /** Text of the synthetic result. Default "[cancelled] no result was recorded". */
  syntheticResult?: string | ((call: { id: string; name: string }) => string);
}

export interface RepairResult<T> {
  messages: T;
  format: Format;
  changes: Change[];
}

export interface TrimOptions {
  /** Upper limit of tokens to keep (only the conversation array is counted). */
  budget: number;
  /** Token count of one message. Defaults to the approximation defaultCountTokens. Passing a real tokenizer is recommended. */
  countTokens?: (message: unknown) => number;
  /** Messages always kept: the leading system/developer messages and the first user message. Both default to true. */
  pin?: { system?: boolean; firstUser?: boolean };
  format?: FormatOption;
}

export interface TrimResult<T> {
  messages: T;
  format: Format;
  /** Total tokens of the remaining messages. */
  tokens: number;
  /** Number of dropped atomic units (a call + results group, or a single message). */
  droppedUnits: number;
  /** true if the pinned messages + the last unit alone exceed the budget (the result is still always valid). */
  overBudget: boolean;
  /** Change list of the repair applied before trimming. */
  changes: Change[];
}

// ---------------------------------------------------------------------------
// Internal intermediate representation (IR). Not public API, but needed to read the adapters.
// ---------------------------------------------------------------------------

/** One part inside a message: a call, result, reasoning, or other content. */
export interface Part {
  kind: "call" | "result" | "thinking" | "content";
  /** Call/result id. If there is none, as in Gemini, the adapter makes one from the position. */
  id?: string;
  /** Tool name (used for synthetic results and Gemini pairing). */
  name?: string;
  /** The original JSON node (a copy). This node is used as is when writing output. */
  node: unknown;
}

/**
 * One message.
 * - side: its role in the pairing rules. "result" is a separate message that holds only results (OpenAI tool, Responses output).
 * - atomic: the message itself is a single part (OpenAI tool message, Responses item). Removing the part removes the message.
 */
export interface Msg {
  side: "system" | "user" | "model" | "result" | "other";
  parts: Part[];
  node: unknown;
  atomic: boolean;
  /** true if parts changed and node must be rewritten. */
  dirty: boolean;
}

/** Kind of place (slot) where a result must come. */
export type SlotKind =
  /** The result comes as a separate message after the call (OpenAI Chat, Responses). */
  | "result-messages"
  /** The result comes as a part inside the very next user message (Anthropic, Gemini). */
  | "next-user-message";

/** An adapter holding the per-format differences. Pair checking, repair and trim logic is implemented once on top of this interface. */
export interface Adapter {
  format: Format;
  /** The key of the request body object that holds the conversation array. */
  listKey: "messages" | "input" | "contents";
  slotKind: SlotKind;
  /** Severity of result-not-adjacent (a warning for formats with weak grounds). */
  adjacencySeverity: Severity;
  /** Must the result come at the very start of the user message, as in Anthropic? */
  resultsFirst: boolean;
  /** Whether to merge when user/user or model/model become adjacent (only where an empty message was removed). */
  mergeSameRole: boolean;
  /** JSON node -> message (IR). Does not modify the input. index is used for Gemini positional ids. */
  read(node: unknown, index: number): Msg;
  /** Writes parts back into node (called only when dirty). */
  write(msg: Msg): void;
  /** Part path suffix (`.tool_calls[0]`, `.content[1]`, `.parts[0]`, "" for atomic messages). */
  partSuffix(msg: Msg, partIndex: number): string;
  /** result-messages slot: is this message a boundary that closes the slot (results after it are not adjacent)? */
  isSlotBoundary(msg: Msg): boolean;
  /** Is it an empty message or one left with only reasoning? next is the very next message (for Responses reasoning detection). */
  isEmpty(msg: Msg, next: Msg | undefined): boolean;
  /** Is it a real user turn (not a message that only carries tool results)? */
  isUserTurn(msg: Msg): boolean;
  /** Must it not be separated from the next message in a trim unit (Responses reasoning -> next item)? */
  gluesToNext(msg: Msg): boolean;
  /** Creates a synthetic result part (next-user-message) or result message (result-messages). */
  makeResult(call: Part, text: string): Msg | Part;
  /** Creates a new user message when there is no next-user-message slot. */
  makeUserMessage(parts: Part[]): Msg;
  /** Merges two messages with the same role into one (appends the later content to the earlier message). */
  merge(into: Msg, from: Msg): void;
  /** Role name used for the same-role check. */
  roleOf(msg: Msg): string;
}
