// 중간 표현(IR): 형식별 JSON 을 "메시지 + 조각(호출·결과)" 목록으로 바꾸고,
// 호출과 결과의 짝을 한 번에 계산한다. validate·repair·trim 이 모두 이 결과를 쓴다.
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

/** 작업 중인 문서: 메시지 목록과, 원래 모양(배열/본문 객체)으로 되돌리는 데 필요한 정보. */
export interface Doc {
  adapter: Adapter;
  msgs: Msg[];
  /** 경로 접두사: 배열이면 "$", 본문 객체면 "$.messages" 같은 꼴. */
  base: string;
  /** 본문 객체 입력이면 그 객체(복사본), 배열 입력이면 null. */
  body: Record<string, unknown> | null;
  /** Responses 본문의 input 이 문자열이면 도구 내용이 없으므로 그대로 돌려준다. */
  passthrough: boolean;
  /** 노드 → 입력 안의 원래 경로. 변경 보고서의 path 가 언제나 입력을 가리키게 한다. */
  origin: WeakMap<object, string>;
  /** previous_response_id·conversation 을 쓰면 앞선 호출이 서버에 있어 로컬 배열만으로 고아를 판정할 수 없다. */
  serverState: boolean;
}

function resolveFormat(input: unknown, option: FormatOption | undefined): Format {
  if (option === undefined || option === "auto") return detectFormat(input);
  if (!FORMATS.includes(option)) {
    throw new InvalidInputError(`unknown format option "${String(option)}" (use ${FORMATS.join(", ")} or auto)`, "unknown-format-option", { option: String(option) });
  }
  return option;
}

/** 입력을 문서로 읽는다. clone 이 true 면 깊은 복사본 위에서 작업한다(repair·trim). */
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

/** 문서를 원래 모양(배열 또는 같은 키를 가진 본문 객체)으로 되돌린다. */
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

/** 현재 위치의 경로. */
export function pathAt(doc: Doc, m: number, p?: number): string {
  const msg = doc.msgs[m];
  const suffix = p === undefined || !msg ? "" : doc.adapter.partSuffix(msg, p);
  return `${doc.base}[${m}]${suffix}`;
}

/** 입력 안의 원래 경로(새로 만든 노드면 현재 위치). */
export function originPath(doc: Doc, node: unknown, m: number, p?: number): string {
  if (typeof node === "object" && node !== null) {
    const found = doc.origin.get(node);
    if (found) return found;
  }
  return pathAt(doc, m, p);
}

// ---------------------------------------------------------------------------
// 짝 계산
// ---------------------------------------------------------------------------

export interface CallRef {
  m: number;
  p: number;
  part: Part;
  /** 앞에 같은 id 의 호출이 이미 있었다. */
  duplicate: boolean;
  result?: ResultRef;
  /** 짝이 없을 때: 슬롯이 이미 닫혔으면 true(missing-result), 아직 열려 있으면 false(open-call-at-end). */
  closed: boolean;
}

export interface ResultRef {
  m: number;
  p: number;
  part: Part;
  call?: CallRef;
  /** 짝 호출이 허용된 자리(슬롯) 안에 있는가. */
  adjacent: boolean;
  /** Anthropic: 메시지 안에서 다른 내용보다 앞에 있는가. */
  first: boolean;
  /** 서버 쪽 상태 때문에 로컬로는 판정할 수 없는 결과(고아로 보지 않는다). */
  unverifiable: boolean;
}

export interface Analysis {
  calls: CallRef[];
  results: ResultRef[];
  /** 빈 메시지·추론만 남은 메시지의 위치. */
  empty: number[];
}

/**
 * 결과와 호출의 도구 이름이 어긋나지 않는가. 이름을 함께 싣는 형식(Gemini)에서만 의미가 있다.
 * id 가 같아도 이름이 다르면 짝이 아니다(같은 id 가 두 번 쓰인 기록을 고칠 때 엉뚱한 짝을 막는다).
 */
export function sameTool(call: Part, result: Part): boolean {
  return !call.name || !result.name || call.name === result.name;
}

/** 같은 id 의 짝 없는 호출들 가운데, 이름이 맞는 가장 뒤(가장 가까운) 호출을 꺼낸다. */
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
  // id → 아직 짝이 없는 호출들(뒤에 나온 것이 끝). 결과는 가장 가까운 앞 호출과 짝짓는다.
  const unmatched = new Map<string, CallRef[]>();
  let sawReference = false;

  // boundaries[i] = msgs[0..i) 안의 "슬롯을 닫는 메시지" 개수. 구간 안에 경계가 있는지를 O(1)로 본다
  // (긴 기록에서 짝 없는 호출이 많아도 매번 끝까지 훑지 않게).
  const boundaries = new Array<number>(msgs.length + 1);
  boundaries[0] = 0;
  msgs.forEach((x, i) => {
    boundaries[i + 1] = boundaries[i]! + (adapter.isSlotBoundary(x) ? 1 : 0);
  });
  const boundaryBetween = (from: number, to: number) => boundaries[to]! - boundaries[from]! > 0;

  /** 결과(위치 r)가 호출(위치 c)의 슬롯 안에 있는가. */
  const isAdjacent = (c: number, r: number): boolean => {
    if (adapter.slotKind === "next-user-message") return r === c + 1 && msgs[r]?.side === "user";
    // 결과는 호출 뒤에 있고, 둘 사이에 슬롯을 닫는 메시지가 없어야 한다.
    return r > c && !boundaryBetween(c + 1, r);
  };

  msgs.forEach((msg, m) => {
    // Responses 의 item_reference 는 서버에 저장된 항목(호출일 수도 있다)을 가리킨다.
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
        // 메시지 안에서 이 결과 앞에 결과가 아닌 조각이 있으면 "맨 앞"이 아니다.
        result.first = msg.parts.slice(0, p).every((q) => q.kind === "result");
      } else {
        result.unverifiable = doc.serverState || sawReference;
      }
      results.push(result);
    });
  });

  // 호출보다 "앞에" 저장된 결과(비동기 저장 순서가 뒤바뀐 경우): 뒤에 같은 id 의 짝 없는 호출이 있으면
  // 고아로 지우지 않고 자리가 틀린 결과로 본다. 그래야 수리가 실제 결과를 버리지 않고 옮긴다.
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

  // 짝 없는 호출: 결과가 올 자리가 이미 지나갔는지(닫힘) 아직인지(맨 끝, 열림).
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
