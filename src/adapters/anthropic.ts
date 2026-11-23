// Anthropic Messages API `messages`.
// Calls: tool_use blocks in assistant content / results: tool_result blocks (tool_use_id) in user content.
// Rule: a tool_result must be in the "next" user message, at the "very start" of its content.
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

/** content (string, block array or null) as a list of parts. A string counts as a single text block. */
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
    // Rewrite only messages whose parts changed as a block array (unchanged string content stays as is).
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
    // Empty content, or a message left with only thinking blocks (common after removing tool blocks).
    return msg.parts.every((p) => p.kind === "thinking");
  },

  isUserTurn(msg) {
    return msg.side === "user" && !msg.parts.some((p) => p.kind === "result");
  },

  gluesToNext() {
    return false;
  },

  makeResult(call, text): Part {
    // Cancelled call, so mark it is_error so the model does not mistake it for a successful result.
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
