import { readFileSync } from "node:fs";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

const pagePkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
	version: string;
};
const pageVersion = process.env.BN_ASTRBOT_PAGE_VERSION || pagePkg.version;

// plugins 那句 `as PluginOption[]` 去不得。hoisted 布局下顶层 vite 槽被 koishi 的
// vite 5 占着,两个插件各自嵌套一份 Vite+ core 副本 —— 内容字节相同、路径不同,TS 就
// 当成两个身份,只能走结构比对并撑爆递归上限(TS2321 Excessive stack depth)。断言给了
// 目标类型,这段深比对就不做了。两个类型确实是兼容的(Plugin[] 本就是合法的
// PluginOption),所以这不是在盖住真错误。
// 注意只有断言有效:写成 `const plugins: PluginOption[] = [...]` 照样炸,报错只是挪到
// 那一行 —— 实测过,别改成那种「更干净」的写法。
// 这个错 `vp run typecheck` 抓不到(三个前端的 tsconfig 都只 include src),但**编辑器
// 会报**,所以必须在源码里治。scripts/vite-alias.test.mjs 钉住「每个前端的 vite 都是
// 同一份 core」那条不变量。
export default defineConfig({
	base: "./",
	define: {
		__ASTRBOT_PAGE_VERSION__: JSON.stringify(pageVersion),
	},
	plugins: [react(), tailwind()] as PluginOption[],
	build: {
		outDir: "../core/pages/dashboard",
		emptyOutDir: true,
		assetsDir: "assets",
		// 稳定文件名(不带 content-hash):产物是 checked-in 的,hash 命名会让每次重建变成
		// 删旧+加新的 git churn、跨分支合并还堆陈旧资产。AstrBot 经短时 asset token 做 cache-bust,
		// 不依赖文件名 hash,故稳定名安全。
		rollupOptions: {
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
	server: {
		port: 5174,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:8787",
				configure(proxy) {
					proxy.on("error", (err, _req, res) => {
						if ("writeHead" in res && !res.headersSent) {
							res.writeHead(503, { "content-type": "application/json" });
							res.end(
								JSON.stringify({
									error: "sidecar_unreachable",
									message: `AstrBot sidecar (127.0.0.1:8787) 未启动: ${err.message}`,
								}),
							);
						}
					});
				},
			},
		},
	},
});
