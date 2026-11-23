// Items of the OpenAI Responses API `input`.
// Calls: { type: "function_call", call_id } / results: { type: "function_call_output", call_id }.
// custom_tool_call / custom_tool_call_output are paired the same way.
// A reasoning item must be followed right away by a model output item (a call or an assistant message).
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

const CALL_TYPES: Record<string, string> = {
  function_call: "function_call_output",
  custom_tool_call: "custom_tool_call_output",
};
const OUTPUT_TYPES = new Set(Object.values(CALL_TYPES));

/** Is this a message item with a role (type is missing or "message")? */
function isMessageItem(node: Record<string, unknown>): boolean {
  return typeof node.role === "string" && (node.type === undefined || node.type === "message");
}

export const openaiResponses: Adapter = {
  format: "openai-responses",
  listKey: "input",
  slotKind: "result-messages",
  // Responses accepts calls and results mixed within the same turn. A result across turns has weak grounds, so it is only a warning.
  adjacencySeverity: "warning",
  resultsFirst: false,
  mergeSameRole: false,

  read(node) {
    const one = (side: Msg["side"], part: Part): Msg => ({ side, parts: [part], node, atomic: true, dirty: false });
    if (!isObject(node)) return { side: "other", parts: [], node, atomic: false, dirty: false };
    const type = node.type;
    if (typeof type === "string" && type in CALL_TYPES) {
      return one("model", { kind: "call", id: str(node.call_id), name: str(node.name), node });
    }
    if (typeof type === "string" && OUTPUT_TYPES.has(type)) {
      return one("result", { kind: "result", id: str(node.call_id), node });
    }
    if (type === "reasoning") return one("model", { kind: "thinking", node });
    if (type === "item_reference") return one("other", { kind: "content", node });
    if (isMessageItem(node)) {
      const role = node.role;
      const side = role === "user" ? "user" : role === "assistant" ? "model" : "system";
      return one(side, { kind: "content", node });
    }
    // A self-contained model output item such as web_search_call.
    return one("model", { kind: "content", node });
  },

  write() {
    // Every item is an atomic message, so there is nothing to rewrite.
  },

  partSuffix() {
    return "";
  },

  isSlotBoundary(msg) {
    // A message with a role (user, system, developer, assistant) closes the call slot of that turn.
    return isObject(msg.node) && isMessageItem(msg.node);
  },

  isEmpty(msg, next) {
    // A reasoning item left alone after its call was removed: the provider
    // rejects it with "reasoning was provided without its required following item".
    if (msg.parts[0]?.kind !== "thinking") return false;
    if (!next) return true;
    return !(next.side === "model" && next.parts[0]?.kind !== "thinking");
  },

  isUserTurn(msg) {
    return msg.side === "user";
  },

  gluesToNext(msg) {
    return msg.parts[0]?.kind === "thinking";
  },

  makeResult(call, text): Msg {
    const callType = isObject(call.node) ? str(call.node.type) : "function_call";
    const node = { type: CALL_TYPES[callType] ?? "function_call_output", call_id: call.id ?? "", output: text };
    return { side: "result", parts: [{ kind: "result", id: call.id ?? "", node }], node, atomic: true, dirty: false };
  },

  makeUserMessage(): Msg {
    throw new Error("openai-responses does not use next-user-message slots");
  },

  merge() {
    // Do not merge.
  },

  roleOf(msg) {
    return isObject(msg.node) ? str(msg.node.role) : "";
  },
};
