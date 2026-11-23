// Format detection: look at the keys of the request body object first, then at the shape of the items.
// A conversation with no tool content has 0 issues in any format, so when ambiguous it is reported as openai-chat.
import { InvalidInputError, UnknownFormatError } from "./errors.js";
import type { Format } from "./types.js";
import { isObject } from "./util.js";

// Item type values of the Responses API input (other than messages).
const RESPONSES_ITEM_TYPES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
  "item_reference",
  "web_search_call",
  "file_search_call",
  "computer_call",
  "computer_call_output",
  "code_interpreter_call",
  "image_generation_call",
  "local_shell_call",
  "local_shell_call_output",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
]);
// Content block type values of Responses messages.
// ("refusal" also exists in Chat Completions, so it is not used as a signal.)
const RESPONSES_BLOCK_TYPES = new Set(["input_text", "output_text", "input_image", "input_file"]);
// Anthropic content block type values that exist in no other format.
const ANTHROPIC_BLOCK_TYPES = new Set(["tool_use", "tool_result", "thinking", "redacted_thinking", "document"]);

/** The format signal one item points to. null if there is none (a plain message with only a role). */
function signalOf(item: Record<string, unknown>): Format | null {
  if (Array.isArray(item.parts) || item.role === "model") return "gemini";
  if (typeof item.type === "string" && RESPONSES_ITEM_TYPES.has(item.type)) return "openai-responses";
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      if (!isObject(block) || typeof block.type !== "string") continue;
      if (ANTHROPIC_BLOCK_TYPES.has(block.type)) return "anthropic";
      if (RESPONSES_BLOCK_TYPES.has(block.type)) return "openai-responses";
    }
  }
  if ("tool_calls" in item || "tool_call_id" in item || item.role === "tool") return "openai-chat";
  return null;
}

/** Decides the format from the array items. hint is a weak clue from the body object (Anthropic's top-level system). */
function detectList(items: unknown[], hint: Format | null): Format {
  const found = new Set<Format>();
  items.forEach((item, i) => {
    if (!isObject(item)) throw new UnknownFormatError(`item ${i} is not an object`, "item-not-object", { index: i });
    const recognizable = typeof item.role === "string" || typeof item.type === "string" || Array.isArray(item.parts);
    if (!recognizable) throw new UnknownFormatError(`item ${i} has no role, type or parts`, "item-unrecognized", { index: i });
    const signal = signalOf(item);
    if (signal) found.add(signal);
  });
  if (found.size > 1) {
    throw new UnknownFormatError(`mixed message shapes: ${[...found].sort().join(", ")}`, "mixed-shapes", { shapes: [...found].sort().join(", ") });
  }
  if (found.size === 1) return [...found][0]!;
  return hint ?? "openai-chat";
}

/**
 * Detects the format of a conversation array or a request body object ({messages}, {input}, {contents}).
 * Throws InvalidInputError if it is not an array or object, UnknownFormatError if the shape is unrecognizable.
 */
export function detectFormat(input: unknown): Format {
  if (Array.isArray(input)) return detectList(input, null);
  if (!isObject(input)) {
    throw new InvalidInputError(`expected a message array or a request body object, got ${describe(input)}`, "not-conversation", { got: describe(input) });
  }
  if (Array.isArray(input.contents)) return "gemini";
  if (Array.isArray(input.input) || typeof input.input === "string") return "openai-responses";
  if (Array.isArray(input.messages)) {
    // Chat Completions bodies have no top-level system; Anthropic bodies do.
    const hint: Format | null = "system" in input ? "anthropic" : null;
    return detectList(input.messages, hint);
  }
  throw new UnknownFormatError("object has no messages, input or contents array", "no-list");
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
