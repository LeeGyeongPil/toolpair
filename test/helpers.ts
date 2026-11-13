// 테스트 공용: 픽스처 목록 읽기, 빌드한 CLI 실행.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Change, Format, Issue } from "../src/index.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(ROOT, "fixtures");
export const CLI = join(ROOT, "dist", "cli.cjs");
export const FORMATS: Format[] = ["openai-chat", "openai-responses", "anthropic", "gemini"];

export interface Fixture {
  format: Format;
  name: string;
  /** 저장소 루트 기준 경로(CLI 인자로 쓴다). */
  rel: string;
  input: unknown;
  expect: { format: Format; issues: Issue[]; changes: Change[] };
}

/** fixtures/<format>/<case>.json 과 짝 *.expect.json 을 모두 읽는다. */
export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const format of FORMATS) {
    const dir = join(FIXTURES, format);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json") || file.endsWith(".expect.json")) continue;
      const name = file.replace(/\.json$/, "");
      out.push({
        format,
        name,
        rel: `fixtures/${format}/${file}`,
        input: JSON.parse(readFileSync(join(dir, file), "utf8")),
        expect: JSON.parse(readFileSync(join(dir, `${name}.expect.json`), "utf8")),
      });
    }
  }
  return out;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 빌드한 CLI(dist/cli.cjs)를 자식 프로세스로 실행한다. env 는 언어 변수를 지운 깨끗한 환경 위에 덧붙인다. */
export function runCli(args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string } = {}): RunResult {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "TOOLPAIR_LANG" || k === "LANG" || k === "LANGUAGE" || k.startsWith("LC_")) continue;
    base[k] = v;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: { ...base, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 한글이 들어 있는가(화면 언어 확인용). */
export const hasHangul = (s: string): boolean => /[가-힣]/.test(s);
