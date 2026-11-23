// Repair: deterministically fixes broken call/result pairs and records what was done as a change list (changes).
// Order: duplicate calls -> orphan results -> moving into place -> missing results -> empty messages. Repeats until nothing changes.
// So repair(repair(x).messages) makes 0 changes (idempotent).
import { InvalidInputError } from "./errors.js";
import { analyze, load, originPath, save, type Doc } from "./ir.js";
import type { Change, Msg, Part, RepairOptions, RepairResult } from "./types.js";

export const DEFAULT_SYNTHETIC_RESULT = "[cancelled] no result was recorded";

/** However much there is to fix, it finishes within this many passes (in practice 1-3). Guards against infinite loops from bugs. */
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

/** Removes part p of message m. An atomic message (tool message, Responses item) is removed as a whole message. */
function removePart(doc: Doc, m: number, p: number): void {
  const msg = doc.msgs[m]!;
  if (msg.atomic) doc.msgs.splice(m, 1);
  else {
    msg.parts.splice(p, 1);
    msg.dirty = true;
  }
}

/**
 * Puts a result into the slot of its call.
 * - result-messages (OpenAI Chat, Responses): right after the call message, after the results already there.
 * - next-user-message (Anthropic, Gemini): inside the very next user message. Anthropic puts it right after the leading result blocks
 *   (before text), Gemini after the existing responses. If the next message is not a user message, a new user message is created.
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
    // Anthropic: right after the leading result blocks (= before text).
    while (at < slot.parts.length && slot.parts[at]!.kind === "result") at++;
  } else {
    // Gemini: without ids responses pair by order, so insert "after" the existing responses to keep the order.
    slot.parts.forEach((part, i) => {
      if (part.kind === "result") at = i + 1;
    });
  }
  slot.parts.splice(at, 0, item as Part);
  slot.dirty = true;
}

/** If a call with the same id appears twice, removes the later one (keeps the earlier one). */
function dropDuplicateCalls(doc: Doc, changes: Change[]): void {
  const dups = analyze(doc).calls.filter((c) => c.duplicate);
  for (const c of dups) changes.push({ op: "drop-call", path: originPath(doc, c.part.node, c.m, c.p), ids: [c.part.id ?? ""] });
  // Remove from the back so earlier positions do not shift.
  for (const c of [...dups].reverse()) removePart(doc, c.m, c.p);
}

/** Removes results that have no paired call before them (when a sliding window cut off only the calls). */
function dropOrphanResults(doc: Doc, changes: Change[]): void {
  const orphans = analyze(doc).results.filter((r) => !r.call && !r.unverifiable);
  for (const r of orphans) {
    changes.push({ op: "drop-orphan-result", path: originPath(doc, r.part.node, r.m, r.p), ids: [r.part.id ?? ""] });
  }
  for (const r of [...orphans].reverse()) removePart(doc, r.m, r.p);
}

/**
 * Moves results that are paired but misplaced (not adjacent, not at the very start) into their slot.
 * Collects and moves them all from one analysis (re-analyzing after every move makes repair slow in proportion to the number of repairs).
 * New mismatches created by moving are caught by the next iteration of repairDoc.
 */
function moveResults(doc: Doc, changes: Change[]): void {
  const targets = analyze(doc).results.filter(
    (r) => r.call && (!r.adjacent || (doc.adapter.resultsFirst && !r.first)),
  );
  if (targets.length === 0) return;
  for (const target of targets) {
    changes.push({ op: "move-result", path: originPath(doc, target.part.node, target.m, target.p), ids: [target.part.id ?? ""] });
  }
  // 1) Pull out every item to move (identified by object, so order does not matter).
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
  // 2) Put each into its call's slot, from the front.
  items.forEach((item, i) => insertResult(doc, callMsgs[i]!, item));
}

/** Closes calls that passed with no result: inserts a synthetic result (synthesize) or removes the call (drop-call). Handles all from one analysis. */
function closeMissingCalls(doc: Doc, opts: RepairOptions, changes: Change[]): void {
  const cancelOpen = opts.openCallAtEnd === "cancel";
  const calls = analyze(doc).calls.filter((c) => !c.result && (c.closed || cancelOpen));
  if (calls.length === 0) return;
  const paths = calls.map((c) => originPath(doc, c.part.node, c.m, c.p));
  if (opts.missingResults === "drop-call") {
    calls.forEach((c, i) => changes.push({ op: "drop-call", path: paths[i]!, ids: [c.part.id ?? ""] }));
    // Remove from the back so earlier positions do not shift.
    for (const c of [...calls].reverse()) removePart(doc, c.m, c.p);
    return;
  }
  const s = opts.syntheticResult;
  const callMsgs = calls.map((c) => doc.msgs[c.m]!);
  calls.forEach((c, i) => {
    const id = c.part.id ?? "";
    const text = typeof s === "function" ? String(s({ id, name: c.part.name ?? "" })) : (s ?? DEFAULT_SYNTHETIC_RESULT);
    changes.push({ op: "insert-synthetic-result", path: paths[i]!, ids: [id] });
    // Positions are found by message object, so this is safe even if earlier insertions shifted indexes.
    insertResult(doc, callMsgs[i]!, doc.adapter.makeResult(c.part, text));
  });
}

/**
 * Removes empty messages and messages left with only reasoning. In Anthropic and Gemini, if both sides of the removed spot have the same role,
 * they are merged into one (merge-same-role) to keep the original alternation of user/assistant.
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

/** Repairs the document in place and accumulates changes into changes (trimToBudget also uses this function). */
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
 * Returns a copy with broken call/result pairs fixed. Does not modify the input.
 * The returned messages have the same shape as the input (an array for an array, a body object with the same keys for a body object).
 */
export function repair<T>(input: T, opts: RepairOptions = {}): RepairResult<T> {
  checkOptions(opts);
  const doc = load(input, opts.format, true);
  const changes: Change[] = [];
  repairDoc(doc, opts, changes);
  return { messages: save(doc) as T, format: doc.adapter.format, changes };
}
