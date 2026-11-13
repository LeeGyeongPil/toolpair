// Gemini `contents`.
// 호출: model 턴의 functionCall 부분 / 결과: 바로 다음 user(또는 function) 턴의 functionResponse 부분.
// 규칙: 호출 턴 바로 뒤 응답 턴에 호출 개수만큼 응답이 있어야 한다.
// id 가 없는 경우가 많아, 없으면 "이름@메시지.부분" 위치 id 를 만들고 응답은 이름 순서로 짝을 맞춘다.
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

function sideOf(role: unknown): Msg["side"] {
  if (role === "model") return "model";
  // role 을 생략하면 user 로 본다. 예전 Vertex 형식의 "function" 역할도 응답 턴이다.
  if (role === undefined || role === "user" || role === "function") return "user";
  return "other";
}

export const gemini: Adapter = {
  format: "gemini",
  listKey: "contents",
  slotKind: "next-user-message",
  adjacencySeverity: "error",
  resultsFirst: false,
  mergeSameRole: true,

  read(node, index) {
    if (!isObject(node)) return { side: "other", parts: [], node, atomic: false, dirty: false };
    const side = sideOf(node.role);
    const raw = Array.isArray(node.parts) ? node.parts : [];
    const parts = raw.map((part: unknown, j: number): Part => {
      if (!isObject(part)) return { kind: "content", node: part };
      if (side === "model" && isObject(part.functionCall)) {
        const name = str(part.functionCall.name);
        const id = str(part.functionCall.id) || `${name}@${index}.${j}`;
        return { kind: "call", id, name, node: part };
      }
      if (side === "user" && isObject(part.functionResponse)) {
        // id 가 없으면 resolveGeminiIds 가 이름으로 짝을 찾아 채운다.
        return { kind: "result", id: str(part.functionResponse.id), name: str(part.functionResponse.name), node: part };
      }
      if (part.thought === true) return { kind: "thinking", node: part };
      return { kind: "content", node: part };
    });
    return { side, parts, node, atomic: false, dirty: false };
  },

  write(msg) {
    if (isObject(msg.node)) msg.node.parts = msg.parts.map((p) => p.node);
  },

  partSuffix(_msg, partIndex) {
    return `.parts[${partIndex}]`;
  },

  isSlotBoundary() {
    return true;
  },

  isEmpty(msg) {
    if (msg.side !== "user" && msg.side !== "model") return false;
    return msg.parts.every((p) => p.kind === "thinking");
  },

  isUserTurn(msg) {
    return msg.side === "user" && !msg.parts.some((p) => p.kind === "result");
  },

  gluesToNext() {
    return false;
  },

  makeResult(call, text): Part {
    const callNode = isObject(call.node) && isObject(call.node.functionCall) ? call.node.functionCall : {};
    const explicitId = str(callNode.id);
    // Gemini 문서: response 의 "error" 키는 오류 내용, "output" 키는 정상 출력.
    const functionResponse: Record<string, unknown> = { name: call.name ?? "", response: { error: text } };
    if (explicitId) functionResponse.id = explicitId;
    return { kind: "result", id: call.id ?? "", name: call.name ?? "", node: { functionResponse } };
  },

  makeUserMessage(parts): Msg {
    return { side: "user", parts, node: { role: "user", parts: [] }, atomic: false, dirty: true };
  },

  merge(into, from) {
    into.parts.push(...from.parts);
    into.dirty = true;
  },

  roleOf(msg) {
    if (!isObject(msg.node)) return "";
    return sideOf(msg.node.role) === "user" ? "user" : str(msg.node.role);
  },
};

/**
 * id 없는 functionResponse 를 이름으로 호출과 짝짓는다. 두 단계로 한다.
 *  1) id 를 가진 응답이 먼저 같은 id·이름의 호출(응답보다 앞, 가장 가까운 것)을 차지한다.
 *  2) id 없는 응답은 남은 호출 가운데 같은 이름을 고른다: 가장 가까운 model 턴의 "첫" 호출.
 * 1)을 먼저 해야 id 없는 응답이 다른 응답의 호출을 가로채지 않는다. 같은 턴 안에서는
 * 응답 순서 = 호출 순서로 짝지어지므로, 수리할 때도 응답을 기존 응답들 "뒤"에 넣는다.
 * 짝이 없으면 응답 자신의 위치 id 를 붙여 고아 결과로 보고되게 한다.
 */
export function resolveGeminiIds(msgs: Msg[]): void {
  const claimed = new Set<Part>();
  const calls: { m: number; part: Part }[] = [];
  const responses: { m: number; j: number; part: Part }[] = [];
  msgs.forEach((msg, m) => {
    msg.parts.forEach((part, j) => {
      if (part.kind === "call") calls.push({ m, part });
      if (part.kind === "result") responses.push({ m, j, part });
    });
  });
  const sameName = (a: Part, b: Part) => !a.name || !b.name || a.name === b.name;

  // 1) id 를 가진 응답.
  for (const r of responses) {
    if (!r.part.id) continue;
    let best: { m: number; part: Part } | undefined;
    for (const c of calls) {
      if (c.m >= r.m || claimed.has(c.part) || c.part.id !== r.part.id || !sameName(c.part, r.part)) continue;
      best = c; // 앞에서부터 훑으므로 마지막으로 남는 것이 가장 가까운 호출.
    }
    if (best) claimed.add(best.part);
  }

  // 2) id 없는 응답.
  for (const r of responses) {
    if (r.part.id) continue;
    let best: { m: number; part: Part } | undefined;
    for (const c of calls) {
      if (c.m >= r.m || claimed.has(c.part) || c.part.name !== r.part.name) continue;
      // 더 가까운(뒤쪽) model 턴을 고르고, 같은 턴에서는 앞의 호출을 고른다.
      if (!best || c.m > best.m) best = c;
    }
    if (best) {
      claimed.add(best.part);
      r.part.id = best.part.id;
    } else {
      r.part.id = `${r.part.name ?? ""}@${r.m}.${r.j}`;
    }
  }
}
