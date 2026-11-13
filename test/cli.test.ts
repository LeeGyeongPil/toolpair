// AC-6: CLI lint — 빌드한 dist/cli.cjs 를 자식 프로세스로 실행해 종료 코드와 출력을 본다.
// AC-7: CLI fix·trim 왕복 — 고친 파일·자른 파일을 다시 lint 하면 종료 0, "-" 로 표준 입력.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CLI, FIXTURES, loadFixtures, runCli } from "./helpers.js";

const EN = { LANG: "en_US.UTF-8" };
let tmp = "";

before(() => {
  assert.ok(existsSync(CLI), "run `npm run build` first (npm test does it for you)");
  tmp = mkdtempSync(join(tmpdir(), "toolpair-cli-"));
});
after(() => {
  // 임시 폴더는 테스트가 끝나면 지운다.
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("lint", () => {
  it("sliding-window-orphan: exit 1, prints orphan-result, $[1] and call_a", () => {
    const r = runCli(["lint", "fixtures/openai-chat/sliding-window-orphan.json"], { env: EN });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /orphan-result/);
    assert.ok(r.stdout.includes("$[1]"));
    assert.match(r.stdout, /call_a/);
    assert.match(r.stdout, /FAIL: 2 error\(s\), 0 warning\(s\)/);
  });

  it("--json output parses and has 2 issues", () => {
    const r = runCli(["lint", "fixtures/openai-chat/sliding-window-orphan.json", "--json"], { env: EN });
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.issues.length, 2);
    assert.equal(report.format, "openai-chat");
    assert.equal(report.ok, false);
    assert.deepEqual(report.issues[0], { rule: "orphan-result", severity: "error", path: "$[1]", ids: ["call_a"] });
  });

  it("valid fixtures exit 0", () => {
    for (const f of loadFixtures().filter((x) => x.name.startsWith("valid"))) {
      const r = runCli(["lint", f.rel], { env: EN });
      assert.equal(r.code, 0, `${f.rel}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /OK: no problems/);
    }
  });

  it("warnings only (open call at the end) exit 0", () => {
    const r = runCli(["lint", "fixtures/openai-chat/trailing-open-call.json"], { env: EN });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /open-call-at-end/);
  });

  it("every broken fixture exits 1", () => {
    for (const f of loadFixtures()) {
      if (f.expect.issues.every((i) => i.severity !== "error")) continue;
      assert.equal(runCli(["lint", f.rel], { env: EN }).code, 1, f.rel);
    }
  });

  it("malformed JSON exits 2", () => {
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ not json");
    const r = runCli(["lint", bad], { env: EN });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not valid JSON/);
  });

  it("missing file, unknown shape, unknown command and bad options exit 2", () => {
    const unknown = join(tmp, "unknown.json");
    writeFileSync(unknown, JSON.stringify({ foo: [] }));
    const notConversation = join(tmp, "number.json");
    writeFileSync(notConversation, "42");
    const cases: string[][] = [
      ["lint", join(tmp, "nope.json")],
      ["lint", unknown],
      ["lint", notConversation],
      ["frobnicate", "x.json"],
      ["lint"],
      [],
      ["lint", "a.json", "b.json"],
      ["lint", "fixtures/openai-chat/valid-parallel.json", "--format", "cohere"],
      ["lint", "fixtures/openai-chat/valid-parallel.json", "--no-such-flag"],
      ["lint", "fixtures/openai-chat/valid-parallel.json", "--budget", "5"],
    ];
    for (const args of cases) {
      const r = runCli(args, { env: EN });
      assert.equal(r.code, 2, `${args.join(" ")} -> ${r.code} ${r.stderr}`);
      assert.match(r.stderr, /^toolpair: error: /, args.join(" "));
    }
  });

  it("--format forces the format", () => {
    const r = runCli(["lint", "fixtures/openai-chat/valid-parallel.json", "--format", "openai-chat", "--json"], { env: EN });
    assert.equal(JSON.parse(r.stdout).format, "openai-chat");
  });

  it("reads standard input with -", () => {
    const text = readFileSync(join(FIXTURES, "openai-chat/sliding-window-orphan.json"), "utf8");
    const r = runCli(["lint", "-", "--json"], { env: EN, input: text });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).issues.length, 2);
  });

  it("--version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(FIXTURES, "..", "package.json"), "utf8"));
    const r = runCli(["--version"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  });
});

describe("fix and trim", () => {
  it("fix <broken> -o out.json, then lint out.json exits 0 (every broken fixture)", () => {
    for (const f of loadFixtures()) {
      const out = join(tmp, `fixed-${f.format}-${f.name}.json`);
      const fix = runCli(["fix", f.rel, "-o", out], { env: EN });
      assert.equal(fix.code, 0, `${f.rel}: ${fix.stdout}${fix.stderr}`);
      assert.match(fix.stdout, /wrote /);
      const lint = runCli(["lint", out], { env: EN });
      assert.equal(lint.code, 0, `${f.rel}: ${lint.stdout}`);
    }
  });

  it("fix reports the changes (cancelled parallel calls)", () => {
    const out = join(tmp, "fixed.json");
    const r = runCli(["fix", "fixtures/openai-chat/cancelled-parallel.json", "-o", out], { env: EN });
    assert.match(r.stdout, /insert-synthetic-result\s+\$\[2\]\.tool_calls\[0\]\s+call_a/);
    assert.match(r.stdout, /2 change\(s\); the result passes validation/);
  });

  it("fix --missing drop-call and --open-call cancel are passed through", () => {
    const dropped = join(tmp, "dropped.json");
    runCli(["fix", "fixtures/openai-chat/cancelled-parallel.json", "-o", dropped, "--missing", "drop-call"], { env: EN });
    assert.equal(JSON.parse(readFileSync(dropped, "utf8")).length, 3);
    const cancelled = join(tmp, "cancelled.json");
    runCli(["fix", "fixtures/openai-chat/trailing-open-call.json", "-o", cancelled, "--open-call", "cancel"], { env: EN });
    assert.equal(JSON.parse(readFileSync(cancelled, "utf8")).at(-1).role, "tool");
  });

  it("fix without -o writes JSON to stdout and the report to stderr", () => {
    const r = runCli(["fix", "fixtures/openai-chat/sliding-window-orphan.json"], { env: EN });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).length, 3);
    assert.match(r.stderr, /drop-orphan-result/);
  });

  it("trim <fixture> --budget 60 -o cut.json, then lint exits 0 (every fixture)", () => {
    for (const f of loadFixtures()) {
      const out = join(tmp, `cut-${f.format}-${f.name}.json`);
      const trim = runCli(["trim", f.rel, "--budget", "60", "-o", out], { env: EN });
      assert.equal(trim.code, 0, `${f.rel}: ${trim.stdout}${trim.stderr}`);
      assert.match(trim.stdout, /kept \d+ of \d+ messages, \d+ tokens \(budget 60\)/);
      const lint = runCli(["lint", out], { env: EN });
      assert.equal(lint.code, 0, `${f.rel}: ${lint.stdout}`);
    }
  });

  it("'-' reads stdin for fix and trim and pipes into lint", () => {
    const text = readFileSync(join(FIXTURES, "anthropic/result-not-adjacent.json"), "utf8");
    const fixed = runCli(["fix", "-"], { env: EN, input: text });
    assert.equal(fixed.code, 0);
    assert.equal(runCli(["lint", "-"], { env: EN, input: fixed.stdout }).code, 0);
    const cut = runCli(["trim", "-", "--budget", "40"], { env: EN, input: text });
    assert.equal(cut.code, 0);
    assert.equal(runCli(["lint", "-"], { env: EN, input: cut.stdout }).code, 0);
  });

  it("trim needs a valid --budget", () => {
    assert.equal(runCli(["trim", "fixtures/gemini/valid.json"], { env: EN }).code, 2);
    assert.equal(runCli(["trim", "fixtures/gemini/valid.json", "--budget", "-3"], { env: EN }).code, 2);
    assert.equal(runCli(["trim", "fixtures/gemini/valid.json", "--budget", "lots"], { env: EN }).code, 2);
  });

  it("trim keeps the request body shape (Gemini contents + systemInstruction)", () => {
    const r = runCli(["trim", "fixtures/gemini/valid.json", "--budget", "60"], { env: EN });
    const body = JSON.parse(r.stdout);
    assert.ok(Array.isArray(body.contents));
    assert.ok(body.systemInstruction);
  });
});
