// toolpair CLI: lint / fix / trim. 라이브러리 코어 위의 얇은 껍데기다.
// 종료 코드: 0 정상, 1 문제 발견(lint)·수리 후에도 오류(fix), 2 사용법·입력 오류.
import { readFileSync, readSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { InvalidInputError, ToolpairError, UnknownFormatError } from "../errors.js";
import { repair } from "../repair.js";
import { trimToBudget } from "../trim.js";
import type { Change, FormatOption, Issue } from "../types.js";
import { validate } from "../validate.js";
import { resolveLang, translator } from "./i18n.js";
import { en, type MessageKey } from "./messages.js";

// 빌드할 때 esbuild 가 package.json 의 버전으로 바꿔 넣는다.
declare const __TOOLPAIR_VERSION__: string;
const VERSION = typeof __TOOLPAIR_VERSION__ === "string" ? __TOOLPAIR_VERSION__ : "0.0.0-dev";

const FORMAT_OPTIONS = ["auto", "openai-chat", "openai-responses", "anthropic", "gemini"];

type T = ReturnType<typeof translator>;

/** 사용법·입력 오류(종료 코드 2). 메시지는 이미 번역된 문자열. */
class CliError extends Error {
  constructor(
    message: string,
    readonly showHint = false,
  ) {
    super(message);
  }
}

/** 터미널 표시 폭: 한글 등 넓은 글자는 2칸으로 센다(표 줄맞춤용). */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

/** 행 목록을 열 맞춤 표로. 마지막 열은 채우지 않는다. */
function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const cols = rows[0]!.length;
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => width(r[c] ?? ""))));
  return rows.map((r) => "  " + r.map((cell, c) => (c === cols - 1 ? cell : pad(cell, widths[c]!))).join("  ").trimEnd());
}

function listLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null) {
    const body = value as Record<string, unknown>;
    for (const key of ["messages", "input", "contents"]) if (Array.isArray(body[key])) return (body[key] as unknown[]).length;
  }
  return 0;
}

// Reads all of standard input synchronously. readFileSync(0) can throw EAGAIN or EOF on Linux
// when stdin is a non-blocking pipe (common in CI runners), so read in a loop and retry.
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // short sleep, then retry
        continue;
      }
      if (code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readInput(file: string, t: T): { data: unknown; label: string } {
  const label = file === "-" ? t("label.stdin") : file;
  let text: string;
  try {
    // "-" 는 표준 입력(파일 설명자 0).
    text = file === "-" ? readStdin() : readFileSync(file, "utf8");
  } catch (e) {
    throw new CliError(t("err.readFile", { file: label, detail: (e as Error).message }));
  }
  try {
    return { data: JSON.parse(text), label };
  } catch (e) {
    throw new CliError(t("err.badJson", { file: label, detail: (e as Error).message }));
  }
}

function writeOutput(out: string | undefined, value: unknown, t: T): string | null {
  const json = JSON.stringify(value, null, 2) + "\n";
  if (!out || out === "-") {
    process.stdout.write(json);
    return null;
  }
  try {
    writeFileSync(out, json);
  } catch (e) {
    throw new CliError(t("err.writeFile", { file: out, detail: (e as Error).message }));
  }
  return out;
}

function issueRows(issues: Issue[], t: T): string[][] {
  return issues.map((i) => [t(`sev.${i.severity}` as MessageKey), i.rule, i.path, i.ids.join(", ") || "-", t(`rule.${i.rule}` as MessageKey)]);
}

function changeRows(changes: Change[], t: T): string[][] {
  return changes.map((c) => [c.op, c.path, c.ids.join(", ") || "-", t(`op.${c.op}` as MessageKey)]);
}

/** 라이브러리 예외를 CLI 오류(종료 코드 2)로 바꾼다. */
function guard<R>(label: string, t: T, explicitFormat: boolean, fn: () => R): R {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ToolpairError) {
      // 라이브러리 오류의 영어 message 대신 code 로 번역 문구를 고른다(코드가 없으면 원문).
      const key = `err.code.${e.code ?? ""}`;
      const detail = key in en ? t(key as MessageKey, e.params) : t("err.code.other", { message: e.message });
      if (e instanceof UnknownFormatError) {
        throw new CliError(t(explicitFormat ? "err.formatMismatch" : "err.unknownFormat", { file: label, detail }));
      }
      if (e instanceof InvalidInputError) throw new CliError(t("err.invalidInput", { file: label, detail }));
    }
    throw e;
  }
}

/** parseArgs 의 영어 오류를 code 로 구분해 번역 문구로 바꾼다. */
function argsError(e: unknown, t: T): string {
  const err = e as { code?: string; message?: string };
  const option = /'(-[^'\s]*)/.exec(err.message ?? "")?.[1] ?? "";
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return t("err.badArgsUnknownOption", { option });
  if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return t("err.badArgsNeedsValue", { option });
  return t("err.badArgs", { detail: err.message ?? String(e) });
}

