// AC-1: 형식 4종 판별과 검증 — 모든 픽스처에서 detectFormat 이 폴더 이름과 같고,
// validate 의 이슈(규칙·경로·id)가 *.expect.json 과 정확히 같다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFormat, validate } from "../src/index.js";
import { loadFixtures } from "./helpers.js";

const fixtures = loadFixtures();

describe("detectFormat + validate on every fixture", () => {
  it("has fixtures for all four formats", () => {
    const formats = new Set(fixtures.map((f) => f.format));
    assert.deepEqual([...formats].sort(), ["anthropic", "gemini", "openai-chat", "openai-responses"]);
  });

  for (const f of fixtures) {
    it(`${f.rel}: detects ${f.format}`, () => {
      assert.equal(detectFormat(f.input), f.format);
      assert.equal(f.expect.format, f.format);
    });

    it(`${f.rel}: issues equal expect.json`, () => {
      const result = validate(f.input);
      assert.equal(result.format, f.format);
      assert.deepEqual(result.issues, f.expect.issues);
      assert.equal(result.ok, f.expect.issues.every((i) => i.severity !== "error"));
    });
  }

  it("valid fixtures have zero issues", () => {
    const valid = fixtures.filter((f) => f.name.startsWith("valid"));
    assert.equal(valid.length, 4);
    for (const f of valid) assert.deepEqual(validate(f.input).issues, [], f.rel);
  });
});

describe("cases other checkers miss", () => {
  const byName = (rel: string) => fixtures.find((f) => f.rel === rel)!;

  it("Responses function_call without output reports missing-result", () => {
    const r = validate(byName("fixtures/openai-responses/missing-output.json").input);
    assert.equal(r.ok, false);
    assert.deepEqual(r.issues.map((i) => i.rule), ["missing-result"]);
  });

  it("Gemini functionCall without functionResponse reports missing-result", () => {
    const r = validate(byName("fixtures/gemini/missing-response.json").input);
    assert.deepEqual(r.issues.map((i) => i.rule), ["missing-result"]);
  });

  it("Gemini call/response count mismatch reports missing-result for the unanswered call", () => {
    const r = validate(byName("fixtures/gemini/count-mismatch.json").input);
    assert.deepEqual(r.issues, [{ rule: "missing-result", severity: "error", path: "$[1]", ids: ["get_weather@1.1"] }]);
  });

  it("open call at the end is only a warning (ok stays true)", () => {
    const r = validate(byName("fixtures/openai-chat/trailing-open-call.json").input);
    assert.equal(r.ok, true);
    assert.equal(r.issues[0]?.severity, "warning");
  });

  it("explicit format option skips detection", () => {
    const r = validate([{ role: "user", content: "hi" }], { format: "anthropic" });
    assert.equal(r.format, "anthropic");
    assert.equal(r.ok, true);
  });

  it("Responses result after a user message is a warning, not an error", () => {
    const r = validate([
      { role: "user", content: "weather?" },
      { type: "function_call", call_id: "c1", name: "w", arguments: "{}" },
      { role: "user", content: "hello?" },
      { type: "function_call_output", call_id: "c1", output: "12C" },
    ]);
    assert.deepEqual(r.issues, [{ rule: "result-not-adjacent", severity: "warning", path: "$[3]", ids: ["c1"] }]);
    assert.equal(r.ok, true);
  });

  it("Responses outputs answering server-side calls (previous_response_id) are not orphans", () => {
    const body = { previous_response_id: "resp_1", input: [{ type: "function_call_output", call_id: "c1", output: "12C" }] };
    assert.deepEqual(validate(body).issues, []);
    // 본문 없이 배열만 주면 로컬에서는 고아로 보인다.
    assert.equal(validate(body.input).issues[0]?.rule, "orphan-result");
  });

  it("Responses reasoning item left without its following item is empty-message", () => {
    const r = validate([
      { role: "user", content: "hi" },
      { type: "reasoning", id: "rs_1", summary: [] },
      { role: "user", content: "again" },
    ]);
    assert.deepEqual(r.issues, [{ rule: "empty-message", severity: "error", path: "$[1]", ids: [] }]);
  });

  it("Gemini functionCall ids are used when present", () => {
    const r = validate([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "fc-1", name: "w", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "fc-2", name: "w", response: {} } }] },
    ]);
    assert.deepEqual(
      r.issues.map((i) => [i.rule, i.path, i.ids]),
      [
        ["missing-result", "$[1]", ["fc-1"]],
        ["orphan-result", "$[2].parts[0]", ["fc-2"]],
      ],
    );
  });
});
