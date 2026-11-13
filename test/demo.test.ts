// AC-10 보조: 오프라인 데모가 키·네트워크 없이 끝나고, 교훈(단순 slice INVALID / trimToBudget VALID)과
// "practice mock" 표시를 두 언어 모두에서 보여 주는지 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROOT, hasHangul } from "./helpers.js";

function demo(lang: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "examples/demo.ts"), "--lang", lang], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    // 네트워크·키가 필요 없다는 것을 보이려고 관련 변수를 비운다.
    env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", HTTPS_PROXY: "http://127.0.0.1:9" },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("npm run demo", () => {
  it("English: exit 0, naive slice INVALID, trimToBudget VALID, practice mock label, 4 formats VALID after repair", () => {
    const r = demo("en");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /naive slice: INVALID/);
    assert.match(r.out, /trimToBudget: VALID/);
    assert.match(r.out, /practice mock/);
    for (const f of ["openai-chat", "openai-responses", "anthropic", "gemini"]) assert.match(r.out, new RegExp(`^  ${f}  `, "m"));
    assert.equal((r.out.match(/before: INVALID/g) ?? []).length, 4);
    assert.equal((r.out.match(/after: {2}VALID/g) ?? []).length, 4);
  });

  it("Korean: same verdicts with Korean labels", () => {
    const r = demo("ko");
    assert.equal(r.code, 0, r.err);
    assert.ok(hasHangul(r.out));
    assert.match(r.out, /naive slice: INVALID/);
    assert.match(r.out, /trimToBudget: VALID/);
    assert.match(r.out, /practice mock/);
    assert.equal((r.out.match(/수리 후: VALID/g) ?? []).length, 4);
  });
});
