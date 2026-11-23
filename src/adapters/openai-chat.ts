// OpenAI Chat Completions `messages`.
// Calls: tool_calls[] of an assistant message / results: messages with role "tool" (tool_call_id).
// Rule: tool messages must follow, contiguously, right after the assistant message that has tool_calls.
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

export const openaiChat: Adapter = {
  format: "openai-chat",
  listKey: "messages",
  slotKind: "result-messages",
  adjacencySeverity: "error",
  resultsFirst: false,
  mergeSameRole: false,

  read(node) {
    if (!isObject(node)) return { side: "other", parts: [], node, atomic: false, dirty: false };
    const role = node.role;
    if (role === "system" || role === "developer") {
      return { side: "system", parts: [], node, atomic: false, dirty: false };
    }
    if (role === "user") return { side: "user", parts: [], node, atomic: false, dirty: false };
    if (role === "tool") {
      // A tool message is a single result by itself (an atomic message).
      const part: Part = { kind: "result", id: str(node.tool_call_id), node };
      return { side: "result", parts: [part], node, atomic: true, dirty: false };
    }
    if (role === "assistant") {
      const calls = Array.isArray(node.tool_calls) ? node.tool_calls : [];
      const parts: Part[] = calls.map((call: unknown) => {
        if (!isObject(call)) return { kind: "content", node: call };
        const fn = isObject(call.function) ? call.function : {};
        return { kind: "call", id: str(call.id), name: str(fn.name), node: call };
      });
      return { side: "model", parts, node, atomic: false, dirty: false };
    }
    return { side: "other", parts: [], node, atomic: false, dirty: false };
  },

  write(msg) {
    if (!isObject(msg.node) || msg.side !== "model") return;
    // If all calls were removed, do not leave an empty tool_calls array (providers reject []).
    if (msg.parts.length === 0) delete msg.node.tool_calls;
    else msg.node.tool_calls = msg.parts.map((p) => p.node);
  },

  partSuffix(msg, partIndex) {
    return msg.side === "model" ? `.tool_calls[${partIndex}]` : "";
  },

  isSlotBoundary(msg) {
    return msg.side !== "result";
  },

  isEmpty(msg) {
    if (msg.side !== "model" || !isObject(msg.node)) return false;
    if (msg.parts.length > 0) return false;
    const n = msg.node;
    // A message with refusal, audio or function_call has content.
    if (n.refusal || n.audio || n.function_call) return false;
    return isEmptyContent(n.content);
  },

  isUserTurn(msg) {
    return msg.side === "user";
  },

  gluesToNext() {
    return false;
  },

  makeResult(call, text): Msg {
    const node = { role: "tool", tool_call_id: call.id ?? "", content: text };
    return { side: "result", parts: [{ kind: "result", id: call.id ?? "", node }], node, atomic: true, dirty: false };
  },

  makeUserMessage(): Msg {
    throw new Error("openai-chat does not use next-user-message slots");
  },

  merge() {
    // OpenAI Chat accepts consecutive messages with the same role, so they are not merged.
  },

  roleOf(msg) {
    return isObject(msg.node) ? str(msg.node.role) : "";
  },
};
