// AC-5: 견고성 — null·문자열·배열 content, 요청 본문 객체({messages}·{input}·{contents})를 예외 없이 처리하고
// 같은 모양으로 돌려준다. 배열/객체가 아니면 InvalidInputError, 판별 불가 모양이면 UnknownFormatError.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  InvalidInputError,
  ToolpairError,
  UnknownFormatError,
  detectFormat,
  repair,
  trimToBudget,
  validate,
} from "../src/index.js";
import { ROOT } from "./helpers.js";

const all = (input: unknown) => {
  const v = validate(input);
  const r = repair(input);
  const t = trimToBudget(input, { budget: 50 });
  return { v, r, t };
};

describe("content shapes", () => {
  it("OpenAI Chat: null, string and array content", () => {
    const input = [
      { role: "system", content: "s" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:," } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: "" , refusal: "I can't help with that." },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const { v, r } = all(input);
    assert.equal(v.format, "openai-chat");
    assert.deepEqual(v.issues, []);
    assert.deepEqual(r.messages, input);
  });

  it("Anthropic: string, array, empty and missing content do not throw", () => {
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      { role: "assistant", content: [] },
      { role: "user" },
    ];
    const { v, r, t } = all(input);
    assert.equal(v.format, "anthropic");
    assert.deepEqual(v.issues.map((i) => [i.rule, i.path]), [
      ["empty-message", "$[3]"],
      ["empty-message", "$[4]"],
    ]);
    assert.equal(validate(r.messages).ok, true);
    assert.equal(validate(t.messages).ok, true);
  });

  it("Gemini: parts with inline data, thoughts and missing parts do not throw", () => {
    const input = [
      { role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] },
      { role: "model", parts: [{ text: "thinking", thought: true }, { functionCall: { name: "f", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: { output: 1 } } }] },
      { role: "model" },
    ];
    const { v, r } = all(input);
    assert.equal(v.format, "gemini");
    assert.deepEqual(v.issues.map((i) => i.rule), ["empty-message"]);
    assert.equal(validate(r.messages).ok, true);
  });

  it("non-object items inside a known format are kept, not crashed on", () => {
    const input = [{ role: "user", content: "hi" }, 42, null];
    const r = repair(input, { format: "openai-chat" });
    assert.deepEqual(r.messages, input);
    assert.equal(validate(input, { format: "openai-chat" }).ok, true);
  });
});

describe("request body objects come back in the same shape", () => {
  const chatBody = {
    model: "any-model",
    temperature: 0,
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "gone", content: "x" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
  };
  const responsesBody = {
    model: "any-model",
    input: [
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { role: "user", content: "skip" },
    ],
  };
  const anthropicBody = {
    max_tokens: 100,
    system: "s",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
      { role: "user", content: "stop" },
    ],
  };
  const geminiBody = {
    systemInstruction: { parts: [{ text: "s" }] },
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
      { role: "user", parts: [{ text: "stop" }] },
    ],
  };

  const cases: [string, Record<string, unknown>, string, string][] = [
    ["{messages} chat", chatBody, "openai-chat", "messages"],
    ["{input} responses", responsesBody, "openai-responses", "input"],
    ["{messages, system} anthropic", anthropicBody, "anthropic", "messages"],
    ["{contents} gemini", geminiBody, "gemini", "contents"],
  ];
  for (const [label, body, format, key] of cases) {
    it(`${label}: same keys, other fields untouched, list repaired`, () => {
      const before = JSON.stringify(body);
      assert.equal(detectFormat(body), format);
      const { v, r, t } = all(body);
      assert.equal(v.format, format);
      assert.equal(v.ok, false);
      assert.ok(v.issues[0]!.path.startsWith(`$.${key}[`), v.issues[0]!.path);
      for (const out of [r.messages, t.messages] as Record<string, unknown>[]) {
        assert.deepEqual(Object.keys(out), Object.keys(body));
        for (const k of Object.keys(body)) if (k !== key) assert.deepEqual(out[k], body[k]);
        assert.ok(Array.isArray(out[key]));
        assert.equal(validate(out).ok, true);
      }
      assert.equal(JSON.stringify(body), before);
    });
  }

  it("Responses body with a string input passes through", () => {
    const body = { model: "m", input: "hello" };
    assert.equal(detectFormat(body), "openai-responses");
    assert.deepEqual(validate(body).issues, []);
    assert.deepEqual(repair(body).messages, body);
    assert.deepEqual(trimToBudget(body, { budget: 1 }).messages, body);
  });

  it("empty array is a clean openai-chat history", () => {
    assert.equal(detectFormat([]), "openai-chat");
    assert.deepEqual(repair([]).messages, []);
    assert.deepEqual(trimToBudget([], { budget: 0 }).messages, []);
  });
});

describe("errors", () => {
  for (const bad of [null, undefined, 42, "text", true]) {
    it(`non array/object input (${String(bad)}) throws InvalidInputError`, () => {
      for (const fn of [() => detectFormat(bad), () => validate(bad), () => repair(bad), () => trimToBudget(bad, { budget: 1 })]) {
        assert.throws(fn, (e: unknown) => e instanceof InvalidInputError && e instanceof ToolpairError);
      }
    });
  }

  const unknownShapes: [string, unknown][] = [
    ["object without a list", { foo: [] }],
    ["array of numbers", [1, 2, 3]],
    ["items without role/type/parts", [{ text: "hi" }]],
    ["mixed shapes", [{ role: "user", parts: [{ text: "a" }] }, { role: "tool", tool_call_id: "x", content: "b" }]],
  ];
  for (const [label, shape] of unknownShapes) {
    it(`unrecognized shape (${label}) throws UnknownFormatError`, () => {
      for (const fn of [() => detectFormat(shape), () => validate(shape), () => repair(shape)]) {
        assert.throws(fn, (e: unknown) => e instanceof UnknownFormatError && e instanceof ToolpairError);
      }
    });
  }

  it("unknown format option throws InvalidInputError", () => {
    assert.throws(() => validate([], { format: "cohere" as never }), InvalidInputError);
  });

  it("circular input throws InvalidInputError instead of overflowing the stack", () => {
    const msg: Record<string, unknown> = { role: "user", content: "hi" };
    msg.self = msg;
    assert.throws(() => repair([msg]), InvalidInputError);
  });
});

describe("core stays browser-safe", () => {
  it("no node: imports outside src/cli", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === "cli" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)],
      );
    for (const file of walk(join(ROOT, "src"))) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /from "node:/, file);
    }
  });
});
