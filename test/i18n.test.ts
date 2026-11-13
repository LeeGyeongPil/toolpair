// AC-8: 화면 언어 — --lang 과 환경 변수에 따라 --help·lint 요약이 영어/한국어로 바뀌고,
// en·ko 메시지 키 집합이 같다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveLang, toLang } from "../src/cli/i18n.js";
import { en, ko } from "../src/cli/messages.js";
import { hasHangul, runCli } from "./helpers.js";

const BROKEN = "fixtures/openai-chat/sliding-window-orphan.json";

describe("message tables", () => {
  it("en and ko have exactly the same keys", () => {
    assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
  });

  it("every Korean message is non-empty and keeps the same {placeholders}", () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.ok(ko[key].trim().length > 0, key);
      assert.deepEqual(holes(ko[key]), holes(en[key]), key);
    }
  });

  it("every rule and change op has a message in both languages", () => {
    const rules = ["orphan-result", "missing-result", "open-call-at-end", "duplicate-call-id", "result-not-adjacent", "result-not-first", "empty-message"];
    const ops = ["drop-orphan-result", "insert-synthetic-result", "move-result", "drop-call", "drop-empty-message", "merge-same-role"];
    for (const id of rules) assert.ok(`rule.${id}` in en && `rule.${id}` in ko, id);
    for (const id of ops) assert.ok(`op.${id}` in en && `op.${id}` in ko, id);
  });
});

describe("language resolution", () => {
  it("--lang beats TOOLPAIR_LANG beats LC_ALL / LC_MESSAGES / LANG", () => {
    assert.equal(resolveLang(["--lang", "en"], { TOOLPAIR_LANG: "ko", LANG: "ko_KR.UTF-8" }), "en");
    assert.equal(resolveLang(["--lang=ko"], { TOOLPAIR_LANG: "en" }), "ko");
    assert.equal(resolveLang([], { TOOLPAIR_LANG: "ko", LANG: "en_US.UTF-8" }), "ko");
    assert.equal(resolveLang([], { LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
    assert.equal(resolveLang([], { LC_MESSAGES: "en_US.UTF-8", LANG: "ko_KR.UTF-8" }), "en");
    assert.equal(resolveLang([], { LANG: "ko_KR.UTF-8" }), "ko");
    assert.equal(resolveLang([], {}), "en");
  });

  it("anything that is not Korean falls back to English", () => {
    for (const v of ["fr_FR.UTF-8", "C", "POSIX", "ja_JP", "kok_IN", ""]) assert.equal(toLang(v), "en", v);
    for (const v of ["ko", "ko_KR", "ko-KR", "KO_kr.utf8", "ko_KR.UTF-8"]) assert.equal(toLang(v), "ko", v);
  });
});

describe("CLI screens", () => {
  it("--lang ko and --lang en switch --help", () => {
    const koHelp = runCli(["--help", "--lang", "ko"]);
    const enHelp = runCli(["--help", "--lang", "en"]);
    assert.equal(koHelp.code, 0);
    assert.equal(enHelp.code, 0);
    assert.ok(hasHangul(koHelp.stdout), koHelp.stdout);
    assert.match(koHelp.stdout, /사용법:/);
    assert.ok(!hasHangul(enHelp.stdout), enHelp.stdout);
    assert.match(enHelp.stdout, /Usage:/);
  });

  it("--lang ko and --lang en switch the lint summary", () => {
    const koLint = runCli(["lint", BROKEN, "--lang", "ko"]);
    const enLint = runCli(["lint", BROKEN, "--lang", "en"]);
    assert.equal(koLint.code, 1);
    assert.equal(enLint.code, 1);
    assert.match(koLint.stdout, /실패: 오류 2건, 경고 0건/);
    assert.match(enLint.stdout, /FAIL: 2 error\(s\), 0 warning\(s\)/);
    assert.ok(!hasHangul(enLint.stdout));
    // 규칙 id·경로는 두 언어에서 같다(검색·자동화용).
    for (const out of [koLint.stdout, enLint.stdout]) assert.ok(out.includes("orphan-result") && out.includes("$[1]"));
  });

  it("TOOLPAIR_LANG=ko gives Korean", () => {
    const r = runCli(["lint", BROKEN], { env: { TOOLPAIR_LANG: "ko" } });
    assert.ok(hasHangul(r.stdout));
  });

  it("LANG=ko_KR.UTF-8 gives Korean, LANG=fr_FR.UTF-8 gives English", () => {
    assert.ok(hasHangul(runCli(["--help"], { env: { LANG: "ko_KR.UTF-8" } }).stdout));
    const fr = runCli(["--help"], { env: { LANG: "fr_FR.UTF-8" } });
    assert.ok(!hasHangul(fr.stdout));
    assert.match(fr.stdout, /Usage:/);
  });

  it("--lang overrides the environment", () => {
    const r = runCli(["lint", BROKEN, "--lang", "en"], { env: { TOOLPAIR_LANG: "ko", LANG: "ko_KR.UTF-8" } });
    assert.ok(!hasHangul(r.stdout));
    const k = runCli(["lint", BROKEN, "--lang", "ko"], { env: { TOOLPAIR_LANG: "en", LANG: "fr_FR.UTF-8" } });
    assert.ok(hasHangul(k.stdout));
  });

  it("error messages follow the language too", () => {
    const koErr = runCli(["lint", "--lang", "ko"]);
    const enErr = runCli(["lint", "--lang", "en"]);
    assert.equal(koErr.code, 2);
    assert.match(koErr.stderr, /toolpair: 오류: 입력 파일이 없습니다/);
    assert.match(enErr.stderr, /toolpair: error: missing input file/);
  });

  it("fix and trim summaries are translated", () => {
    const fixKo = runCli(["fix", "fixtures/openai-chat/cancelled-parallel.json", "--lang", "ko"]);
    assert.match(fixKo.stderr, /변경 2건/);
    const trimKo = runCli(["trim", "fixtures/gemini/valid.json", "--budget", "60", "--lang", "ko"]);
    assert.match(trimKo.stderr, /메시지 9개 중 \d+개 유지/);
  });
});
