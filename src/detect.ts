// 형식 판별: 요청 본문 객체의 키를 먼저 보고, 그다음 항목 모양을 본다.
// 도구 내용이 하나도 없는 대화는 어느 형식으로 봐도 이슈가 0건이므로 애매하면 openai-chat 으로 보고한다.
import { InvalidInputError, UnknownFormatError } from "./errors.js";
import type { Format } from "./types.js";
import { isObject } from "./util.js";

// Responses API 의 input 항목 type 값(메시지 외).
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
// Responses 메시지의 content 블록 type 값.
// ("refusal" 은 Chat Completions 에도 있어 신호로 쓰지 않는다.)
const RESPONSES_BLOCK_TYPES = new Set(["input_text", "output_text", "input_image", "input_file"]);
// Anthropic content 블록 가운데 다른 형식에는 없는 type 값.
const ANTHROPIC_BLOCK_TYPES = new Set(["tool_use", "tool_result", "thinking", "redacted_thinking", "document"]);

/** 항목 하나가 가리키는 형식 신호. 신호가 없으면 null(역할만 있는 평범한 메시지). */
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

/** 배열 항목들로 형식을 정한다. hint 는 본문 객체에서 얻은 약한 단서(Anthropic 의 최상위 system). */
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
 * 대화 배열 또는 요청 본문 객체({messages}·{input}·{contents})의 형식을 판별한다.
 * 배열·객체가 아니면 InvalidInputError, 알아볼 수 없는 모양이면 UnknownFormatError.
 */
export function detectFormat(input: unknown): Format {
  if (Array.isArray(input)) return detectList(input, null);
  if (!isObject(input)) {
    throw new InvalidInputError(`expected a message array or a request body object, got ${describe(input)}`, "not-conversation", { got: describe(input) });
  }
  if (Array.isArray(input.contents)) return "gemini";
  if (Array.isArray(input.input) || typeof input.input === "string") return "openai-responses";
  if (Array.isArray(input.messages)) {
    // Chat Completions 본문에는 최상위 system 이 없고, Anthropic 본문에는 있다.
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
