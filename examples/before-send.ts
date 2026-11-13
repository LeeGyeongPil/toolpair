// "보내기 직전 한 줄" 사용 예. 실제 API 는 부르지 않고, 보낼 페이로드와 변경 목록만 출력한다.
// 실행: node --import tsx examples/before-send.ts
import { readFileSync } from "node:fs";
import { repair, trimToBudget } from "../src/index.js"; // 설치해서 쓸 때는 from "toolpair"

// 사용자가 병렬 도구 호출 도중 취소한 대화(결과 없는 tool_calls 2개).
const history = JSON.parse(readFileSync(new URL("../fixtures/openai-chat/cancelled-parallel.json", import.meta.url), "utf8"));

const { messages: fixed, changes } = repair(history); // 1) 짝 수리(합성 결과 삽입)
const { messages } = trimToBudget(fixed, { budget: 8000 }); // 2) 짝을 쪼개지 않고 예산에 맞춤
// await openai.chat.completions.create({ model, messages, tools });  // 3) 그대로 보낸다

console.log(JSON.stringify({ changes, messages }, null, 2));
