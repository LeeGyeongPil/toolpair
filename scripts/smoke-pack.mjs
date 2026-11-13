// 패키징 점검: npm pack 으로 만든 tarball 을 임시 폴더에 설치해
// ESM import · CJS require · npx toolpair --version 이 실제로 되는지 확인한다.
// 성공하면 "esm ok", "cjs ok", "cli ok" 를 출력하고 종료 코드 0.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const shell = process.platform === "win32";

// 런타임 의존성 0 이어야 한다.
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  console.error(`dependencies must be empty, got ${JSON.stringify(pkg.dependencies)}`);
  process.exit(1);
}
console.log("deps ok (no runtime dependencies)");

const work = mkdtempSync(join(tmpdir(), "toolpair-pack-"));
try {
  // --ignore-scripts: 이미 빌드한 dist 를 그대로 싼다(npm run build 를 먼저 실행).
  const packed = execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", work, "--json"], {
    cwd: root,
    encoding: "utf8",
    shell,
  });
  const info = JSON.parse(packed)[0];
  const files = info.files.map((f) => f.path);
  for (const must of ["dist/index.mjs", "dist/index.cjs", "dist/cli.cjs", "dist/types/esm/index.d.ts", "dist/types/cjs/index.d.ts", "package.json"]) {
    if (!files.includes(must)) throw new Error(`tarball is missing ${must}`);
  }
  const tarball = join(work, info.filename);

  // 빈 프로젝트에 tarball 만 설치한다(의존성이 없으니 네트워크가 필요 없다).
  const app = join(work, "app");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(app)})`]);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true }) + "\n");
  execFileSync(npm, ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
    cwd: app,
    stdio: "inherit",
    shell,
  });

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

  // CLI (npx 는 설치된 bin 을 쓴다, --no-install 로 내려받기 금지)
  const version = execFileSync(npx, ["--no-install", "toolpair", "--version"], { cwd: app, encoding: "utf8", shell }).trim();
  if (version !== pkg.version) throw new Error(`cli version ${version} != ${pkg.version}`);
  console.log(`cli ok (toolpair ${version})`);
} finally {
  // 임시 폴더는 성공·실패와 관계없이 지운다.
  rmSync(work, { recursive: true, force: true });
}
