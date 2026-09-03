import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingServerBundleFilesIn } from "./server-bundle-assets.mjs";

// 把独立端 server 单文件 bundle(apps/server/dist,由 `build:bundle` 产出)补齐为
// 可独立运行的目录:bundle 内联了全部 JS 依赖,但**运行时按路径读取**的资产不进
// bundle,必须搬到产物旁边(与 build-astrbot-sidecar.mjs 同源的三件 + server 特有
// 两件)。本脚本只做纯复制、不 spawn 任何构建命令 —— Docker builder 里没有全局 vp,
// 构建由调用方负责(本地 `vp run -F @bilibili-notify/server build:bundle`,Docker 里
// `pnpm --filter @bilibili-notify/server run build:bundle`,vp 从根 devDependency 的
// node_modules/.bin 解析)。
//
// - xhr-sync-worker.js:jsdom 同步 XHR worker,运行时按文件路径加载。
// - jieba_rs_wasm_bg.wasm:jieba-wasm 的 wasm 本体,readFileSync(__dirname) 加载,
//   bundle 后 __dirname 指向 dist/。
// - static/*:词云模板,image 包运行时 readFileSync(resolve(__dirname, "static/*.js"))。
//   用 monorepo 源路径(始终存在、与 lib/static 内容一致),原因同 sidecar 脚本。
// - bn.config.example.yaml:first-boot 配置样例,镜像内与 bundle 平级。
// - package.json:resolveAppVersion 从 index.mjs 往上找最近的这一份展示独立端版本
//   (发布 workflow 按 tag 临时同步 version 后再构建)。必须与 bundle 平级 —— 它读的
//   是**载荷自己**的版本,不是进程 cwd 的。
//
// 装配完按 scripts/server-bundle-assets.mjs 的清单自检:那份清单是升级载荷与桌面
// 资源两处把关共用的,这里少搬一个,下游才拦得住。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const distDir = resolve(repoRoot, "apps/server/dist");
// 从**声明了这些依赖的包**出发解析,而不是从仓库根:pnpm 默认(isolated)布局下根
// node_modules 只有根自己声明的东西,jsdom / jieba-wasm 都不在,从根解析就是幻影依赖。
const requireFromImage = createRequire(resolve(repoRoot, "packages/image/package.json"));
const requireFromLive = createRequire(resolve(repoRoot, "packages/live/package.json"));
const jsdomXhrSyncWorker = requireFromImage.resolve(
	"jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js",
);
// jsdom 30 起模块加载即 readFileSync 默认样式表;bundle 后 __dirname 相对路径逃出
// 产物目录,靠 patches/jsdom.patch 的 fallback 读 bundle 旁的这份拷贝。
const jsdomDefaultStylesheet = requireFromImage.resolve(
	"jsdom/lib/jsdom/browser/default-stylesheet.css",
);
const jiebaWasm = resolve(
	dirname(requireFromLive.resolve("jieba-wasm/node")),
	"jieba_rs_wasm_bg.wasm",
);
const imageStaticDir = resolve(repoRoot, "packages/image/src/static");

await cp(imageStaticDir, resolve(distDir, "static"), { recursive: true });
await copyFile(jsdomXhrSyncWorker, resolve(distDir, "xhr-sync-worker.js"));
await copyFile(jsdomDefaultStylesheet, resolve(distDir, "default-stylesheet.css"));
await copyFile(jiebaWasm, resolve(distDir, "jieba_rs_wasm_bg.wasm"));
await copyFile(
	resolve(repoRoot, "apps/server/bn.config.example.yaml"),
	resolve(distDir, "bn.config.example.yaml"),
);
// manifest 只保元数据:deps 已内联进 bundle,照抄源 manifest 会把 workspace 的
// catalog: 占位一起带走(npm 不可解析,对自包含产物也是误导)。
const serverPkg = JSON.parse(await readFile(resolve(repoRoot, "apps/server/package.json"), "utf8"));
const { name, version, type, engines } = serverPkg;
await writeFile(
	resolve(distDir, "package.json"),
	`${JSON.stringify({ name, version, type, engines, private: true }, null, "\t")}\n`,
);

const missing = await missingServerBundleFilesIn(distDir);
if (missing.length > 0) {
	throw new Error(`server bundle 装配不完整,缺 ${missing.join(", ")}:${distDir}`);
}
