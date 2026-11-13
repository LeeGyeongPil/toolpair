// 수리: 깨진 호출·결과 짝을 결정적으로 고치고, 한 일을 변경 목록(changes)으로 남긴다.
// 순서: 중복 호출 → 고아 결과 → 자리 옮기기 → 빠진 결과 → 빈 메시지. 바뀐 것이 없을 때까지 반복한다.
// 그래서 repair(repair(x).messages) 는 변경 0건(멱등)이다.
import { InvalidInputError } from "./errors.js";
import { analyze, load, originPath, save, type Doc } from "./ir.js";
import type { Change, Msg, Part, RepairOptions, RepairResult } from "./types.js";

export const DEFAULT_SYNTHETIC_RESULT = "[cancelled] no result was recorded";

/** 고칠 거리가 아무리 많아도 이 횟수 안에 끝난다(실제로는 1~3회). 버그로 인한 무한 반복 방지. */
const MAX_PASSES = 10;

function checkOptions(opts: RepairOptions): void {
  if (opts.missingResults !== undefined && opts.missingResults !== "synthesize" && opts.missingResults !== "drop-call") {
    throw new InvalidInputError(`missingResults must be "synthesize" or "drop-call"`, "bad-missing-results");
  }
  if (opts.openCallAtEnd !== undefined && opts.openCallAtEnd !== "keep" && opts.openCallAtEnd !== "cancel") {
    throw new InvalidInputError(`openCallAtEnd must be "keep" or "cancel"`, "bad-open-call");
  }
  const s = opts.syntheticResult;
  if (s !== undefined && typeof s !== "string" && typeof s !== "function") {
    throw new InvalidInputError("syntheticResult must be a string or a function", "bad-synthetic-result");
  }
}

/** 메시지 m 의 조각 p 를 지운다. 원자 메시지(tool 메시지, Responses 항목)는 메시지째 지운다. */
function removePart(doc: Doc, m: number, p: number): void {
  const msg = doc.msgs[m]!;
  if (msg.atomic) doc.msgs.splice(m, 1);
  else {
    msg.parts.splice(p, 1);
    msg.dirty = true;
  }
}

/**
 * 결과를 호출의 슬롯에 넣는다.
 * - result-messages(OpenAI Chat·Responses): 호출 메시지 바로 뒤, 이미 있는 결과들 다음.
 * - next-user-message(Anthropic·Gemini): 바로 다음 user 메시지 안. Anthropic 은 맨 앞 결과 블록들 바로 뒤
 *   (텍스트보다 앞), Gemini 는 기존 응답들 뒤. 다음 메시지가 user 가 아니면 새 user 메시지를 만든다.
 */
function insertResult(doc: Doc, callMsg: Msg, item: Msg | Part): void {
  const k = doc.msgs.indexOf(callMsg);
  if (doc.adapter.slotKind === "result-messages") {
    let at = k + 1;
    while (at < doc.msgs.length && doc.msgs[at]!.side === "result") at++;
    doc.msgs.splice(at, 0, item as Msg);
    return;
  }
  let slot = doc.msgs[k + 1];
  if (!slot || slot.side !== "user") {
    slot = doc.adapter.makeUserMessage([]);
    doc.msgs.splice(k + 1, 0, slot);
  }
  let at = 0;
  if (doc.adapter.resultsFirst) {
    // Anthropic: 맨 앞의 결과 블록들 바로 뒤(=텍스트보다 앞).
    while (at < slot.parts.length && slot.parts[at]!.kind === "result") at++;
  } else {
    // Gemini: id 가 없으면 응답 순서로 짝을 맞추므로 기존 응답들의 "뒤"에 넣어 순서를 지킨다.
    slot.parts.forEach((part, i) => {
      if (part.kind === "result") at = i + 1;
    });
  }
  slot.parts.splice(at, 0, item as Part);
  slot.dirty = true;
}

/** 같은 id 의 호출이 두 번 나오면 뒤의 것을 지운다(먼저 나온 것을 남긴다). */
function dropDuplicateCalls(doc: Doc, changes: Change[]): void {
  const dups = analyze(doc).calls.filter((c) => c.duplicate);
  for (const c of dups) changes.push({ op: "drop-call", path: originPath(doc, c.part.node, c.m, c.p), ids: [c.part.id ?? ""] });
  // 뒤에서부터 지워야 앞의 위치가 밀리지 않는다.
  for (const c of [...dups].reverse()) removePart(doc, c.m, c.p);
}

/** 앞에 짝 호출이 없는 결과를 지운다(슬라이딩 윈도우가 호출만 잘라 냈을 때). */
function dropOrphanResults(doc: Doc, changes: Change[]): void {
  const orphans = analyze(doc).results.filter((r) => !r.call && !r.unverifiable);
  for (const r of orphans) {
    changes.push({ op: "drop-orphan-result", path: originPath(doc, r.part.node, r.m, r.p), ids: [r.part.id ?? ""] });
  }
  for (const r of [...orphans].reverse()) removePart(doc, r.m, r.p);
}

/**
 * 짝은 있지만 자리가 틀린 결과(인접하지 않음·맨 앞이 아님)를 슬롯으로 옮긴다.
 * 한 번 분석한 결과로 모두 모아서 옮긴다(옮길 때마다 다시 분석하면 수리 수에 비례해 느려진다).
 * 옮긴 뒤 생긴 새 어긋남은 repairDoc 의 다음 반복이 잡는다.
 */
