// 규칙 7개 검사. 형식별 차이는 어댑터에 있고, 여기서는 IR 위에서 한 번만 구현한다.
import { analyze, load, pathAt, type Doc } from "./ir.js";
import type { Issue, RuleId, ValidateOptions, ValidateResult } from "./types.js";

/** 같은 위치의 이슈를 정렬할 때 쓰는 규칙 순서. */
export const RULES: RuleId[] = [
  "duplicate-call-id",
  "orphan-result",
  "result-not-adjacent",
  "result-not-first",
  "missing-result",
  "open-call-at-end",
  "empty-message",
];

interface Located extends Issue {
  m: number;
  p: number;
}

/** 문서에서 이슈 목록을 만든다(입력은 바꾸지 않는다). */
export function issuesOf(doc: Doc): Issue[] {
  const a = analyze(doc);
  const out: Located[] = [];
  const add = (rule: RuleId, severity: Issue["severity"], m: number, p: number | undefined, ids: string[]) =>
    out.push({ rule, severity, path: pathAt(doc, m, p), ids, m, p: p ?? -1 });

  for (const call of a.calls) {
    if (call.duplicate) add("duplicate-call-id", "error", call.m, call.p, [call.part.id ?? ""]);
  }
  for (const r of a.results) {
    const id = r.part.id ?? "";
    if (!r.call) {
      if (!r.unverifiable) add("orphan-result", "error", r.m, r.p, [id]);
    } else if (!r.adjacent) {
      // 호출보다 앞에 있는 결과는 어느 형식에서도 오류다. 뒤에 있지만 턴을 넘긴 결과의 심각도는 형식마다 다르다.
      const severity = r.m <= r.call.m ? "error" : doc.adapter.adjacencySeverity;
      add("result-not-adjacent", severity, r.m, r.p, [id]);
    } else if (doc.adapter.resultsFirst && !r.first) {
      add("result-not-first", "error", r.m, r.p, [id]);
    }
  }
  // 짝 없는 호출은 호출 메시지 단위로 묶어 보고한다(병렬 호출 2개 → 이슈 1개, ids 2개).
  const groups = new Map<string, { m: number; p: number; ids: string[]; closed: boolean }>();
  for (const call of a.calls) {
    if (call.result) continue;
    const key = `${call.m}:${call.closed}`;
    const g = groups.get(key) ?? { m: call.m, p: call.p, ids: [], closed: call.closed };
    g.ids.push(call.part.id ?? "");
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.closed) add("missing-result", "error", g.m, undefined, g.ids);
    else add("open-call-at-end", "warning", g.m, undefined, g.ids);
  }
  for (const m of a.empty) add("empty-message", "error", m, undefined, []);

  // 위치 → 조각 → 규칙 순으로 정렬해 같은 입력엔 언제나 같은 순서가 나오게 한다.
  out.sort((x, y) => x.m - y.m || x.p - y.p || RULES.indexOf(x.rule) - RULES.indexOf(y.rule));
  return out.map(({ rule, severity, path, ids }) => ({ rule, severity, path, ids }));
}

/**
 * 대화 기록을 제공자 형식 규칙으로 검사한다. ok 는 error 가 0건일 때 true.
 * 입력은 배열 그대로 또는 요청 본문 객체({messages}·{input}·{contents}).
 */
export function validate(input: unknown, opts: ValidateOptions = {}): ValidateResult {
  const doc = load(input, opts.format, false);
  const issues = issuesOf(doc);
  return { format: doc.adapter.format, ok: issues.every((i) => i.severity !== "error"), issues };
}
