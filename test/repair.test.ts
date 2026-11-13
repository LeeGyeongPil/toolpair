// AC-2: 수리 성질 — 수리 뒤 유효, 두 번 수리해도 변화 없음(멱등), 입력 불변, 변경 목록이 expect.json 과 같다.
// AC-3: 정책별 수리 — 합성 결과, drop-call, Anthropic 재배치, 끝의 열린 호출.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SYNTHETIC_RESULT, repair, validate } from "../src/index.js";
import { loadFixtures } from "./helpers.js";

const fixtures = loadFixtures();
const byRel = (rel: string) => {
  const f = fixtures.find((x) => x.rel === rel);
  if (!f) throw new Error(`missing fixture ${rel}`);
  return structuredClone(f.input) as any;
};

describe("repair properties on every fixture", () => {
  for (const f of fixtures) {
    it(`${f.rel}: valid after repair, idempotent, input untouched, changes equal expect.json`, () => {
      const before = JSON.stringify(f.input);
      const first = repair(f.input);
      // 입력 객체를 바꾸지 않는다.
      assert.equal(JSON.stringify(f.input), before);
      assert.equal(first.format, f.format);
      assert.deepEqual(first.changes, f.expect.changes);
      // 수리 결과는 언제나 오류 0건.
      const check = validate(first.messages);
      assert.equal(check.ok, true, JSON.stringify(check.issues));
      // 멱등: 한 번 더 수리하면 변경 0건, 결과도 같다.
      const second = repair(first.messages);
      assert.deepEqual(second.changes, []);
      assert.deepEqual(second.messages, first.messages);
    });
  }

  it("is deterministic: same input gives byte-identical output", () => {
    for (const f of fixtures) {
      assert.equal(JSON.stringify(repair(f.input)), JSON.stringify(repair(f.input)), f.rel);
    }
  });

  it("returns a deep copy even when nothing changes", () => {
    const input = byRel("fixtures/openai-chat/valid-parallel.json");
    const out = repair(input);
    assert.deepEqual(out.messages, input);
    assert.notEqual(out.messages, input);
    assert.notEqual(out.messages[2], input[2]);
  });
});

