import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "src");
// 换桩表写死两项目录(⛔ 不用 `**/devtools/**` 通配:通配会把别处恰好叫 devtools 的目录也换掉)。
const DEVTOOLS_DIRS = [
	{ dir: resolve(SRC, "devtools") + sep, stub: resolve(SRC, "devtools", "stub.ts") },
	{
		dir: resolve(SRC, "bilibili", "devtools") + sep,
		stub: resolve(SRC, "bilibili", "devtools", "stub.ts"),
	},
];

/**
 * devtools 只活在源码里。**任何**构建(lib 与 bundle 都算)把从 devtools 目录外指进去的
 * import 解析到那个目录自己的空桩,整棵树随之从产物里消失 —— 不是「挂着但门关着」,是根本
 * 没有这段代码。运行期那道门(`devtools/index.ts`)还在,那是给 tsx 直跑源码时用的。
 *
 * 两项目录:核心的 `src/devtools/` 与 B 站的 `src/bilibili/devtools/`,各有各的桩(签名不同)。
 * 「importer 在 devtools 内」要**两个目录都算**:`bilibili/devtools/*` 引用核心
 * `devtools/registry.js` 这类内部引用不能被误换成桩,否则类型与 `DevParamError` 一起没了。
 *
 * 按**解析后的路径**判、不按写法判:`./devtools/index.js` 也好、日后谁写个别的相对路径也好,
 * 只要落进这两个目录就换。构建后 scripts/check-no-devtools.mjs 会再 grep 一遍产物。
 */
const stubDevtools = {
	name: "bn:stub-devtools",
	resolveId(source: string, importer: string | undefined) {
		if (!importer || DEVTOOLS_DIRS.some(({ dir }) => importer.startsWith(dir))) return null;
		if (!source.startsWith(".")) return null;
		const target = resolve(dirname(importer), source);
		return DEVTOOLS_DIRS.find(({ dir }) => target.startsWith(dir))?.stub ?? null;
	},
};

// BN_SERVER_BUNDLE=1(package.json 的 build:bundle 经 cross-env 设,Windows 的桌面构建也走它)→ 自包含 bundle(入口 + hash 分块),输出 dist/:全部直接依赖内联(vp pack
// 默认只内联间接依赖、外置直接依赖),装外旁边没有 node_modules 也能跑。Docker 镜像、
// 桌面安装包、应用内升级载荷装的都是这一份(scripts/server-bundle-assets.mjs 是它
// 必须带齐的文件清单)。
// 默认(不设 env)→ 外置 lib 构建,给裸跑(`node lib/index.mjs`)与 dev 用。
// 运行时按路径读取的资产(jieba wasm / image static)不进 bundle,
// 由 scripts/assemble-server-bundle.mjs 搬到 dist/ 旁边。
const bundle = process.env.BN_SERVER_BUNDLE === "1";

export default defineConfig({
	pack: {
		// 两种模式都出一个 `boot` 入口 —— 容器与桌面壳跑的都是 bundle 那份 boot.mjs
		// (桌面把 dist 摆在 lib/ 下),裸跑用 lib/boot.mjs。它只牵 node 内建 + 选版那
		// 一小块,好在加载服务端**之前**决定跑哪份载荷(见 src/boot.ts 顶上那段)。
		entry: ["src/index.ts", "src/boot.ts"],
		format: ["esm"],
		dts: false,
		clean: true,
		outDir: bundle ? "dist" : "lib",
		platform: "node",
		target: bundle ? "node24" : "node20",
		// bundle 模式关 sourcemap:内联全依赖后 map 体积数十 MB,镜像不值得背。
		sourcemap: !bundle,
		plugins: [stubDevtools],
		...(bundle
			? {
					shims: true,
					deps: {
						alwaysBundle: [
							/^@bilibili-notify\//,
							/^@hono\//,
							/^hono(\/|$)/,
							// B 站那几样(3a-24 起是服务端的直接依赖,不写进来就会被外置,载荷里没有 node_modules)。
							// jieba-wasm 的 .wasm 由装配脚本随载荷拷(scripts/server-bundle-assets.mjs)。
							/^jieba-wasm(\/|$)/,
							/^luxon(\/|$)/,
							/^md5(\/|$)/,
							/^cron(\/|$)/,
							/^css-tree(\/|$)/,
							/^fflate(\/|$)/,
							// 卡片皮肤自定义块的 HTML 清洗器(parse5 + 它唯一的依赖 entities):纯 JS、
							// dist 里无 __dirname / require.resolve / readFileSync,内联安全(2026-09-13 核过)。
							/^parse5(\/|$)/,
							/^entities(\/|$)/,
							/^pino(\/|$)/,
							/^pino-pretty(\/|$)/,
							/^protobufjs(\/|$)/,
							/^puppeteer-core(\/|$)/,
							// 纯 JS、无 __dirname 资产读取,内联安全(扫码建 bot 的二维码生成)。
							/^qrcode(\/|$)/,
							/^ws(\/|$)/,
							/^yaml(\/|$)/,
							/^zod(\/|$)/,
						],
						onlyBundle: false,
					},
				}
			: {}),
	},
});
