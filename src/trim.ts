// 짝 보존 자르기: 먼저 repair 로 짝을 맞춘 뒤, "호출 + 그 결과들"을 쪼갤 수 없는 단위로 묶어
// 뒤에서부터 예산만큼 채운다. 남는 창은 진짜 user 턴으로 시작하게 맞춘다.
// 결과는 언제나 validate 를 통과한다. 예산이 너무 작으면 overBudget: true 로 알린다.
import { InvalidInputError } from "./errors.js";
import { load, save } from "./ir.js";
import { repairDoc } from "./repair.js";
import { defaultCountTokens } from "./tokens.js";
import type { Change, Msg, TrimOptions, TrimResult } from "./types.js";

/** 자르기 단위: 메시지 위치 목록과 토큰 합. */
interface Unit {
  idx: number[];
  tokens: number;
  /** 진짜 user 턴 메시지 하나로 된 단위(창을 여는 데 쓸 수 있다). */
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

  // 1) 짝부터 맞춘다. 깨진 기록을 자르면 깨진 조각이 남기 때문이다.
  const doc = load(input, opts.format, true);
  const changes: Change[] = [];
  repairDoc(doc, {}, changes);
  save(doc); // 수리한 내용을 노드에 써 두어야 토큰을 정확히 센다.
  const { msgs, adapter } = doc;

  const tokensOf = (msg: Msg): number => {
    const n = Number(countTokens(msg.node));
    if (!Number.isFinite(n) || n < 0) throw new InvalidInputError("countTokens must return a number >= 0", "bad-count-tokens");
    return n;
  };
  const cost = msgs.map(tokensOf);

  // 2) 고정 메시지: 맨 앞의 system/developer 메시지들, 첫 진짜 user 메시지.
  const pinned = new Set<number>();
  if (pinSystem) for (let i = 0; i < msgs.length && msgs[i]!.side === "system"; i++) pinned.add(i);
  const firstUser = msgs.findIndex((m) => adapter.isUserTurn(m));
  if (pinFirstUser && firstUser >= 0) pinned.add(firstUser);

  // 3) 나머지를 원자 단위로 묶는다: 열린 호출이 있는 동안(또는 reasoning 처럼 다음과 붙어야 하면) 같은 단위.
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

  // 4) 뒤에서부터 채운다. 마지막 단위(가장 최근 메시지)는 예산을 넘어도 남긴다.
  let used = [...pinned].reduce((sum, i) => sum + cost[i]!, 0);
  let start = units.length;
  for (let k = units.length - 1; k >= 0; k--) {
    const isLast = k === units.length - 1;
    if (!isLast && used + units[k]!.tokens > budget) break;
    used += units[k]!.tokens;
    start = k;
  }

  // 5) 창이 진짜 user 턴으로 시작하게 맞춘다. 창 첫 단위가 모델 출력이면, 그 턴을 연 user 메시지를
  //    함께 남기거나(예산이 되면) 창 첫 단위를 버린다.
  let opener = -1;
  while (start > 0 && start < units.length && !units[start]!.userTurn) {
    const firstMsg = units[start]!.idx[0]!;
    let o = start - 1;
    while (o >= 0 && !units[o]!.userTurn) o--;
    // 고정해 둔 첫 user 메시지가 바로 이 턴을 연 메시지라면 그대로 둔다.
    const pinnedOpens = pinned.has(firstUser) && firstUser < firstMsg && (o < 0 || units[o]!.idx[0]! < firstUser);
    if (pinnedOpens) break;
    const isLast = start === units.length - 1;
    if (o >= 0 && (used + units[o]!.tokens <= budget || isLast)) {
      opener = o;
      used += units[o]!.tokens;
      break;
    }
    if (isLast) break; // 여는 user 턴이 아예 없으면 마지막 단위만이라도 남긴다.
    used -= units[start]!.tokens;
    start++;
  }

  // 6) 남길 메시지를 원래 순서대로 모은다.
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