describe("policies", () => {
  it("cancelled parallel calls get 2 insert-synthetic-result changes right after the call", () => {
    const out = repair(byRel("fixtures/openai-chat/cancelled-parallel.json"));
    assert.deepEqual(
      out.changes.map((c) => [c.op, c.ids[0]]),
      [
        ["insert-synthetic-result", "call_a"],
        ["insert-synthetic-result", "call_b"],
      ],
    );
    assert.deepEqual(out.messages.slice(3, 5), [
      { role: "tool", tool_call_id: "call_a", content: DEFAULT_SYNTHETIC_RESULT },
      { role: "tool", tool_call_id: "call_b", content: DEFAULT_SYNTHETIC_RESULT },
    ]);
    assert.equal(out.messages[5].role, "user");
  });

  it("missingResults: drop-call removes the calls (and the emptied assistant message)", () => {
    const out = repair(byRel("fixtures/openai-chat/cancelled-parallel.json"), { missingResults: "drop-call" });
    assert.deepEqual(
      out.changes.map((c) => [c.op, c.path]),
      [
        ["drop-call", "$[2].tool_calls[0]"],
        ["drop-call", "$[2].tool_calls[1]"],
        ["drop-empty-message", "$[2]"],
      ],
    );
    assert.deepEqual(
      out.messages.map((m: any) => m.role),
      ["system", "user", "user"],
    );
    assert.equal(validate(out.messages).ok, true);
  });

  it("missingResults: drop-call on Responses also drops the reasoning item left behind", () => {
    const out = repair(byRel("fixtures/openai-responses/missing-output.json"), { missingResults: "drop-call" });
    assert.deepEqual(
      out.changes.map((c) => [c.op, c.path]),
      [
        ["drop-call", "$[2]"],
        ["drop-empty-message", "$[1]"],
      ],
    );
    assert.equal(validate(out.messages).ok, true);
  });

  it("syntheticResult accepts a string or a function", () => {
    const a = repair(byRel("fixtures/openai-chat/cancelled-parallel.json"), { syntheticResult: "user cancelled" });
    assert.equal(a.messages[3].content, "user cancelled");
    const b = repair(byRel("fixtures/openai-chat/cancelled-parallel.json"), {
      syntheticResult: (call) => `${call.name} ${call.id} was cancelled`,
    });
    assert.equal(b.messages[4].content, "get_weather call_b was cancelled");
  });

  it("Anthropic: tool_result moves to the front of the immediately following user message", () => {
    const out = repair(byRel("fixtures/anthropic/result-not-adjacent.json"));
    assert.deepEqual(
      out.changes.map((c) => c.op),
      ["move-result", "drop-empty-message"],
    );
    assert.equal(out.messages.length, 3);
    assert.deepEqual(out.messages[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: '{"city":"Seoul","temp_c":12,"sky":"clear"}' },
        { type: "text", text: "Hello? Are you still there?" },
      ],
    });
  });

  it("Anthropic: text before tool_result is reordered so the result comes first", () => {
    const out = repair(byRel("fixtures/anthropic/text-before-result.json"));
    assert.deepEqual(
      out.messages[2].content.map((b: any) => b.type),
      ["tool_result", "text"],
    );
  });

  it("Anthropic: synthetic results are marked is_error and placed first", () => {
    const out = repair([
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "w", input: {} }] },
      { role: "user", content: "never mind" },
    ]);
    assert.deepEqual(out.messages[2].content, [
      { type: "tool_result", tool_use_id: "t1", content: DEFAULT_SYNTHETIC_RESULT, is_error: true },
      { type: "text", text: "never mind" },
    ]);
  });

  it("Anthropic: dropping an emptied message merges same-role neighbours", () => {
    const out = repair(
      [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "w", input: {} }] },
        { role: "user", content: "never mind" },
      ],
      { missingResults: "drop-call" },
    );
    assert.deepEqual(
      out.changes.map((c) => [c.op, c.path]),
      [
        ["drop-call", "$[1].content[0]"],
        ["drop-empty-message", "$[1]"],
        ["merge-same-role", "$[0]"],
      ],
    );
    assert.deepEqual(out.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "weather?" },
          { type: "text", text: "never mind" },
        ],
      },
    ]);
  });

  it("Gemini: synthetic functionResponse uses the error key and keeps explicit ids", () => {
    const out = repair(byRel("fixtures/gemini/count-mismatch.json"));
    assert.deepEqual(out.messages[2].parts[1], {
      functionResponse: { name: "get_weather", response: { error: DEFAULT_SYNTHETIC_RESULT } },
    });
    const withId = repair([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "fc-1", name: "w", args: {} } }] },
      { role: "user", parts: [{ text: "stop" }] },
    ]);
    assert.deepEqual(withId.messages[2].parts[0], {
      functionResponse: { id: "fc-1", name: "w", response: { error: DEFAULT_SYNTHETIC_RESULT } },
    });
  });

  it("trailing open call is kept with an open-call-at-end warning by default", () => {
    const input = byRel("fixtures/openai-chat/trailing-open-call.json");
    const out = repair(input);
    assert.deepEqual(out.changes, []);
    assert.deepEqual(out.messages, input);
    const v = validate(out.messages);
    assert.deepEqual(
      v.issues.map((i) => [i.rule, i.severity]),
      [["open-call-at-end", "warning"]],
    );
  });

  it("openCallAtEnd: cancel closes the trailing call with a synthetic result", () => {
    const out = repair(byRel("fixtures/openai-chat/trailing-open-call.json"), { openCallAtEnd: "cancel" });
    assert.deepEqual(out.changes, [{ op: "insert-synthetic-result", path: "$[2].tool_calls[0]", ids: ["call_a"] }]);
    assert.deepEqual(out.messages[3], { role: "tool", tool_call_id: "call_a", content: DEFAULT_SYNTHETIC_RESULT });
    assert.deepEqual(validate(out.messages).issues, []);
  });

  it("openCallAtEnd: cancel on Anthropic appends a user message with the synthetic tool_result", () => {
    const out = repair(
      [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "w", input: {} }] },
      ],
      { openCallAtEnd: "cancel" },
    );
    assert.equal(out.messages.length, 3);
    assert.equal(out.messages[2].role, "user");
    assert.deepEqual(validate(out.messages).issues, []);
  });

  it("rejects unknown option values", () => {
    assert.throws(() => repair([], { missingResults: "nope" as never }), /missingResults/);
    assert.throws(() => repair([], { openCallAtEnd: "nope" as never }), /openCallAtEnd/);
  });
});
