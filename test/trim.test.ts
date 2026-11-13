// AC-4: 짝 보존 자르기 — 모든 픽스처 × 예산 0..(전체 토큰+10) 에서 결과가 유효하고,
// overBudget 이 아니면 tokens <= budget, 고정한 system·첫 user 가 남고, 창이 진짜 user 턴으로 시작한다.
// 같은 개수의 단순 slice 는 적어도 한 예산에서 깨진다(대조).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultCountTokens, repair, trimToBudget, validate, type Format } from "../src/index.js";
import { loadFixtures } from "./helpers.js";

const fixtures = loadFixtures();

/** 배열 또는 본문 객체에서 대화 배열을 꺼낸다. */
function listOf(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  for (const key of ["messages", "input", "contents"]) if (Array.isArray(body[key])) return body[key] as any[];
  throw new Error("no list");
}

/** 테스트 쪽에서 따로 구현한 판정(라이브러리 코드와 독립): 앞쪽 system/developer 메시지인가. */
const isSystem = (m: any) => m?.role === "system" || m?.role === "developer";

/** 진짜 user 턴인가(도구 결과만 나르는 메시지가 아님). */
function isUserTurn(format: Format, m: any): boolean {
  if (m?.role !== "user") return false;
  if (format === "anthropic") return !(Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result"));
  if (format === "gemini") return !(Array.isArray(m.parts) && m.parts.some((p: any) => p?.functionResponse));
  return true;
}

const total = (list: any[]) => list.reduce((s, m) => s + defaultCountTokens(m), 0);

describe("trimToBudget keeps pairs at every budget", () => {
  for (const f of fixtures) {
    it(`${f.rel}: valid, within budget, pins kept, window opens on a user turn`, () => {
      const repaired = listOf(repair(f.input).messages);
      const all = total(repaired);
      const leadingSystem = [];
      for (const m of repaired) {
        if (!isSystem(m)) break;
        leadingSystem.push(m);
      }
      const firstUser = repaired.find((m) => isUserTurn(f.format, m));

      for (let budget = 0; budget <= all + 10; budget++) {
        const out = trimToBudget(f.input, { budget });
        const list = listOf(out.messages);
        const where = `${f.rel} budget=${budget}`;

        const check = validate(out.messages);
        assert.equal(check.ok, true, `${where}: ${JSON.stringify(check.issues)}`);
        assert.equal(out.tokens, total(list), `${where}: tokens recount`);
        if (!out.overBudget) assert.ok(out.tokens <= budget, `${where}: ${out.tokens} > budget`);
        assert.equal(out.overBudget, out.tokens > budget, where);

        // 고정 메시지가 남아 있다.
        for (const s of leadingSystem) assert.ok(list.some((m) => JSON.stringify(m) === JSON.stringify(s)), `${where}: system kept`);
        if (firstUser) assert.ok(list.some((m) => JSON.stringify(m) === JSON.stringify(firstUser)), `${where}: first user kept`);

        // 무언가 버렸다면, system 다음 첫 메시지는 진짜 user 턴이다.
        if (out.droppedUnits > 0) {
          const head = list.find((m) => !isSystem(m));
          assert.ok(isUserTurn(f.format, head), `${where}: window starts with ${JSON.stringify(head).slice(0, 80)}`);
        }
        // 가장 최근 메시지는 언제나 남는다.
        assert.deepEqual(list.at(-1), repaired.at(-1), `${where}: last message kept`);
        // 예산이 충분하면 아무것도 버리지 않는다.
        if (budget >= all) {
          assert.equal(out.droppedUnits, 0, where);
          assert.deepEqual(list, repaired, where);
        }
      }
    });
  }

  it("the same sweep holds with no pinned messages (window still opens on a user turn)", () => {
    for (const f of fixtures) {
      const repaired = listOf(repair(f.input).messages);
      for (let budget = 0; budget <= total(repaired) + 10; budget++) {
        const out = trimToBudget(f.input, { budget, pin: { system: false, firstUser: false } });
        const list = listOf(out.messages);
        const where = `${f.rel} budget=${budget} (no pins)`;
        assert.equal(validate(out.messages).ok, true, where);
        if (!out.overBudget) assert.ok(out.tokens <= budget, where);
        if (out.droppedUnits > 0 && repaired.some((m) => isUserTurn(f.format, m))) {
          assert.ok(isUserTurn(f.format, list[0]), `${where}: starts with ${JSON.stringify(list[0]).slice(0, 80)}`);
        }
      }
    }
  });
});

describe("naive slice vs trimToBudget", () => {
  for (const f of fixtures.filter((x) => x.name.startsWith("valid"))) {
    it(`${f.rel}: a naive slice of the same message count breaks for at least one budget`, () => {
      const repaired = listOf(repair(f.input).messages);
      const system = repaired.filter((m, i) => isSystem(m) && repaired.slice(0, i).every(isSystem));
      let brokenAt = -1;
      for (let budget = 0; budget <= total(repaired); budget++) {
        const out = listOf(trimToBudget(f.input, { budget }).messages);
        const keep = out.length - system.length;
        const naive = [...system, ...repaired.slice(repaired.length - keep)];
        if (!validate(naive, { format: f.format }).ok) {
          brokenAt = budget;
          break;
        }
      }
      assert.ok(brokenAt >= 0, "expected the naive slice to orphan a tool result at some budget");
    });
  }
});

describe("trim details", () => {
  it("budget 0 keeps pins and the latest message and reports overBudget", () => {
    const f = fixtures.find((x) => x.rel === "fixtures/openai-chat/valid-parallel.json")!;
    const out = trimToBudget(f.input, { budget: 0 });
    assert.equal(out.overBudget, true);
    assert.deepEqual(
      (out.messages as any[]).map((m) => m.content),
      [
        "You are a concise travel assistant. Use tools for live data.",
        "What's the weather in Seoul and Busan right now?",
        "Book the 18:30 one, please.",
      ],
    );
  });

  it("a custom countTokens is used (1 token per message)", () => {
    const f = fixtures.find((x) => x.rel === "fixtures/openai-chat/valid-parallel.json")!;
    const out = trimToBudget(f.input, { budget: 6, countTokens: () => 1 });
    assert.equal(out.tokens, (out.messages as any[]).length);
    assert.ok(out.tokens <= 6);
    assert.equal(validate(out.messages).ok, true);
  });

  it("repairs before trimming and reports the changes", () => {
    const f = fixtures.find((x) => x.rel === "fixtures/openai-chat/cancelled-parallel.json")!;
    const out = trimToBudget(f.input, { budget: 10_000 });
    assert.equal(out.changes.length, 2);
    assert.equal(validate(out.messages).ok, true);
  });

  it("long single-turn agent loop: keeps the first user message and the newest call units", () => {
    const history: any[] = [
      { role: "system", content: "agent" },
      { role: "user", content: "Research three cities." },
    ];
    for (let i = 0; i < 6; i++) {
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "search", arguments: `{"q":"city ${i}"}` } }],
      });
      history.push({ role: "tool", tool_call_id: `c${i}`, content: `result ${i} `.repeat(10) });
    }
    history.push({ role: "assistant", content: "Done." });
    const out = trimToBudget(history, { budget: 220 });
    const list = out.messages as any[];
    assert.equal(validate(list).ok, true);
    assert.equal(list[0].role, "system");
    assert.equal(list[1].content, "Research three cities.");
    assert.equal(list.at(-1).content, "Done.");
    assert.ok(out.droppedUnits > 0);
    // 남은 tool 메시지마다 바로 앞에 자기 호출이 있다.
    list.forEach((m, i) => {
      if (m.role === "tool") assert.ok(list.slice(0, i).some((x) => x.tool_calls?.some((c: any) => c.id === m.tool_call_id)));
    });
  });

  it("returns the same body shape and leaves the input untouched", () => {
    const f = fixtures.find((x) => x.rel === "fixtures/gemini/valid.json")!;
    const before = JSON.stringify(f.input);
    const out = trimToBudget(f.input, { budget: 60 });
    assert.equal(JSON.stringify(f.input), before);
    const body = out.messages as any;
    assert.ok(Array.isArray(body.contents));
    assert.deepEqual(body.systemInstruction, (f.input as any).systemInstruction);
  });

  it("rejects a bad budget", () => {
    assert.throws(() => trimToBudget([], { budget: -1 }), /budget/);
    assert.throws(() => trimToBudget([], { budget: Number.NaN }), /budget/);
    assert.throws(() => trimToBudget([], {} as never), /budget/);
  });
});
