// OpenAI Responses API `input` 항목.
// 호출: { type: "function_call", call_id } / 결과: { type: "function_call_output", call_id }.
// custom_tool_call / custom_tool_call_output 도 같은 방식으로 짝을 맞춘다.
// reasoning 항목은 바로 뒤에 모델 출력 항목(호출·assistant 메시지)이 있어야 한다.
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

const CALL_TYPES: Record<string, string> = {
  function_call: "function_call_output",
  custom_tool_call: "custom_tool_call_output",
};
const OUTPUT_TYPES = new Set(Object.values(CALL_TYPES));

/** role 을 가진 메시지 항목인가(type 이 없거나 "message"). */
function isMessageItem(node: Record<string, unknown>): boolean {
  return typeof node.role === "string" && (node.type === undefined || node.type === "message");
}

export const openaiResponses: Adapter = {
  format: "openai-responses",
  listKey: "input",
  slotKind: "result-messages",
  // Responses 는 같은 턴 안이면 호출·결과가 섞여도 받는다. 턴을 넘긴 결과는 근거가 약해 경고로 둔다.
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
    // web_search_call 처럼 스스로 완결된 모델 출력 항목.
    return one("model", { kind: "content", node });
  },

  write() {
    // 모든 항목이 원자 메시지라 다시 쓸 내용이 없다.
  },

  partSuffix() {
    return "";
  },

  isSlotBoundary(msg) {
    // role 을 가진 메시지(user·system·developer·assistant)가 오면 그 턴의 호출 슬롯이 닫힌다.
    return isObject(msg.node) && isMessageItem(msg.node);
  },

  isEmpty(msg, next) {
    // 호출을 지운 뒤 홀로 남은 reasoning 항목: 제공자가
    // "reasoning was provided without its required following item" 으로 거절한다.
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
    // 합치지 않는다.
  },

  roleOf(msg) {
    return isObject(msg.node) ? str(msg.node.role) : "";
  },
};
