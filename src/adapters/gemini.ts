// Gemini `contents`.
// Calls: functionCall parts of a model turn / results: functionResponse parts of the next user (or function) turn.
// Rule: the response turn right after a call turn must hold as many responses as there are calls.
// ids are often missing; if so a positional id "name@message.part" is made and responses are paired with calls by name order.
import type { Adapter, Msg, Part } from "../types.js";
import { isObject, str } from "../util.js";

function sideOf(role: unknown): Msg["side"] {
  if (role === "model") return "model";
  // If role is omitted it counts as user. The legacy Vertex "function" role is also a response turn.
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
        // If there is no id, resolveGeminiIds fills it in by pairing with a call by name.
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
    // Gemini docs: the "error" key of response holds the error, the "output" key holds normal output.
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
 * Pairs id-less functionResponses with calls by name, in two passes.
 *  1) Responses that have an id first claim the call with the same id and name (before the response, nearest one).
 *  2) An id-less response picks, among the remaining calls, one with the same name: the "first" call of the nearest model turn.
 * Doing 1) first keeps an id-less response from stealing another response's call. Within one turn,
 * responses pair up in call order, so repair also inserts a response "after" the existing responses.
 * If there is no match, the response gets its own positional id so it is reported as an orphan result.
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

  // 1) Responses that have an id.
  for (const r of responses) {
    if (!r.part.id) continue;
    let best: { m: number; part: Part } | undefined;
    for (const c of calls) {
      if (c.m >= r.m || claimed.has(c.part) || c.part.id !== r.part.id || !sameName(c.part, r.part)) continue;
      best = c; // Scanning from the front, the last one left is the nearest call.
    }
    if (best) claimed.add(best.part);
  }

  // 2) Responses without an id.
  for (const r of responses) {
    if (r.part.id) continue;
    let best: { m: number; part: Part } | undefined;
    for (const c of calls) {
      if (c.m >= r.m || claimed.has(c.part) || c.part.name !== r.part.name) continue;
      // Prefer the nearer (later) model turn; within the same turn, prefer the earlier call.
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
