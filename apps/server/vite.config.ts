import { defineConfig } from "vite-plus";

// BN_SERVER_BUNDLE=1 → 自包含单文件 bundle(Docker 镜像用),输出 dist/:全部直接
// 依赖内联(vp pack 默认只内联间接依赖、外置直接依赖),装外旁边没有 node_modules
// 也能跑。配方对齐 astrbot/sidecar/vite.config.ts(已在 AstrBot 端生产验证)。
// 默认(不设 env)→ 外置 lib 构建,dev / desktop / 测试路径不变。
// 运行时按路径读取的资产(jieba wasm / jsdom xhr worker / image static)不进 bundle,
// 由 scripts/assemble-server-bundle.mjs 搬到 dist/ 旁边。
const bundle = process.env.BN_SERVER_BUNDLE === "1";

export default defineConfig({
	pack: {
		// 两种模式都出一个 `boot` 入口 —— 容器跑 dist/boot.mjs,桌面壳跑 lib/boot.mjs。
		// 它只牵 node 内建 + 选版那一小块,好在加载服务端**之前**决定跑哪份载荷
		// (见 src/boot.ts 顶上那段)。两端共用同一个启动器,才谈得上「一套代码路径」。
		entry: ["src/index.ts", "src/boot.ts"],
		format: ["esm"],
		dts: false,
		clean: true,
		outDir: bundle ? "dist" : "lib",
		platform: "node",
		target: bundle ? "node24" : "node20",
		// bundle 模式关 sourcemap:内联全依赖后 map 体积数十 MB,镜像不值得背。
		sourcemap: !bundle,
		...(bundle
			? {
					shims: true,
					deps: {
						alwaysBundle: [
							/^@bilibili-notify\//,
							/^@hono\//,
							/^hono(\/|$)/,
							/^cron(\/|$)/,
							/^css-tree(\/|$)/,
							/^fflate(\/|$)/,
							/^pino(\/|$)/,
							/^pino-pretty(\/|$)/,
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
