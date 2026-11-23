// Intermediate representation (IR): turns per-format JSON into a list of "messages + parts (calls, results)"
// and computes the pairing of calls and results in one pass. validate, repair and trim all use this result.
import { anthropic } from "./adapters/anthropic.js";
import { gemini, resolveGeminiIds } from "./adapters/gemini.js";
import { openaiChat } from "./adapters/openai-chat.js";
import { openaiResponses } from "./adapters/openai-responses.js";
import { describe, detectFormat } from "./detect.js";
import { InvalidInputError, UnknownFormatError } from "./errors.js";
import type { Adapter, Format, FormatOption, Msg, Part } from "./types.js";
import { cloneJson, isObject } from "./util.js";

export const ADAPTERS: Record<Format, Adapter> = {
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  anthropic,
  gemini,
};

const FORMATS = Object.keys(ADAPTERS) as Format[];

/** The working document: the message list, plus what is needed to restore the original shape (array or body object). */
export interface Doc {
  adapter: Adapter;
  msgs: Msg[];
  /** Path prefix: "$" for an array, something like "$.messages" for a body object. */
  base: string;
  /** The body object (a copy) for body-object input, null for array input. */
  body: Record<string, unknown> | null;
  /** If the Responses body's input is a string there is no tool content, so it is returned as is. */
  passthrough: boolean;
  /** Node -> its original path in the input. Keeps the path in change reports always pointing into the input. */
  origin: WeakMap<object, string>;
  /** With previous_response_id or conversation, earlier calls live on the server, so orphans cannot be judged from the local array alone. */
  serverState: boolean;
}

function resolveFormat(input: unknown, option: FormatOption | undefined): Format {
  if (option === undefined || option === "auto") return detectFormat(input);
  if (!FORMATS.includes(option)) {
    throw new InvalidInputError(`unknown format option "${String(option)}" (use ${FORMATS.join(", ")} or auto)`, "unknown-format-option", { option: String(option) });
  }
  return option;
}

/** Reads the input into a document. If clone is true, works on a deep copy (repair, trim). */
export function load(input: unknown, option: FormatOption | undefined, clone: boolean): Doc {
  if (!Array.isArray(input) && !isObject(input)) {
    throw new InvalidInputError(`expected a message array or a request body object, got ${describe(input)}`, "not-conversation", { got: describe(input) });
  }
  const format = resolveFormat(input, option);
  const adapter = ADAPTERS[format];
  const source = clone ? cloneJson(input) : input;

  let list: unknown[];
  let body: Record<string, unknown> | null = null;
  let base = "$";
  let passthrough = false;
  let serverState = false;
  if (Array.isArray(source)) {
    list = source;
  } else {
    body = source as Record<string, unknown>;
    const value = body[adapter.listKey];
    base = `$.${adapter.listKey}`;
    if (Array.isArray(value)) list = value;
    else if (format === "openai-responses" && typeof value === "string") {
      list = [];
      passthrough = true;
    } else throw new UnknownFormatError(`request body has no "${adapter.listKey}" array for format ${format}`, "no-list-for-format", { key: adapter.listKey, format });
    serverState = format === "openai-responses" && (body.previous_response_id != null || body.conversation != null);
  }

  const msgs = list.map((node, i) => adapter.read(node, i));
  if (format === "gemini") resolveGeminiIds(msgs);

  const origin = new WeakMap<object, string>();
  msgs.forEach((msg, i) => {
    if (typeof msg.node === "object" && msg.node !== null) origin.set(msg.node, `${base}[${i}]`);
    msg.parts.forEach((part, j) => {
      if (typeof part.node === "object" && part.node !== null && part.node !== msg.node) {
        origin.set(part.node, `${base}[${i}]${adapter.partSuffix(msg, j)}`);
      }
    });
  });
  return { adapter, msgs, base, body, passthrough, origin, serverState };
}

/** Restores the document to its original shape (an array, or a body object with the same keys). */
export function save(doc: Doc): unknown {
  for (const msg of doc.msgs) {
    if (msg.dirty) {
      doc.adapter.write(msg);
      msg.dirty = false;
    }
  }
  if (doc.passthrough) return doc.body;
  const list = doc.msgs.map((m) => m.node);
  if (!doc.body) return list;
  doc.body[doc.adapter.listKey] = list;
  return doc.body;
}

/** Path of the current position. */
export function pathAt(doc: Doc, m: number, p?: number): string {
  const msg = doc.msgs[m];
  const suffix = p === undefined || !msg ? "" : doc.adapter.partSuffix(msg, p);
  return `${doc.base}[${m}]${suffix}`;
}

/** Original path in the input (the current position for a newly created node). */
export function originPath(doc: Doc, node: unknown, m: number, p?: number): string {
  if (typeof node === "object" && node !== null) {
    const found = doc.origin.get(node);
    if (found) return found;
  }
  return pathAt(doc, m, p);
}

// ---------------------------------------------------------------------------
// Pairing computation
// ---------------------------------------------------------------------------

export interface CallRef {
  m: number;
  p: number;
  part: Part;
  /** An earlier call with the same id already existed. */
  duplicate: boolean;
  result?: ResultRef;
  /** When unpaired: true if the slot is already closed (missing-result), false if still open (open-call-at-end). */
  closed: boolean;
}

