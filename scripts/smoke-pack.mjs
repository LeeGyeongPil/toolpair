// 패키징 점검: npm pack 으로 만든 tarball 을 임시 폴더에 설치해
// ESM import · CJS require · npx toolpair --version 이 실제로 되는지 확인한다.
// 성공하면 "esm ok", "cjs ok", "cli ok" 를 출력하고 종료 코드 0.
//
// 주의(0.1.2): npm 10(Node 20·22 에 들어 있는 npm)은 `npm pack --ignore-scripts` 에서도 prepare 를 돌리고,
// 그 출력이 `--json` 결과와 같은 표준 출력에 섞인다. 그래서 npm 의 표준 출력을 해석하지 않고
// 만들어진 tarball 파일을 직접 찾아 내용을 읽는다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const shell = process.platform === "win32";

// `npm run smoke:pack` 을 실행한 바로 그 npm 을 다시 부른다(npm_execpath).
// PATH 의 다른 npm 이 불리면 CI(번들 npm 10)와 로컬(npm 11)의 동작 차이를 로컬에서 재현하지 못한다.
const npmCli = process.env.npm_execpath;
function npm(args, opts) {
  if (npmCli && /npm-cli\.js$/.test(npmCli)) return execFileSync(process.execPath, [npmCli, ...args], opts);
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { ...opts, shell });
}

// 런타임 의존성 0 이어야 한다.
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  console.error(`dependencies must be empty, got ${JSON.stringify(pkg.dependencies)}`);
  process.exit(1);
}
console.log("deps ok (no runtime dependencies)");

const work = mkdtempSync(join(tmpdir(), "toolpair-pack-"));
try {
  // --ignore-scripts: 이미 빌드한 dist 를 그대로 싼다(npm run build 를 먼저 실행).
  // 표준 출력은 버린다 — npm 버전에 따라 prepare 출력이 섞이므로 해석 대상이 아니다.
  npm(["pack", "--ignore-scripts", "--pack-destination", work], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const tgz = readdirSync(work).filter((f) => f.endsWith(".tgz"));
  if (tgz.length !== 1) throw new Error(`expected one tarball in ${work}, found ${JSON.stringify(tgz)}`);
  const tarball = join(work, tgz[0]);
  // tarball 안의 파일 목록은 tar 로 직접 읽는다(항목은 "package/" 로 시작).
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ""));
  for (const must of ["dist/index.mjs", "dist/index.cjs", "dist/cli.cjs", "dist/types/esm/index.d.ts", "dist/types/cjs/index.d.ts", "package.json"]) {
    if (!files.includes(must)) throw new Error(`tarball is missing ${must}`);
  }

  // 빈 프로젝트에 tarball 만 설치한다(의존성이 없으니 네트워크가 필요 없다).
  const app = join(work, "app");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(app)})`]);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true }) + "\n");
  npm(["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: app, stdio: "inherit" });

  const sample = JSON.stringify([
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "gone", content: "x" },
  ]);

  // ESM
  writeFileSync(
    join(app, "esm.mjs"),
    `import { validate, repair } from "toolpair";\n` +
      `const v = validate(${sample});\n` +
      `if (v.ok || v.issues[0].rule !== "orphan-result") throw new Error("esm validate");\n` +
      `if (!validate(repair(${sample}).messages).ok) throw new Error("esm repair");\n` +
      `console.log("esm ok");\n`,
  );
  process.stdout.write(execFileSync(process.execPath, ["esm.mjs"], { cwd: app, encoding: "utf8" }));

  // CJS
  writeFileSync(
    join(app, "cjs.cjs"),
    `const { validate, trimToBudget, UnknownFormatError } = require("toolpair");\n` +
      `if (validate(${sample}).ok) throw new Error("cjs validate");\n` +
      `if (!validate(trimToBudget(${sample}, { budget: 100 }).messages).ok) throw new Error("cjs trim");\n` +
      `if (typeof UnknownFormatError !== "function") throw new Error("cjs errors");\n` +
      `console.log("cjs ok");\n`,
  );
  process.stdout.write(execFileSync(process.execPath, ["cjs.cjs"], { cwd: app, encoding: "utf8" }));

  // 타입: ESM(.mts)·CJS(.cts) 사용자 양쪽에서 선언 파일이 풀리는지 tsc 로 확인한다.
  writeFileSync(
    join(app, "types-esm.mts"),
    `import { repair, type Change, type ValidateResult } from "toolpair";\n` +
      `const changes: Change[] = repair([]).changes;\nexport const r: ValidateResult | Change[] = changes;\n`,
  );
  writeFileSync(
    join(app, "types-cjs.cts"),
    `import toolpair = require("toolpair");\n` +
      `const out: toolpair.TrimResult<unknown[]> = toolpair.trimToBudget([] as unknown[], { budget: 1 });\nexport = out;\n`,
  );
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", strict: true, noEmit: true, types: [] },
      files: ["types-esm.mts", "types-cjs.cts"],
    }),
  );
  const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  execFileSync(tsc, ["-p", join(app, "tsconfig.json")], { cwd: app, stdio: "inherit", shell });
  console.log("types ok (esm + cjs consumers)");

  // CLI: `npx toolpair` 와 같은 `npm exec`(설치된 bin 을 쓴다, --no 로 내려받기 금지).
  const version = String(npm(["exec", "--no", "--", "toolpair", "--version"], { cwd: app, encoding: "utf8" })).trim();
  if (version !== pkg.version) throw new Error(`cli version ${version} != ${pkg.version}`);
  console.log(`cli ok (toolpair ${version})`);
} finally {
  // 임시 폴더는 성공·실패와 관계없이 지운다.
  rmSync(work, { recursive: true, force: true });
}
