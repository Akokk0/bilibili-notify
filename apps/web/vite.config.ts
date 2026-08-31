import { readFileSync } from "node:fs";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

// 前端自身版本,注入概览页展示。release workflow 可用 env 覆盖源码占位版本。
const webPkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
	version: string;
};
const webVersion = process.env.BN_STANDALONE_VERSION || webPkg.version;

// 测试走 vitest 默认 node 环境 + 默认 include — 4 个 channel hook 的事件分发已拆
// 成纯 handler 函数,不渲染 React,无需 jsdom。
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
	// __WEB_VERSION__ 编译期替换为字面量;声明见 src/vite-env.d.ts。
	define: {
		__WEB_VERSION__: JSON.stringify(webVersion),
	},
	plugins: [react(), tailwind()] as PluginOption[],
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:8787",
				// http-proxy's default on ECONNREFUSED is 500 + plain-text "Internal
				// Server Error" — indistinguishable from a real server bug. Shape
				// it into 503 + JSON so the dashboard can render "backend down"
				// instead of "something exploded".
				configure(proxy) {
					proxy.on("error", (err, _req, res) => {
						if ("writeHead" in res && !res.headersSent) {
							res.writeHead(503, { "content-type": "application/json" });
							res.end(
								JSON.stringify({
									error: "backend_unreachable",
									message: `apps/server (127.0.0.1:8787) 未启动: ${err.message}`,
								}),
							);
						}
					});
				},
			},
			"/ws": { target: "ws://127.0.0.1:8787", ws: true },
		},
	},
});
