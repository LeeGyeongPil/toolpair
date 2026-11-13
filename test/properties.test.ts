// 무작위(시드 고정) 대화 기록으로 성질을 확인한다: 손으로 쓴 픽스처가 놓치는 조합에서도
// repair 결과는 언제나 유효하고 멱등이며, trimToBudget 결과도 언제나 유효하다.
// 시드가 고정이라 실패하면 같은 입력으로 다시 재현된다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repair, trimToBudget, validate, type Format, type RepairOptions } from "../src/index.js";

/** 작은 결정적 난수 생성기(mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;
const pick = <T>(r: R, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
const ids = ["c0", "c1", "c2", "c3", "c4"]; // 일부러 적게 둬서 중복·충돌이 자주 나게 한다.
const names = ["get_weather", "search"];

function chat(r: R): unknown[] {
  const out: unknown[] = [];
  if (r() < 0.7) out.push({ role: "system", content: "sys" });
  const n = 1 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.25) out.push({ role: "user", content: pick(r, ["hi", "", [{ type: "text", text: "q" }]]) });
    else if (k < 0.45) out.push({ role: "assistant", content: pick(r, ["ok", null, [{ type: "text", text: "a" }]]) });
    else if (k < 0.7) {
      const calls = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
        id: pick(r, ids),
        type: "function",
        function: { name: pick(r, names), arguments: "{}" },
      }));
      out.push({ role: "assistant", content: r() < 0.5 ? null : "calling", tool_calls: calls });
    } else if (k < 0.95) out.push({ role: "tool", tool_call_id: pick(r, ids), content: "result" });
    else out.push({ role: "assistant", content: null, tool_calls: [] });
  }
  return out;
}

function responses(r: R): unknown[] {
  const out: unknown[] = [];
  if (r() < 0.5) out.push({ role: "developer", content: "sys" });
  const n = 1 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.25) out.push({ role: "user", content: "hi" });
    else if (k < 0.35) out.push({ role: "assistant", content: "ok" });
    else if (k < 0.5) out.push({ type: "reasoning", id: `rs_${i}`, summary: [] });
    else if (k < 0.75) out.push({ type: "function_call", call_id: pick(r, ids), name: pick(r, names), arguments: "{}" });
    else out.push({ type: "function_call_output", call_id: pick(r, ids), output: "result" });
  }
  return out;
}

function anthropic(r: R): unknown[] {
  const out: unknown[] = [];
  const n = 1 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const blocks: unknown[] = [];
    const user = r() < 0.5;
    const count = Math.floor(r() * 4);
    for (let j = 0; j < count; j++) {
      const k = r();
      if (user) {
        blocks.push(k < 0.5 ? { type: "tool_result", tool_use_id: pick(r, ids), content: "r" } : { type: "text", text: "u" });
      } else if (k < 0.4) blocks.push({ type: "tool_use", id: pick(r, ids), name: pick(r, names), input: {} });
      else if (k < 0.7) blocks.push({ type: "thinking", thinking: "t", signature: "s" });
      else blocks.push({ type: "text", text: "a" });
    }
    const content = user && count === 0 && r() < 0.7 ? "plain text" : blocks;
    out.push({ role: user ? "user" : "assistant", content });
  }
  return out;
}

function gemini(r: R): unknown[] {
  const out: unknown[] = [];
  const n = 1 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const user = r() < 0.5;
    const parts: unknown[] = [];
    const count = Math.floor(r() * 4);
    for (let j = 0; j < count; j++) {
      const k = r();
      const withId = r() < 0.3;
      if (user) {
        parts.push(
          k < 0.5
            ? { functionResponse: { ...(withId ? { id: pick(r, ids) } : {}), name: pick(r, names), response: { output: 1 } } }
            : { text: "u" },
        );
      } else if (k < 0.45) parts.push({ functionCall: { ...(withId ? { id: pick(r, ids) } : {}), name: pick(r, names), args: {} } });
      else if (k < 0.65) parts.push({ text: "t", thought: true });
      else parts.push({ text: "m" });
    }
    out.push({ role: user ? "user" : "model", parts });
  }
  return out;
}

const GENERATORS: Record<Format, (r: R) => unknown[]> = {
  "openai-chat": chat,
  "openai-responses": responses,
  anthropic,
  gemini,
};

const POLICIES: RepairOptions[] = [
  {},
  { missingResults: "drop-call" },
  { openCallAtEnd: "cancel" },
  { missingResults: "drop-call", openCallAtEnd: "cancel" },
];

// 기본은 빠르게 돌 만큼만. 더 넓게 훑을 때: TOOLPAIR_FUZZ_CASES=20000 TOOLPAIR_FUZZ_SEED=7 npm test
const CASES = Number(process.env.TOOLPAIR_FUZZ_CASES) || 400;
const SEED = Number(process.env.TOOLPAIR_FUZZ_SEED) || 20261113;

describe("random histories (seeded)", () => {
  for (const format of Object.keys(GENERATORS) as Format[]) {
    it(`${format}: repair is valid + idempotent and trim is valid for ${CASES} random histories`, () => {
      const r = rng(SEED + format.length);
      for (let n = 0; n < CASES; n++) {
        const input = GENERATORS[format](r);
        const snapshot = JSON.stringify(input);
        const where = `${format} case ${n}: ${snapshot}`;
        assert.doesNotThrow(() => validate(input, { format }), where);
        for (const policy of POLICIES) {
          const opts = { ...policy, format };
          const once = repair(input, opts);
          const check = validate(once.messages, { format });
          assert.equal(check.ok, true, `${where}\npolicy ${JSON.stringify(policy)}\n${JSON.stringify(check.issues)}\n${JSON.stringify(once.messages)}`);
          const twice = repair(once.messages, opts);
          assert.deepEqual(twice.changes, [], `${where}\npolicy ${JSON.stringify(policy)} not idempotent`);
          assert.deepEqual(twice.messages, once.messages, where);
        }
        assert.equal(JSON.stringify(input), snapshot, `${where}: input mutated`);
        for (const budget of [0, 10, 40, 120, 100_000]) {
          const cut = trimToBudget(input, { budget, format });
          assert.equal(validate(cut.messages, { format }).ok, true, `${where} budget ${budget}`);
          if (!cut.overBudget) assert.ok(cut.tokens <= budget, `${where} budget ${budget}`);
        }
      }
    });
  }
});

describe("results stored before their call", () => {
  it("OpenAI Chat: a tool message saved before its assistant call is moved, not dropped", () => {
    const input = [
      { role: "user", content: "weather?" },
      { role: "tool", tool_call_id: "c1", content: "12C" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "w", arguments: "{}" } }] },
    ];
    assert.deepEqual(validate(input).issues, [{ rule: "result-not-adjacent", severity: "error", path: "$[1]", ids: ["c1"] }]);
    const out = repair(input);
    assert.deepEqual(out.changes, [{ op: "move-result", path: "$[1]", ids: ["c1"] }]);
    assert.deepEqual(
      out.messages.map((m: any) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal((out.messages[2] as any).content, "12C");
  });

  it("Responses: output before its function_call is an error even though late outputs are warnings", () => {
    const input = [
      { role: "user", content: "weather?" },
      { type: "function_call_output", call_id: "c1", output: "12C" },
      { type: "function_call", call_id: "c1", name: "w", arguments: "{}" },
    ];
    const v = validate(input);
    assert.equal(v.ok, false);
    assert.equal(v.issues[0]?.severity, "error");
    const out = repair(input);
    assert.deepEqual(
      out.messages.map((m: any) => m.type ?? m.role),
      ["user", "function_call", "function_call_output"],
    );
  });
});

describe("scale", () => {
  it("repairs and trims a 6,000-message history with 1,000 cancelled calls quickly", () => {
    const history: unknown[] = [{ role: "system", content: "s" }];
    for (let i = 0; i < 1000; i++) {
      history.push({ role: "user", content: `q${i}` });
      history.push({ role: "assistant", content: null, tool_calls: [{ id: `x${i}`, type: "function", function: { name: "w", arguments: "{}" } }] });
      if (i % 2 === 0) history.push({ role: "tool", tool_call_id: `x${i}`, content: "r" });
      else history.push({ role: "tool", tool_call_id: `orphan${i}`, content: "r" });
      history.push({ role: "assistant", content: "a" });
      history.push({ role: "assistant", content: null, tool_calls: [] });
    }
    const started = Date.now();
    const out = repair(history);
    assert.equal(validate(out.messages).ok, true);
    const cut = trimToBudget(history, { budget: 2000 });
    assert.equal(validate(cut.messages).ok, true);
    const ms = Date.now() - started;
    // 넉넉한 상한(느린 CI 기준). 이차 시간 회귀를 잡기 위한 것.
    assert.ok(ms < 20_000, `took ${ms} ms`);
  });
});
