// 오프라인 데모(연습용 목 모드): API 키·네트워크 없이 fixtures/ 의 대화 기록에
// 실제 validate / repair / trimToBudget 을 돌려 README 의 교훈을 그대로 재현한다.
//  [1] 단순 slice 는 호출을 잘라 고아 결과를 만들고(INVALID), trimToBudget 은 같은 예산에서 유효하다(VALID).
//  [2] 형식 4종의 깨진 기록을 보내기 직전에 수리하면 유효해진다.
// 가짜인 부분은 "제공자가 이 기록을 받으면 내는 오류 문구"뿐이며, fixtures/provider-errors.json 에 출처와 함께 기록돼 있다.
// 실행: npm run demo            (화면 언어: --lang en|ko, TOOLPAIR_LANG, LANG)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLang, translator } from "../src/cli/i18n.js";
import type { MessageKey } from "../src/cli/messages.js";
import { defaultCountTokens, repair, trimToBudget, validate, type Format, type Issue } from "../src/index.js";

// 출력을 받는 쪽이 먼저 닫혀도(예: `| head`) 스택 트레이스 없이 조용히 끝낸다.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = translator(resolveLang(process.argv.slice(2), process.env));
const load = (rel: string): any => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const errors = load("fixtures/provider-errors.json");
const verdict = (ok: boolean) => (ok ? "VALID" : "INVALID");
const say = (indent: number, text: string) => console.log(" ".repeat(indent) + text);

function printIssues(indent: number, issues: Issue[]) {
  for (const i of issues) {
    say(indent, `${t(`sev.${i.severity}` as MessageKey)}  ${i.rule}  ${i.path}  ${i.ids.join(", ") || "-"}  ${t(`rule.${i.rule}` as MessageKey)}`);
  }
}

/** 기록된 제공자 오류(또는 문서 규칙)를 "practice mock" 표시와 함께 보여 준다. */
function printProviderError(indent: number, format: Format, rule: string) {
  const entry = errors[format]?.[rule];
  if (!entry) return;
  say(indent, t(entry.kind === "error" ? "demo.recordedError" : "demo.recordedRule"));
  // 상태 코드는 출처에 적혀 있을 때만 기록해 두었다.
  say(indent + 2, entry.status ? `${entry.status} ${entry.text}` : entry.text);
  say(indent + 2, t("demo.source", { url: entry.source, date: errors.checked }));
}

console.log(t("demo.title"));
console.log(t("demo.mockNote"));

// ---------------------------------------------------------------------------
// [1] 슬라이딩 윈도우: 앱이 흔히 쓰는 messages.slice(-N) 과 trimToBudget 비교
// ---------------------------------------------------------------------------
const HISTORY = "fixtures/openai-chat/valid-parallel.json";
const BUDGET = 200;
const history: any[] = load(HISTORY);
const allTokens = history.reduce((sum, m) => sum + defaultCountTokens(m), 0);

console.log();
console.log(t("demo.s1"));
say(2, t("demo.s1.history", { file: HISTORY, n: history.length, tokens: allTokens, budget: BUDGET }));

// 짝을 아는 자르기.
const cut = trimToBudget(history, { budget: BUDGET });
const cutList = cut.messages as any[];
// 같은 개수를 남기는 단순 slice: system 하나 + 마지막 (n-1)개.
const keep = cutList.length - 1;
const naive = [history[0], ...history.slice(-keep)];
const naiveCheck = validate(naive);

say(2, t("demo.s1.naive", { verdict: verdict(naiveCheck.ok), n: keep }));
printIssues(4, naiveCheck.issues);
if (!naiveCheck.ok) printProviderError(4, "openai-chat", naiveCheck.issues[0]!.rule);
const cutCheck = validate(cut.messages);
say(
  2,
  t("demo.s1.trim", {
    verdict: verdict(cutCheck.ok),
    n: cutList.length,
    tokens: cut.tokens,
    budget: BUDGET,
    dropped: cut.droppedUnits,
  }),
);

// ---------------------------------------------------------------------------
// [2] 형식 4종: 깨진 기록 → 기록된 제공자 오류 → repair → 다시 검사
// ---------------------------------------------------------------------------
const BROKEN: [Format, string][] = [
  ["openai-chat", "fixtures/openai-chat/cancelled-parallel.json"],
  ["openai-responses", "fixtures/openai-responses/missing-output.json"],
  ["anthropic", "fixtures/anthropic/result-not-adjacent.json"],
  ["gemini", "fixtures/gemini/count-mismatch.json"],
];

console.log();
console.log(t("demo.s2"));
for (const [format, file] of BROKEN) {
  const input = load(file);
  const before = validate(input);
  console.log();
  say(2, `${format}  ${file}`);
  say(4, t("demo.before", { verdict: verdict(before.ok) }));
  printIssues(6, before.issues);
  printProviderError(4, format, before.issues[0]!.rule);

  const fixed = repair(input);
  say(4, t("demo.changes"));
  for (const c of fixed.changes) say(6, `${c.op}  ${c.path}  ${c.ids.join(", ") || "-"}`);
  say(4, t("demo.after", { verdict: verdict(validate(fixed.messages).ok) }));
}

console.log();
console.log(t("demo.end"));
