// Pair-preserving trim: first fix pairs with repair, then group "a call + its results" into indivisible units
// and fill the budget from the back. The remaining window is adjusted to start with a real user turn.
// The result always passes validate. If the budget is too small it reports overBudget: true.
import { InvalidInputError } from "./errors.js";
import { load, save } from "./ir.js";
import { repairDoc } from "./repair.js";
import { defaultCountTokens } from "./tokens.js";
import type { Change, Msg, TrimOptions, TrimResult } from "./types.js";

/** Trim unit: a list of message positions and their token total. */
interface Unit {
  idx: number[];
  tokens: number;
  /** A unit made of a single real user turn message (can be used to open the window). */
  userTurn: boolean;
}

export function trimToBudget<T>(input: T, opts: TrimOptions): TrimResult<T> {
  const budget = opts?.budget;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
    throw new InvalidInputError("budget must be a finite number >= 0", "bad-budget");
  }
  const countTokens = opts.countTokens ?? defaultCountTokens;
  const pinSystem = opts.pin?.system ?? true;
  const pinFirstUser = opts.pin?.firstUser ?? true;

  // 1) Fix pairs first. Trimming a broken history would leave broken pieces.
  const doc = load(input, opts.format, true);
  const changes: Change[] = [];
  repairDoc(doc, {}, changes);
  save(doc); // The repaired content must be written to the nodes so tokens are counted exactly.
  const { msgs, adapter } = doc;

  const tokensOf = (msg: Msg): number => {
    const n = Number(countTokens(msg.node));
    if (!Number.isFinite(n) || n < 0) throw new InvalidInputError("countTokens must return a number >= 0", "bad-count-tokens");
    return n;
  };
  const cost = msgs.map(tokensOf);

  // 2) Pinned messages: the leading system/developer messages and the first real user message.
  const pinned = new Set<number>();
  if (pinSystem) for (let i = 0; i < msgs.length && msgs[i]!.side === "system"; i++) pinned.add(i);
  const firstUser = msgs.findIndex((m) => adapter.isUserTurn(m));
  if (pinFirstUser && firstUser >= 0) pinned.add(firstUser);

  // 3) Group the rest into atomic units: one unit while a call is open (or while it must stick to the next item, like reasoning).
  const units: Unit[] = [];
  let current: Unit | null = null;
  const open = new Set<string>();
  let glue = false;
  msgs.forEach((msg, i) => {
    if (pinned.has(i)) {
      current = null;
      return;
    }
    if (current && (open.size > 0 || glue)) {
      current.idx.push(i);
      current.tokens += cost[i]!;
    } else {
      current = { idx: [i], tokens: cost[i]!, userTurn: adapter.isUserTurn(msg) };
      units.push(current);
    }
    for (const part of msg.parts) {
      if (part.kind === "call") open.add(part.id ?? "");
      if (part.kind === "result") open.delete(part.id ?? "");
    }
    glue = adapter.gluesToNext(msg);
  });

  // 4) Fill from the back. The last unit (the most recent message) is kept even if it exceeds the budget.
  let used = [...pinned].reduce((sum, i) => sum + cost[i]!, 0);
  let start = units.length;
  for (let k = units.length - 1; k >= 0; k--) {
    const isLast = k === units.length - 1;
    if (!isLast && used + units[k]!.tokens > budget) break;
    used += units[k]!.tokens;
    start = k;
  }

  // 5) Make the window start with a real user turn. If the first unit of the window is model output, either keep the user message that opened that turn
  //    (if the budget allows) or drop the first unit of the window.
  let opener = -1;
  while (start > 0 && start < units.length && !units[start]!.userTurn) {
    const firstMsg = units[start]!.idx[0]!;
    let o = start - 1;
    while (o >= 0 && !units[o]!.userTurn) o--;
    // If the pinned first user message is the very one that opened this turn, leave it as is.
    const pinnedOpens = pinned.has(firstUser) && firstUser < firstMsg && (o < 0 || units[o]!.idx[0]! < firstUser);
    if (pinnedOpens) break;
    const isLast = start === units.length - 1;
    if (o >= 0 && (used + units[o]!.tokens <= budget || isLast)) {
      opener = o;
      used += units[o]!.tokens;
      break;
    }
    if (isLast) break; // If there is no opening user turn at all, keep at least the last unit.
    used -= units[start]!.tokens;
    start++;
  }

  // 6) Collect the messages to keep in their original order.
  const keep = new Set<number>(pinned);
  for (const u of units.slice(start)) for (const i of u.idx) keep.add(i);
  if (opener >= 0) for (const i of units[opener]!.idx) keep.add(i);
  doc.msgs = msgs.filter((_, i) => keep.has(i));
  const tokens = msgs.reduce((sum, _m, i) => (keep.has(i) ? sum + cost[i]! : sum), 0);
  const keptUnits = units.length - start + (opener >= 0 ? 1 : 0);

  return {
    messages: save(doc) as T,
    format: adapter.format,
    tokens,
    droppedUnits: units.length - keptUnits,
    overBudget: tokens > budget,
    changes,
  };
}
