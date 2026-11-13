// 화면 언어 결정: --lang > TOOLPAIR_LANG > LC_ALL > LC_MESSAGES > LANG. 한국어가 아니면 영어.
import { MESSAGES, type MessageKey } from "./messages.js";

export type Lang = "en" | "ko";

/** "ko", "ko_KR.UTF-8", "ko-KR" → ko, 그 밖은 en. */
export function toLang(value: string): Lang {
  return /^ko([_\-.@]|$)/i.test(value.trim()) ? "ko" : "en";
}

/** argv 에서 --lang 값을 미리 찾는다(인자 오류 메시지도 고른 언어로 보이게 하려고 파싱 전에 본다). */
function langFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === "--lang") return argv[i + 1] ?? "";
    if (a.startsWith("--lang=")) return a.slice("--lang=".length);
  }
  return undefined;
}

export function resolveLang(argv: string[], env: Record<string, string | undefined>): Lang {
  const fromArg = langFromArgv(argv);
  if (fromArg !== undefined) return toLang(fromArg);
  for (const name of ["TOOLPAIR_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const v = env[name];
    if (v && v.trim()) return toLang(v);
  }
  return "en";
}

/** 문구를 꺼내 {name} 자리를 채운다. */
export function format(lang: Lang, key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = MESSAGES[lang][key] ?? MESSAGES.en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** 언어를 고정한 번역 함수. */
export function translator(lang: Lang) {
  return (key: MessageKey, params?: Record<string, string | number>) => format(lang, key, params);
}
