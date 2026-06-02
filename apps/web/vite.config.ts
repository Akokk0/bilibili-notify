import { readFileSync } from "node:fs";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 前端自身版本,注入概览页展示。release workflow 可用 env 覆盖源码占位版本。
const webPkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
	version: string;
};
const webVersion = process.env.BN_STANDALONE_VERSION || webPkg.version;

// 测试走 vitest 默认 node 环境 + 默认 include — 4 个 channel hook 的事件分发已拆
// 成纯 handler 函数,不渲染 React,无需 jsdom。
export default defineConfig({
	// __WEB_VERSION__ 编译期替换为字面量;声明见 src/vite-env.d.ts。
	define: {
		__WEB_VERSION__: JSON.stringify(webVersion),
	},
	plugins: [react(), tailwind()],
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
