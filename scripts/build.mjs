// 빌드: esbuild 로 JS(ESM·CJS·CLI)를 만들고, tsc 로 타입 검사와 .d.ts 를 만든다.
// TypeScript 7(네이티브 컴파일러)은 타입 검사·선언 파일만 맡기고 JS 출력은 esbuild 가 한다.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });

// 1) 라이브러리: 브라우저에서도 쓰도록 platform neutral, 같은 소스에서 ESM 과 CJS 두 벌.
const common = {
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  sourcemap: false,
  logLevel: "warning",
};
await build({ ...common, format: "esm", outfile: join(dist, "index.mjs") });
await build({ ...common, format: "cjs", outfile: join(dist, "index.cjs") });

// 2) CLI: Node 용 CJS 한 파일. 버전은 package.json 에서 넣는다.
await build({
  entryPoints: [join(root, "src/cli/main.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(dist, "cli.cjs"),
  banner: { js: "#!/usr/bin/env node" },
  define: { __TOOLPAIR_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
});
chmodSync(join(dist, "cli.cjs"), 0o755);

// 3) 타입 검사 + 선언 파일(dist/types/esm). 실패하면 빌드도 실패한다.
const tscBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const tsc = spawnSync(tscBin, ["-p", join(root, "tsconfig.json")], { stdio: "inherit", shell: process.platform === "win32" });
if (tsc.status !== 0) {
  console.error("tsc failed");
  process.exit(tsc.status ?? 1);
}
// cli 선언은 공개 API 가 아니므로 지운다.
rmSync(join(dist, "types/esm/cli"), { recursive: true, force: true });

// 4) require 용 선언 사본. 폴더별 package.json 의 type 으로 ESM/CJS 해석을 나눈다.
cpSync(join(dist, "types/esm"), join(dist, "types/cjs"), { recursive: true });
mkdirSync(join(dist, "types/esm"), { recursive: true });
writeFileSync(join(dist, "types/esm/package.json"), JSON.stringify({ type: "module" }) + "\n");
writeFileSync(join(dist, "types/cjs/package.json"), JSON.stringify({ type: "commonjs" }) + "\n");

// 진행 문구는 표준 오류로 보낸다. 이 스크립트는 prepare 로도 돌고, npm 10 은 `npm pack --json` 중에도
// prepare 를 돌려 그 표준 출력을 JSON 결과에 섞기 때문이다(0.1.2 CI 실패 원인).
console.error(`built toolpair ${pkg.version}: dist/index.mjs dist/index.cjs dist/cli.cjs dist/types/{esm,cjs}`);