export interface ResultRef {
  m: number;
  p: number;
  part: Part;
  call?: CallRef;
  /** Is the paired call inside its allowed place (slot)? */
  adjacent: boolean;
  /** Anthropic: is it before any other content in the message? */
  first: boolean;
  /** A result that cannot be judged locally because of server-side state (not treated as an orphan). */
  unverifiable: boolean;
}

export interface Analysis {
  calls: CallRef[];
  results: ResultRef[];
  /** Positions of empty messages and messages left with only reasoning. */
  empty: number[];
}

/**
 * Do the tool names of a result and its call agree? Only meaningful for formats that carry the name (Gemini).
 * The same id with a different name is not a pair (avoids a wrong pairing when fixing a history where one id was used twice).
 */
export function sameTool(call: Part, result: Part): boolean {
  return !call.name || !result.name || call.name === result.name;
}

/** Takes, among the unpaired calls with the same id, the last (nearest) one whose name matches. */
function takeLatest(stack: CallRef[] | undefined, result: Part): CallRef | undefined {
  if (!stack) return undefined;
  for (let k = stack.length - 1; k >= 0; k--) {
    if (sameTool(stack[k]!.part, result)) return stack.splice(k, 1)[0];
  }
  return undefined;
}

export function analyze(doc: Doc): Analysis {
  const { msgs, adapter } = doc;
  const calls: CallRef[] = [];
  const results: ResultRef[] = [];
  const seenIds = new Set<string>();
  // id -> calls not yet paired (later ones at the end). A result pairs with the nearest earlier call.
  const unmatched = new Map<string, CallRef[]>();
  let sawReference = false;

  // boundaries[i] = number of "slot-closing messages" in msgs[0..i). Checks in O(1) whether a range contains a boundary
  // (so a long history with many unpaired calls is not scanned to the end every time).
  const boundaries = new Array<number>(msgs.length + 1);
  boundaries[0] = 0;
  msgs.forEach((x, i) => {
    boundaries[i + 1] = boundaries[i]! + (adapter.isSlotBoundary(x) ? 1 : 0);
  });
  const boundaryBetween = (from: number, to: number) => boundaries[to]! - boundaries[from]! > 0;

  /** Is the result (at position r) inside the slot of the call (at position c)? */
  const isAdjacent = (c: number, r: number): boolean => {
    if (adapter.slotKind === "next-user-message") return r === c + 1 && msgs[r]?.side === "user";
    // The result must come after the call, with no slot-closing message between them.
    return r > c && !boundaryBetween(c + 1, r);
  };

  msgs.forEach((msg, m) => {
    // A Responses item_reference points to an item stored on the server (it may be a call).
    if (isObject(msg.node) && msg.node.type === "item_reference") sawReference = true;
    msg.parts.forEach((part, p) => {
      const id = part.id ?? "";
      if (part.kind === "call") {
        const call: CallRef = { m, p, part, duplicate: seenIds.has(id), closed: false };
        seenIds.add(id);
        calls.push(call);
        const stack = unmatched.get(id) ?? [];
        stack.push(call);
        unmatched.set(id, stack);
        return;
      }
      if (part.kind !== "result") return;
      const call = takeLatest(unmatched.get(id), part);
      const result: ResultRef = { m, p, part, call, adjacent: false, first: true, unverifiable: false };
      if (call) {
        call.result = result;
        result.adjacent = isAdjacent(call.m, m);
        // If a non-result part precedes this result within the message, it is not at the "very start".
        result.first = msg.parts.slice(0, p).every((q) => q.kind === "result");
      } else {
        result.unverifiable = doc.serverState || sawReference;
      }
      results.push(result);
    });
  });

  // A result stored "before" its call (async save order was swapped): if an unpaired call with the same id comes later,
  // treat it as a misplaced result instead of deleting it as an orphan. That way repair moves the real result instead of discarding it.
  const laterCalls = new Map<string, CallRef[]>();
  for (const call of calls) {
    if (call.result) continue;
    const id = call.part.id ?? "";
    const queue = laterCalls.get(id) ?? [];
    queue.push(call);
    laterCalls.set(id, queue);
  }
  for (const result of results) {
    if (result.call) continue;
    const queue = laterCalls.get(result.part.id ?? "");
    const index = queue?.findIndex((c) => c.m > result.m && sameTool(c.part, result.part)) ?? -1;
    if (!queue || index < 0) continue;
    const call = queue.splice(index, 1)[0]!;
    call.result = result;
    result.call = call;
    result.unverifiable = false;
  }

  // Unpaired call: has the place for its result already passed (closed) or not yet (at the very end, open)?
  for (const call of calls) {
    if (call.result) continue;
    if (adapter.slotKind === "next-user-message") call.closed = call.m + 1 < msgs.length;
    else call.closed = boundaryBetween(call.m + 1, msgs.length);
  }

  const empty: number[] = [];
  msgs.forEach((msg, m) => {
    if (adapter.isEmpty(msg, msgs[m + 1])) empty.push(m);
  });
  return { calls, results, empty };
}
