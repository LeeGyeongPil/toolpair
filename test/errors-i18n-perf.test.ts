// Regression tests for QA round 1: translated library/argument errors (Q-4, Q-5),
// error codes on library exceptions, large-history repair speed (Q-6), EPIPE handling (Q-7).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { InvalidInputError, UnknownFormatError, repair, trimToBudget, validate, detectFormat } from "../src/index.js";
import { CLI, ROOT, hasHangul, runCli } from "./helpers.js";

let tmp = "";
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "toolpair-q4-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** English sentence fragments that the library and Node put in their raw messages. */
const ENGLISH_LEAKS = [/object has no/, /expected a message array/, /request body has no/, /Unknown option/i, /is ambiguous/, /argument missing/, /mixed message shapes/, /is not an object/];

function file(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe("library errors carry a stable code and params", () => {
  it("UnknownFormatError / InvalidInputError expose code and params, message stays English", () => {
    const cases: [() => unknown, string, string, Record<string, string | number>][] = [
      [() => detectFormat({ foo: 1 }), "UnknownFormatError", "no-list", {}],
      [() => detectFormat([1]), "UnknownFormatError", "item-not-object", { index: 0 }],
      [() => detectFormat([{ x: 1 }]), "UnknownFormatError", "item-unrecognized", { index: 0 }],
      [() => detectFormat("s"), "InvalidInputError", "not-conversation", { got: "string" }],
      [() => validate({ foo: [] }, { format: "anthropic" }), "UnknownFormatError", "no-list-for-format", { key: "messages", format: "anthropic" }],
      [() => trimToBudget([], { budget: -1 }), "InvalidInputError", "bad-budget", {}],
      [() => repair([], { missingResults: "x" as never }), "InvalidInputError", "bad-missing-results", {}],
    ];
    for (const [fn, name, code, params] of cases) {
      try {
        fn();
        assert.fail("expected an error");
      } catch (e) {
        const err = e as InvalidInputError;
        assert.equal(err.name, name);
        assert.ok(err instanceof (name === "UnknownFormatError" ? UnknownFormatError : InvalidInputError));
        assert.equal(err.code, code);
        assert.deepEqual(err.params, params);
        assert.ok(!hasHangul(err.message));
      }
    }
  });
});

describe("Korean CLI errors have no English library sentences", () => {
  const cases: [string, string[], RegExp][] = [
    ["unknown shape", ["lint", "unk.json"], /형식을 알 수 없습니다: 객체에 messages, input, contents 배열이 없습니다/],
    ["not a conversation", ["lint", "str.json"], /대화 기록이 아닙니다: 메시지 배열이나 요청 본문 객체가 아니라 string 입니다/],
    ["wrong --format", ["lint", "gem.json", "--format", "anthropic"], /--format 으로 지정한 형식으로 보이지 않습니다: 요청 본문에 anthropic 형식에 필요한 "messages" 배열이 없습니다 \(--format auto/],
    ["bad item", ["lint", "item.json"], /0번째 항목이 객체가 아닙니다/],
    ["unknown option", ["lint", "unk.json", "--frob"], /알 수 없는 옵션: --frob/],
    ["missing option value", ["trim", "unk.json", "--budget", "-5"], /--budget 옵션에는 값이 필요합니다.*--budget=값/],
  ];
  for (const [name, args, expected] of cases) {
    it(name, () => {
      file("unk.json", '{"foo":1}');
      file("str.json", '"str"');
      file("gem.json", JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }));
      file("item.json", "[1]");
      const r = runCli(args, { cwd: tmp, env: { TOOLPAIR_LANG: "ko" } });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, expected);
      for (const leak of ENGLISH_LEAKS) assert.doesNotMatch(r.stderr, leak);
    });
  }

  it("English output keeps the same facts", () => {
    file("unk.json", '{"foo":1}');
    const r = runCli(["lint", "unk.json", "--lang", "en"], { cwd: tmp });
    assert.match(r.stderr, /cannot tell the format of unk\.json: the object has no messages, input or contents array \(try --format\)/);
    const u = runCli(["lint", "unk.json", "--frob", "--lang", "en"], { cwd: tmp });
    assert.match(u.stderr, /unknown option --frob/);
  });

  it("an explicit --format is not told to 'try --format' (Q-5)", () => {
    file("gem.json", JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }));
    for (const lang of ["en", "ko"]) {
      const r = runCli(["lint", "gem.json", "--format", "anthropic", "--lang", lang], { cwd: tmp });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--format auto/);
      assert.doesNotMatch(r.stderr, /try --format\)|--format 으로 지정해 보세요/);
    }
  });
});

describe("large histories with many broken pairs (Q-6)", () => {
  it("repair and trimToBudget handle 20000 turns / 6667 fixes quickly and stay valid", () => {
    const h: unknown[] = [{ role: "system", content: "s" }];
    for (let i = 0; i < 20000; i++) {
      h.push({ role: "user", content: "q" + i });
      h.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "f", arguments: "{}" } }] });
      if (i % 3) h.push({ role: "tool", tool_call_id: "c" + i, content: "r" });
    }
    const t0 = Date.now();
    const r = repair(h);
    const trimmed = trimToBudget(h, { budget: 5000 });
    const ms = Date.now() - t0;
    assert.equal(r.changes.length, 6667);
    assert.ok(validate(r.messages).ok);
    assert.ok(validate(trimmed.messages).ok);
    // Before batching this took about a minute; allow a very generous limit for slow machines.
    assert.ok(ms < 15_000, `took ${ms} ms`);
  });
});

describe("closed output pipe (Q-7)", () => {
  it("the CLI exits quietly when the reader closes early", async () => {
    // --help writes to stdout; destroying our end of the pipe at once must not print a stack trace.
    const child = spawn(process.execPath, [CLI, "--help"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.stdout.destroy();
    const code: number | null = await new Promise((resolve) => child.on("close", resolve));
    assert.ok(code === 0 || code === null, `exit ${code}`);
    assert.doesNotMatch(err, /Unhandled 'error' event|EPIPE/);
  });

  it("lint keeps exit code 1 when the reader closes early (like `lint big.json | head -3`)", async () => {
    // 3000 orphan results -> a report far larger than a pipe buffer, so the write really hits a closed pipe.
    const big: unknown[] = [{ role: "user", content: "hi" }];
    for (let i = 0; i < 3000; i++) big.push({ role: "tool", tool_call_id: "gone" + i, content: "x" });
    const path = file("big-orphans.json", JSON.stringify(big));
    const child = spawn(process.execPath, [CLI, "lint", path, "--lang", "en"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.stdout.destroy();
    const code: number | null = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 1, `exit ${code}, stderr: ${err}`);
    assert.doesNotMatch(err, /Unhandled 'error' event|EPIPE|ECONNRESET/);
  });
});
