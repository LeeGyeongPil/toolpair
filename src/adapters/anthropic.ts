// Anthropic Messages API `messages`.
// 호출: assistant content 의 tool_use 블록 / 결과: user content 의 tool_result 블록(tool_use_id).
// 규칙: tool_result 는 "바로 다음" user 메시지에, 그 content 의 "맨 앞"에 와야 한다.
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

/** content(문자열·블록 배열·null)를 조각 목록으로. 문자열은 text 블록 하나로 본다. */
function readBlocks(content: unknown, side: "user" | "model"): Part[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ kind: "content", node: { type: "text", text: content } }];
  }
  if (!Array.isArray(content)) return [];
  return content.map((block: unknown): Part => {
    if (!isObject(block)) return { kind: "content", node: block };
    if (side === "model" && block.type === "tool_use") {
      return { kind: "call", id: str(block.id), name: str(block.name), node: block };
    }
    if (side === "user" && block.type === "tool_result") {
      return { kind: "result", id: str(block.tool_use_id), node: block };
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") return { kind: "thinking", node: block };
    return { kind: "content", node: block };
  });
}

export const anthropic: Adapter = {
  format: "anthropic",
  listKey: "messages",
  slotKind: "next-user-message",
  adjacencySeverity: "error",
  resultsFirst: true,
  mergeSameRole: true,

  read(node) {
    if (!isObject(node)) return { side: "other", parts: [], node, atomic: false, dirty: false };
    if (node.role === "user") return { side: "user", parts: readBlocks(node.content, "user"), node, atomic: false, dirty: false };
    if (node.role === "assistant") {
      return { side: "model", parts: readBlocks(node.content, "model"), node, atomic: false, dirty: false };
    }
    return { side: "other", parts: [], node, atomic: false, dirty: false };
  },

  write(msg) {
    // 조각이 바뀐 메시지만 블록 배열로 다시 쓴다(안 바뀐 문자열 content 는 그대로 남는다).
    if (isObject(msg.node)) msg.node.content = msg.parts.map((p) => p.node);
  },

  partSuffix(_msg, partIndex) {
    return `.content[${partIndex}]`;
  },

  isSlotBoundary() {
    return true;
  },

  isEmpty(msg) {
    if (msg.side !== "user" && msg.side !== "model") return false;
    // 빈 content, 또는 thinking 블록만 남은 메시지(도구 블록을 지운 뒤 흔히 생긴다).
    return msg.parts.every((p) => p.kind === "thinking");
  },

  isUserTurn(msg) {
    return msg.side === "user" && !msg.parts.some((p) => p.kind === "result");
  },

  gluesToNext() {
    return false;
  },

  makeResult(call, text): Part {
    // 취소된 호출이므로 is_error 로 표시해 모델이 성공한 결과로 오해하지 않게 한다.
    const node = { type: "tool_result", tool_use_id: call.id ?? "", content: text, is_error: true };
    return { kind: "result", id: call.id ?? "", node };
  },

  makeUserMessage(parts): Msg {
    return { side: "user", parts, node: { role: "user", content: [] }, atomic: false, dirty: true };
  },

  merge(into, from) {
    into.parts.push(...from.parts);
    into.dirty = true;
  },

  roleOf(msg) {
    return isObject(msg.node) ? str(msg.node.role) : "";
  },
};