export function run(argv: string[], env: Record<string, string | undefined>): number {
  const t = translator(resolveLang(argv, env));
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          format: { type: "string" },
          json: { type: "boolean" },
          out: { type: "string", short: "o" },
          missing: { type: "string" },
          "open-call": { type: "string" },
          budget: { type: "string" },
          lang: { type: "string" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean", short: "v" },
        },
      });
    } catch (e) {
      throw new CliError(argsError(e, t), true);
    }
    const { values: opt, positionals } = parsed;

    if (opt.help) {
      process.stdout.write(t("help", { version: VERSION }) + "\n");
      return 0;
    }
    if (opt.version) {
      process.stdout.write(VERSION + "\n");
      return 0;
    }

    const [cmd, ...files] = positionals;
    if (!cmd) throw new CliError(t("err.noCommand"), true);
    if (cmd !== "lint" && cmd !== "fix" && cmd !== "trim") throw new CliError(t("err.unknownCommand", { cmd }), true);
    if (files.length === 0) throw new CliError(t("err.noFile"), true);
    if (files.length > 1) throw new CliError(t("err.tooManyFiles", { n: files.length }), true);

    // 명령마다 쓸 수 있는 옵션만 받는다(조용히 무시하면 사용자가 효과를 착각한다).
    const allowed: Record<string, string[]> = {
      lint: ["json"],
      fix: ["out", "missing", "open-call"],
      trim: ["out", "budget"],
    };
    for (const name of ["json", "out", "missing", "open-call", "budget"]) {
      if ((opt as Record<string, unknown>)[name] !== undefined && !allowed[cmd]!.includes(name)) {
        throw new CliError(t("err.optionNotFor", { option: `--${name}`, cmd }), true);
      }
    }
    if (opt.format !== undefined && !FORMAT_OPTIONS.includes(opt.format)) throw new CliError(t("err.badFormatOpt"), true);
    const format = (opt.format ?? "auto") as FormatOption;

    // trim 의 예산은 파일을 읽기 전에 확인한다.
    let budget = 0;
    if (cmd === "trim") {
      if (opt.budget === undefined) throw new CliError(t("err.noBudget"), true);
      budget = Number(opt.budget);
      if (opt.budget.trim() === "" || !Number.isFinite(budget) || budget < 0) throw new CliError(t("err.badBudget"), true);
    }
    if (opt.missing !== undefined && opt.missing !== "synthesize" && opt.missing !== "drop-call") {
      throw new CliError(t("err.badMissing"), true);
    }
    const openCall = opt["open-call"];
    if (openCall !== undefined && openCall !== "keep" && openCall !== "cancel") throw new CliError(t("err.badOpenCall"), true);

    const { data, label } = readInput(files[0]!, t);

    if (cmd === "lint") {
      const result = guard(label, t, format !== "auto", () => validate(data, { format }));
      const errors = result.issues.filter((i) => i.severity === "error").length;
      const warnings = result.issues.length - errors;
      if (opt.json) {
        const report = { file: label, format: result.format, ok: result.ok, errors, warnings, issues: result.issues };
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        const lines = [`${label}  (${t("label.format")}: ${result.format})`, ...table(issueRows(result.issues, t))];
        if (!result.ok) lines.push(t("lint.fail", { errors, warnings }));
        else if (warnings > 0) lines.push(t("lint.okWarnings", { warnings }));
        else lines.push(t("lint.ok"));
        process.stdout.write(lines.join("\n") + "\n");
      }
      return result.ok ? 0 : 1;
    }

    if (cmd === "fix") {
      const result = guard(label, t, format !== "auto", () =>
        repair(data, {
          format,
          missingResults: opt.missing as "synthesize" | "drop-call" | undefined,
          openCallAtEnd: openCall as "keep" | "cancel" | undefined,
        }),
      );
      const after = validate(result.messages, { format: result.format });
      const errors = after.issues.filter((i) => i.severity === "error").length;
      const wrote = writeOutput(opt.out, result.messages, t);
      const lines = [`${label}  (${t("label.format")}: ${result.format})`, ...table(changeRows(result.changes, t))];
      if (result.changes.length === 0) lines.push(t("fix.none"));
      else if (after.ok) lines.push(t("fix.done", { n: result.changes.length }));
      if (!after.ok) lines.push(t("fix.stillInvalid", { errors }));
      if (wrote) lines.push(t("out.wrote", { file: wrote }));
      // 결과 JSON 이 표준 출력으로 나가면 보고서는 표준 오류로 보내 파이프를 깨끗하게 둔다.
      (wrote ? process.stdout : process.stderr).write(lines.join("\n") + "\n");
      return after.ok ? 0 : 1;
    }

    // trim
    const result = guard(label, t, format !== "auto", () => trimToBudget(data, { budget, format }));
    const total = listLength(guard(label, t, format !== "auto", () => repair(data, { format })).messages);
    const wrote = writeOutput(opt.out, result.messages, t);
    const lines = [`${label}  (${t("label.format")}: ${result.format})`];
    if (result.changes.length > 0) {
      lines.push(t("trim.repaired", { n: result.changes.length }), ...table(changeRows(result.changes, t)));
    }
    lines.push(
      t("trim.summary", {
        kept: listLength(result.messages),
        total,
        tokens: result.tokens,
        budget,
        dropped: result.droppedUnits,
      }),
    );
    if (result.overBudget) lines.push(t("trim.overBudget"));
    if (wrote) lines.push(t("out.wrote", { file: wrote }));
    (wrote ? process.stdout : process.stderr).write(lines.join("\n") + "\n");
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`toolpair: ${t("err.prefix")}: ${e.message}\n`);
      if (e.showHint) process.stderr.write(t("usage.hint") + "\n");
      return 2;
    }
    throw e;
  }
}

// 출력을 받는 쪽이 먼저 닫혀도(예: `| head`) 스택 트레이스 없이 조용히 끝낸다.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  // Linux reports a reader that vanished as EPIPE or, for socket pipes, ECONNRESET.
  // 종료 코드는 명령이 이미 정한 값을 지킨다(lint 가 문제를 찾았으면 1) — 파이프가 일찍 닫혀도 CI 가 통과로 착각하지 않게.
  // 쓰기 오류는 다음 틱에 오므로 이때는 run() 이 끝나 process.exitCode 가 정해져 있다.
  if (e.code === "EPIPE" || e.code === "ECONNRESET") process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  throw e;
});

// 직접 실행될 때만 돈다(빌드 산출물 dist/cli.cjs).
process.exitCode = run(process.argv.slice(2), process.env);