function moveResults(doc: Doc, changes: Change[]): void {
  const targets = analyze(doc).results.filter(
    (r) => r.call && (!r.adjacent || (doc.adapter.resultsFirst && !r.first)),
  );
  if (targets.length === 0) return;
  for (const target of targets) {
    changes.push({ op: "move-result", path: originPath(doc, target.part.node, target.m, target.p), ids: [target.part.id ?? ""] });
  }
  // 1) 옮길 항목을 모두 뽑아낸다(객체로 식별하므로 순서에 상관없이 안전하다).
  const movedMsgs = new Set<Msg>();
  const movedParts = new Set<Part>();
  const partOwners = new Set<Msg>();
  const resultMsgOf = (m: number) => doc.msgs[m]!;
  for (const target of targets) {
    if (doc.adapter.slotKind === "result-messages") movedMsgs.add(resultMsgOf(target.m));
    else {
      movedParts.add(target.part);
      partOwners.add(resultMsgOf(target.m));
    }
  }
  const callMsgs = targets.map((t) => doc.msgs[t.call!.m]!);
  const items: (Msg | Part)[] = targets.map((t) => (doc.adapter.slotKind === "result-messages" ? resultMsgOf(t.m) : t.part));
  if (movedMsgs.size > 0) doc.msgs = doc.msgs.filter((msg) => !movedMsgs.has(msg));
  for (const owner of partOwners) {
    owner.parts = owner.parts.filter((part) => !movedParts.has(part));
    owner.dirty = true;
  }
  // 2) 앞에서부터 차례로 각자의 호출 슬롯에 넣는다.
  items.forEach((item, i) => insertResult(doc, callMsgs[i]!, item));
}

/** 결과 없이 지나간 호출을 닫는다: 합성 결과를 넣거나(synthesize) 호출을 지운다(drop-call). 한 번 분석한 결과로 모두 처리한다. */
function closeMissingCalls(doc: Doc, opts: RepairOptions, changes: Change[]): void {
  const cancelOpen = opts.openCallAtEnd === "cancel";
  const calls = analyze(doc).calls.filter((c) => !c.result && (c.closed || cancelOpen));
  if (calls.length === 0) return;
  const paths = calls.map((c) => originPath(doc, c.part.node, c.m, c.p));
  if (opts.missingResults === "drop-call") {
    calls.forEach((c, i) => changes.push({ op: "drop-call", path: paths[i]!, ids: [c.part.id ?? ""] }));
    // 뒤에서부터 지워야 앞의 위치가 밀리지 않는다.
    for (const c of [...calls].reverse()) removePart(doc, c.m, c.p);
    return;
  }
  const s = opts.syntheticResult;
  const callMsgs = calls.map((c) => doc.msgs[c.m]!);
  calls.forEach((c, i) => {
    const id = c.part.id ?? "";
    const text = typeof s === "function" ? String(s({ id, name: c.part.name ?? "" })) : (s ?? DEFAULT_SYNTHETIC_RESULT);
    changes.push({ op: "insert-synthetic-result", path: paths[i]!, ids: [id] });
    // 메시지 객체로 위치를 찾으므로 앞선 삽입으로 인덱스가 밀려도 안전하다.
    insertResult(doc, callMsgs[i]!, doc.adapter.makeResult(c.part, text));
  });
}

/**
 * 빈 메시지·추론만 남은 메시지를 지운다. Anthropic·Gemini 에서 지운 자리 양옆이 같은 역할이면
 * 하나로 합쳐(merge-same-role) 원래 있던 user/assistant 번갈아 나오기를 지킨다.
 */
function dropEmptyMessages(doc: Doc, changes: Change[]): void {
  const empty = new Set(analyze(doc).empty);
  if (empty.size === 0) return;
  const out: Msg[] = [];
  let droppedSinceLast = false;
  doc.msgs.forEach((msg, i) => {
    if (empty.has(i)) {
      changes.push({ op: "drop-empty-message", path: originPath(doc, msg.node, i), ids: [] });
      droppedSinceLast = true;
      return;
    }
    const prev = out[out.length - 1];
    const sameRole =
      prev !== undefined &&
      (prev.side === "user" || prev.side === "model") &&
      prev.side === msg.side &&
      doc.adapter.roleOf(prev) === doc.adapter.roleOf(msg);
    if (droppedSinceLast && doc.adapter.mergeSameRole && sameRole) {
      changes.push({ op: "merge-same-role", path: originPath(doc, prev.node, out.length - 1), ids: [] });
      doc.adapter.merge(prev, msg);
    } else {
      out.push(msg);
    }
    droppedSinceLast = false;
  });
  doc.msgs = out;
}

/** 문서를 제자리에서 수리하고 변경을 changes 에 쌓는다(trimToBudget 도 이 함수를 쓴다). */
export function repairDoc(doc: Doc, opts: RepairOptions, changes: Change[]): void {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = changes.length;
    dropDuplicateCalls(doc, changes);
    dropOrphanResults(doc, changes);
    moveResults(doc, changes);
    closeMissingCalls(doc, opts, changes);
    dropEmptyMessages(doc, changes);
    if (changes.length === before) return;
  }
}

/**
 * 깨진 호출·결과 짝을 고친 복사본을 돌려준다. 입력은 바꾸지 않는다.
 * 돌려준 messages 는 입력과 같은 모양(배열이면 배열, 본문 객체면 같은 키의 본문 객체)이다.
 */
export function repair<T>(input: T, opts: RepairOptions = {}): RepairResult<T> {
  checkOptions(opts);
  const doc = load(input, opts.format, true);
  const changes: Change[] = [];
  repairDoc(doc, opts, changes);
  return { messages: save(doc) as T, format: doc.adapter.format, changes };
}
